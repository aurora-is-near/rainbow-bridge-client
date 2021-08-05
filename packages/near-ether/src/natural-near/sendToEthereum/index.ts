import BN from 'bn.js'
import bs58 from 'bs58'
import { ethers } from 'ethers'
import { Account, utils } from 'near-api-js'
import { FinalExecutionOutcome } from 'near-api-js/lib/providers'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { track } from '@near-eth/client'
import { borshifyOutcomeProof, urlParams, nearOnEthSyncHeight, findNearProof } from '@near-eth/utils'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/near-ether/natural-near/sendToEthereum'

const LOCK = 'lock-natural-near-to-e-near'
const AWAIT_FINALITY = 'await-finality-natural-near-to-e-near'
const SYNC = 'sync-natural-near-to-e-near'
const MINT = 'mint-natural-near-to-e-near'

const steps = [
  LOCK,
  AWAIT_FINALITY,
  SYNC,
  MINT
]

export interface TransferDraft extends TransferStatus {
  type: string
  finalityBlockHeights: number[]
  nearOnEthClientBlockHeight: null | number
  mintHashes: string[]
  mintReceipts: ethers.providers.TransactionReceipt[]
  lockHashes: string[]
  lockReceiptBlockHeights: number[]
  lockReceiptIds: string[]
}

export interface Transfer extends TransferDraft, TransactionInfo {
  id: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  sourceTokenName: string
  checkSyncInterval?: number
  nextCheckSyncTimestamp?: Date
  proof?: Uint8Array
}

class TransferError extends Error {}

const transferDraft: TransferDraft = {
  // Attributes common to all transfer types
  // amount,
  completedStep: null,
  // destinationTokenName,
  errors: [],
  // recipient,
  // sender,
  // sourceToken,
  // sourceTokenName,
  // decimals,
  status: status.IN_PROGRESS,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to bridged-nep141-to-erc20 transfers
  finalityBlockHeights: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  mintHashes: [],
  mintReceipts: [],
  lockReceiptBlockHeights: [],
  lockReceiptIds: [],
  lockHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from NEAR`,
      [AWAIT_FINALITY]: 'Confirm in NEAR',
      [SYNC]: 'Confirm in Ethereum. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in Ethereum`
    }),
    statusMessage: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from NEAR'
          case SYNC: return 'Ready to deposit in Ethereum'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Ethereum'
        case LOCK: return 'Confirming transfer'
        case AWAIT_FINALITY: return 'Confirming transfer'
        case SYNC: return 'Depositing in Ethereum'
        case MINT: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Transfer'
        case SYNC: return 'Deposit'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    }
  }
}
/* eslint-enable @typescript-eslint/restrict-template-expressions */

/**
 * Called when status is ACTION_NEEDED or FAILED
 * @param transfer Transfer object to act on.
 */
export async function act (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await lock(transfer)
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await mint(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param transfer Transfer object to check status on.
 */
export async function checkStatus (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await checkLock(transfer)
    case LOCK: return await checkFinality(transfer)
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await checkMint(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a lock tx hash.
 * @param lockTxHash Near tx hash containing the token lock.
 * @param sender Near account sender of lockTxHash.
 * @param params.options Optional arguments.
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 * @param params.options.nativeNEARLockerAddress $NEAR bridge connector address on NEAR.
 * @returns The created transfer object.
 */
export async function recover (
  lockTxHash: string,
  sender: string = 'todo',
  options?: {
    nearAccount?: Account
    nativeNEARLockerAddress?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()

  const decodedTxHash = utils.serialize.base_decode(lockTxHash)
  const lockTx = await nearAccount.connection.provider.txStatus(
    // TODO: when multiple shards, the sender should be known in order to query txStatus
    decodedTxHash, sender
  )
  sender = lockTx.transaction.signer_id

  // @ts-expect-error TODO
  if (lockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Lock transaction pending: ${lockTxHash}`)
  }

  // @ts-expect-error TODO
  if (lockTx.status.Failure) {
    throw new Error(`Lock transaction failed: ${lockTxHash}`)
  }

  // Get lock event information from successValue
  // @ts-expect-error TODO
  const successValue: string = lockTx.status.SuccessValue
  if (!successValue) {
    throw new Error(
      `Invalid lockTx successValue: '${successValue}'
      Full lock transaction: ${JSON.stringify(lockTx)}`
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class LockEvent {
    constructor (args: any) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [LockEvent, {
      kind: 'struct',
      fields: [
        ['flag', 'u8'],
        ['amount', 'u128'],
        ['recipient', [20]]
      ]
    }]
  ])
  const lockEvent = deserializeBorsh(
    SCHEMA, LockEvent, Buffer.from(successValue, 'base64')
  )

  const amount = lockEvent.amount.toString()
  const recipient = '0x' + Buffer.from(lockEvent.recipient).toString('hex')
  const destinationTokenName = 'NEAR'
  const decimals = 24
  const sourceTokenName = 'NEAR'
  const sourceToken = 'NEAR'

  const lockReceipt = await parseLockReceipt(
    lockTx,
    sender,
    options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
    nearAccount
  )

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    sourceToken,
    decimals,

    lockHashes: [lockTxHash],
    lockReceiptBlockHeights: [lockReceipt.blockHeight],
    lockReceiptIds: [lockReceipt.id]
  }

  // Check transfer status
  return await checkSync(transfer)
}

/**
 * Parse the lock receipt id and block height needed to complete
 * the step LOCK
 * @param lockTx
 * @param sender
 * @param nativeNEARLockerAddress
 * @param nearAccount
 */
export async function parseLockReceipt (
  lockTx: FinalExecutionOutcome,
  sender: string,
  nativeNEARLockerAddress: string,
  nearAccount: Account
): Promise<{id: string, blockHeight: number }> {
  const receiptIds = lockTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Lock expects only one receipt, got ${receiptIds.length}.
      Full lock transaction: ${JSON.stringify(lockTx)}`
    )
  }

  // Get receipt information for recording and building lock proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = lockTx.receipts_outcome
    .find(r => r.id === txReceiptId)!
    .outcome
  // @ts-expect-error TODO
  const successReceiptId = successReceiptOutcome.status.SuccessReceiptId
  // @ts-expect-error TODO
  const successReceiptExecutorId = successReceiptOutcome.executor_id

  let lockReceiptId: string

  // Check if this tx was made from a 2fa
  switch (successReceiptExecutorId) {
    case sender: {
      // `confirm` transaction executed on 2fa account
      const lockReceiptOutcome = lockTx.receipts_outcome
        .find(r => r.id === successReceiptId)!
        .outcome

      lockReceiptId = successReceiptId

      // @ts-expect-error TODO
      const lockReceiptExecutorId: string = lockReceiptOutcome.executor_id
      // Expect this receipt to be the 2fa FunctionCall
      if (lockReceiptExecutorId !== nativeNEARLockerAddress) {
        throw new TransferError(
          `Unexpected receipt outcome format in 2fa transaction.
          Expected nativeNEARLockerAddress '${nativeNEARLockerAddress}', got '${lockReceiptExecutorId}'
          Full withdrawal transaction: ${JSON.stringify(lockTx)}`
        )
      }
      break
    }
    case nativeNEARLockerAddress:
      // `lock` called directly, successReceiptId is already correct, nothing to do
      lockReceiptId = txReceiptId!
      break
    default:
      throw new TransferError(
        `Unexpected receipt outcome format.
        Full withdrawal transaction: ${JSON.stringify(lockTx)}`
      )
  }

  const txReceiptBlockHash = lockTx.receipts_outcome
    .find(r => r.id === lockReceiptId)!
    // @ts-expect-error TODO
    .block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: lockReceiptId, blockHeight: receiptBlockHeight }
}

/**
 * Initiate a transfer from NEAR to Ethereum by locking $NEAR tokens.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Ethereum address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.sender Sender of tokens (defaults to the connected NEAR wallet address).
 * @param params.options.nativeNEARLockerAddress $NEAR bridge connector address on NEAR.
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      sender?: string
      nativeNEARLockerAddress?: string
      nearAccount?: Account
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const destinationTokenName = 'NEAR'
  const decimals = 24
  const sourceTokenName = 'NEAR'
  const sourceToken = 'NEAR'
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const sender = options.sender ?? nearAccount.accountId

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    sourceToken,
    decimals
  }
  // Prevent checkStatus from creating failed transfer when called between track and lock
  urlParams.set({ locking: 'processing' })

  transfer = await track(transfer) as Transfer

  await lock(transfer, options)
  return transfer
}

/**
 * Lock native NEAR to migrate to Ethereum.
 */
export async function lock (
  transfer: Transfer,
  options?: {
    nativeNEARLockerAddress?: string
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()

  urlParams.set({ locking: transfer.id })

  setTimeout(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    nearAccount.functionCall({
      contractId: options!.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
      methodName: 'migrate_to_ethereum',
      args: {
        eth_recipient: transfer.recipient.replace('0x', '')
      },
      gas: new BN('10' + '0'.repeat(12)), // 10TGas
      attachedDeposit: new BN(transfer.amount)
    })
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted lock transaction
 * checkLock is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkLock can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 */
export async function checkLock (
  transfer: Transfer,
  options?: {
    nativeNEARLockerAddress?: string
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const id = urlParams.get('locking') as string | null
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes') as string | null
  const errorCode = urlParams.get('errorCode') as string | null
  if (!id && !txHash) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A lock transaction was initiated but could not be verified.
      If a transaction was sent from your account, please make sure to 'Restore transfer' and finalize it.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!id || id === 'processing') {
    console.log('Waiting for Near wallet redirect to sign lock')
    return transfer
  }
  if (id !== transfer.id) {
    // Another lock transaction cannot be in progress, ie if checkLock is called on
    // an in process lock then the transfer ids must be equal or the url callback is invalid.
    urlParams.clear()
    const newError = `Couldn't determine transaction outcome.
      Got transfer id '${id} in URL, expected '${transfer.id}`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (errorCode) {
    // If errorCode, then the redirect succeded but the tx was rejected/failed
    // so clear url params
    urlParams.clear()
    const newError = 'Error from wallet: ' + errorCode
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!txHash) {
    // If checkLock is called before lock sig wallet redirect
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Lock tx hash not received: pending redirect or wallet error'
    console.log(newError)
    return transfer
  }
  if (txHash.includes(',')) {
    urlParams.clear()
    const newError = 'Error from wallet: expected single txHash, got: ' + txHash
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }

  const decodedTxHash = utils.serialize.base_decode(txHash)
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const lockTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a lock
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  // @ts-expect-error : wallet returns errorCode
  if (lockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error : wallet returns errorCode
  if (lockTx.status.Failure) {
    urlParams.clear()
    const error = `NEAR transaction failed: ${txHash}`
    console.error(error)
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED,
      lockHashes: [...transfer.lockHashes, txHash]
    }
  }

  let lockReceipt
  try {
    lockReceipt = await parseLockReceipt(
      lockTx,
      transfer.sender,
      options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
      nearAccount
    )
  } catch (e) {
    if (e instanceof TransferError) {
      urlParams.clear()
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED,
        lockHashes: [...transfer.lockHashes, txHash]
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkLock will be called again.
    throw e
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    lockReceiptIds: [...transfer.lockReceiptIds, lockReceipt.id],
    lockReceiptBlockHeights: [...transfer.lockReceiptBlockHeights, lockReceipt.blockHeight],
    lockHashes: [...transfer.lockHashes, txHash]
  }
}

/**
 * Wait for a final block with a strictly greater height than lockTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 */
export async function checkFinality (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()

  const lockReceiptBlockHeight = last(transfer.lockReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearAccount.connection.provider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= lockReceiptBlockHeight) {
    return transfer
  }

  return {
    ...transfer,
    completedStep: AWAIT_FINALITY,
    status: status.IN_PROGRESS,
    finalityBlockHeights: [...transfer.finalityBlockHeights, latestFinalizedBlock]
  }
}

/**
 * Wait for the block with the given receipt/transaction in Near2EthClient, and
 * get the outcome proof only use block merkle root that we know is available
 * on the Near2EthClient.
 */
export async function checkSync (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    eNEARAddress?: string
    sendToEthereumSyncInterval?: number
    ethChainId?: number
    nearAccount?: Account
    ethClientAddress?: string
    ethClientAbi?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  if (!transfer.checkSyncInterval) {
    // checkSync every 60s: reasonable value to detect transfer is ready to be finalized
    transfer = {
      ...transfer,
      checkSyncInterval: options.sendToEthereumSyncInterval ?? bridgeParams.sendToEthereumSyncInterval
    }
  }
  if (transfer.nextCheckSyncTimestamp && new Date() < new Date(transfer.nextCheckSyncTimestamp)) {
    return transfer
  }
  const ethChainId = (await provider.getNetwork()).chainId
  const expectedChainId = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    console.log(
      'Wrong eth network for checkSync, expected: %s, got: %s',
      expectedChainId, ethChainId
    )
    return transfer
  }

  const lockReceiptBlockHeight = last(transfer.lockReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(
    provider,
    options.ethClientAddress ?? bridgeParams.ethClientAddress,
    options.ethClientAbi ?? bridgeParams.ethClientAbi
  )
  let proof

  const nearAccount = options.nearAccount ?? await getNearAccount()
  if (nearOnEthClientBlockHeight > lockReceiptBlockHeight) {
    proof = await findNearProof(
      last(transfer.lockReceiptIds),
      transfer.sender,
      nearOnEthClientBlockHeight,
      nearAccount,
      provider,
      options.ethClientAddress ?? bridgeParams.ethClientAddress,
      options.ethClientAbi ?? bridgeParams.ethClientAbi
    )
    if (await proofAlreadyUsed(provider, proof, options.eNEARAddress ?? bridgeParams.eNEARAddress)) {
      // TODO find the unlockTxHash
      return {
        ...transfer,
        completedStep: MINT,
        nearOnEthClientBlockHeight,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Mint proof already used.']
      }
    }
  } else {
    return {
      ...transfer,
      nextCheckSyncTimestamp: new Date(Date.now() + transfer.checkSyncInterval!),
      nearOnEthClientBlockHeight,
      status: status.IN_PROGRESS
    }
  }

  return {
    ...transfer,
    completedStep: SYNC,
    nearOnEthClientBlockHeight,
    status: status.ACTION_NEEDED,
    proof // used when checkSync() is called by unlock()
  }
}

/**
 * Check if a NEAR outcome receipt_id has already been used to finalize a transfer to Ethereum.
 */
export async function proofAlreadyUsed (provider: ethers.providers.Provider, proof: any, eNEARAddress: string): Promise<boolean> {
  const usedProofsKey: string = bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex')
  // The usedProofs_ mapping is the 9th variable defined in the contract storage.
  const usedProofsMappingPosition = '0'.repeat(63) + '8'
  const storageIndex = ethers.utils.keccak256('0x' + usedProofsKey + usedProofsMappingPosition)
  // eth_getStorageAt docs: https://eth.wiki/json-rpc/API
  const proofIsUsed = await provider.getStorageAt(eNEARAddress, storageIndex)
  return Number(proofIsUsed) === 1
}

/**
 * Mint eNEAR tokens,
 * passing the proof that the tokens were locked in the corresponding
 * NEAR BridgeToken contract.
 */
export async function mint (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    ethChainId?: number
    eNEARAddress?: string
    eNEARAbi?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  // Build lock proof
  transfer = await checkSync(transfer)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  const borshProof = borshifyOutcomeProof(proof)

  const eNEAR = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingMintTx = await eNEAR.finaliseNearToEthTransfer(borshProof, transfer.nearOnEthClientBlockHeight)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingMintTx.from,
      to: pendingMintTx.to,
      safeReorgHeight,
      data: pendingMintTx.data,
      nonce: pendingMintTx.nonce
    },
    mintHashes: [...transfer.mintHashes, pendingMintTx.hash]
  }
}

export async function checkMint (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    ethChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const ethChainId = (await provider.getNetwork()).chainId
  const expectedChainId = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    console.log(
      'Wrong eth network for checkMint, expected: %s, got: %s',
      expectedChainId, ethChainId
    )
    return transfer
  }

  const mintHash = last(transfer.mintHashes)
  let mintReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(mintHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!mintReceipt) {
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        data: transfer.ethCache.data
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      mintReceipt = await provider.getTransactionReceipt(foundTx.hash)
    } catch (error) {
      console.error(error)
      if (error instanceof TxValidationError) {
        return {
          ...transfer,
          errors: [...transfer.errors, error.message],
          status: status.FAILED
        }
      }
      throw error
    }
  }

  if (!mintReceipt) return transfer

  if (!mintReceipt.status) {
    const error = `Transaction failed: ${mintReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      mintReceipts: [...transfer.mintReceipts, mintReceipt]
    }
  }

  if (mintReceipt.transactionHash !== mintHash) {
    // Record the replacement tx mintHash
    return {
      ...transfer,
      status: status.COMPLETE,
      completedStep: MINT,
      mintHashes: [...transfer.mintHashes, mintReceipt.transactionHash],
      mintReceipts: [...transfer.mintReceipts, mintReceipt]
    }
  }

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: MINT,
    mintReceipts: [...transfer.mintReceipts, mintReceipt]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
