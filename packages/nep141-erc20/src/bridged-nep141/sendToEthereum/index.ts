import BN from 'bn.js'
import bs58 from 'bs58'
import { ethers } from 'ethers'
import { ConnectedWalletAccount, utils } from 'near-api-js'
import { FinalExecutionOutcome } from 'near-api-js/lib/providers'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { track } from '@near-eth/client'
import { borshifyOutcomeProof, urlParams, nearOnEthSyncHeight, findNearProof } from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import getNep141Address from '../getAddress'
import { getDecimals, getSymbol } from '../../natural-erc20/getMetadata'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/nep141-erc20/bridged-nep141/sendToEthereum'

const WITHDRAW = 'withdraw-bridged-nep141-to-erc20'
const AWAIT_FINALITY = 'await-finality-bridged-nep141-to-erc20'
const SYNC = 'sync-bridged-nep141-to-erc20'
const UNLOCK = 'unlock-bridged-nep141-to-erc20'

const steps = [
  WITHDRAW,
  AWAIT_FINALITY,
  SYNC,
  UNLOCK
]

export interface TransferDraft extends TransferStatus {
  type: string
  finalityBlockHeights: number[]
  nearOnEthClientBlockHeight: null | number
  unlockHashes: string[]
  unlockReceipts: ethers.providers.TransactionReceipt[]
  withdrawHashes: string[]
  withdrawReceiptBlockHeights: number[]
  withdrawReceiptIds: string[]
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
  unlockHashes: [],
  unlockReceipts: [],
  withdrawReceiptBlockHeights: [],
  withdrawReceiptIds: [],
  withdrawHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [WITHDRAW]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from NEAR`,
      [AWAIT_FINALITY]: 'Confirm in NEAR',
      [SYNC]: 'Confirm in Ethereum. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in Ethereum`
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
        case null: return 'Transfering from NEAR'
        case WITHDRAW: return 'Confirming transfer'
        case AWAIT_FINALITY: return 'Confirming transfer'
        case SYNC: return 'Depositing in Ethereum'
        case UNLOCK: return 'Transfer complete'
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
 * @param {*} transfer
 */
export async function act (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await withdraw(transfer)
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await unlock(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export async function checkStatus (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await checkWithdraw(transfer)
    case WITHDRAW: return await checkFinality(transfer)
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await checkUnlock(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a withdraw tx hash
 * Track a new transfer at the completedStep = WITHDRAW so that it can be unlocked
 * @param {string} withdrawTxHash Near tx hash containing the token withdrawal
 * @param {string} sender Near account sender of withdrawTxHash
 */
export async function recover (
  withdrawTxHash: string,
  sender: string = 'todo',
  options?: {
    nearAccount?: ConnectedWalletAccount
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const decodedTxHash = utils.serialize.base_decode(withdrawTxHash)
  const withdrawTx = await nearAccount.connection.provider.txStatus(
    // TODO: when multiple shards, the sender should be known in order to query txStatus
    decodedTxHash, sender
  )
  sender = withdrawTx.transaction.signer_id

  // @ts-expect-error TODO
  if (withdrawTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Withdraw transaction pending: ${withdrawTxHash}`)
  }

  // @ts-expect-error TODO
  if (withdrawTx.status.Failure) {
    throw new Error(`Withdraw transaction failed: ${withdrawTxHash}`)
  }

  // Get withdraw event information from successValue
  // @ts-expect-error TODO
  const successValue: string = withdrawTx.status.SuccessValue
  if (!successValue) {
    throw new Error(
      `Invalid withdrawTx successValue: '${successValue}'
      Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class WithdrawEvent {
    constructor (args: any) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [WithdrawEvent, {
      kind: 'struct',
      fields: [
        ['flag', 'u8'],
        ['amount', 'u128'],
        ['token', [20]],
        ['recipient', [20]]
      ]
    }]
  ])
  const withdrawEvent = deserializeBorsh(
    SCHEMA, WithdrawEvent, Buffer.from(successValue, 'base64')
  )

  const amount = withdrawEvent.amount.toString()
  const recipient = '0x' + Buffer.from(withdrawEvent.recipient).toString('hex')
  const erc20Address = '0x' + Buffer.from(withdrawEvent.token).toString('hex')
  const destinationTokenName = await getSymbol({ erc20Address })
  const decimals = await getDecimals({ erc20Address })
  const sourceTokenName = 'n' + destinationTokenName
  const sourceToken = getNep141Address({ erc20Address })

  const withdrawReceipt = await parseWithdrawReceipt(withdrawTx, sender, sourceToken)

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    amount,
    completedStep: WITHDRAW,
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    decimals,

    withdrawReceiptBlockHeights: [withdrawReceipt.blockHeight],
    withdrawReceiptIds: [withdrawReceipt.id]
  }

  // Check transfer status
  return await checkSync(transfer)
}

/**
 * Parse the withdraw receipt id and block height needed to complete
 * the step WITHDRAW
 * @param {*} withdrawTx
 * @param {string} sender
 * @param {string} sourceToken
 */
async function parseWithdrawReceipt (
  withdrawTx: FinalExecutionOutcome,
  sender: string,
  sourceToken: string
): Promise<{id: string, blockHeight: number }> {
  const nearAccount = await getNearAccount()
  const receiptIds = withdrawTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Withdrawal expects only one receipt, got ${receiptIds.length}.
      Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
    )
  }

  // Get receipt information for recording and building withdraw proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = withdrawTx.receipts_outcome
    .find(r => r.id === txReceiptId)!
    .outcome
  // @ts-expect-error TODO
  const successReceiptId = successReceiptOutcome.status.SuccessReceiptId
  // @ts-expect-error TODO
  const successReceiptExecutorId = successReceiptOutcome.executor_id

  let withdrawReceiptId: string

  // Check if this tx was made from a 2fa
  switch (successReceiptExecutorId) {
    case sender: {
      // `confirm` transaction executed on 2fa account
      const withdrawReceiptOutcome = withdrawTx.receipts_outcome
        .find(r => r.id === successReceiptId)!
        .outcome

      // @ts-expect-error TODO
      withdrawReceiptId = withdrawReceiptOutcome.status.SuccessReceiptId

      // @ts-expect-error TODO
      const withdrawReceiptExecutorId: string = withdrawReceiptOutcome.executor_id
      // Expect this receipt to be the 2fa FunctionCall
      if (withdrawReceiptExecutorId !== sourceToken) {
        throw new TransferError(
          `Unexpected receipt outcome format in 2fa transaction.
          Expected sourceToken '${sourceToken}', got '${withdrawReceiptExecutorId}'
          Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
        )
      }
      break
    }
    case sourceToken:
      // `withdraw` called directly, successReceiptId is already correct, nothing to do
      withdrawReceiptId = successReceiptId
      break
    default:
      throw new TransferError(
        `Unexpected receipt outcome format.
        Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
      )
  }

  const txReceiptBlockHash = withdrawTx.receipts_outcome
    .find(r => r.id === withdrawReceiptId)!
    // @ts-expect-error TODO
    .block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: withdrawReceiptId, blockHeight: receiptBlockHeight }
}

export async function initiate (
  { erc20Address, amount, recipient, sender, options }: {
    erc20Address: string
    amount: string | ethers.BigNumber
    recipient: string
    sender: string
    options?: {
      symbol?: string
      decimals?: number
      // sender?: string // TODO get from nearAccount to make optional
      nearAccount?: ConnectedWalletAccount
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const destinationTokenName = options.symbol ?? await getSymbol({ erc20Address })
  const decimals = options.decimals ?? await getDecimals({ erc20Address })
  const sourceTokenName = 'n' + destinationTokenName
  const sourceToken = getNep141Address({ erc20Address })

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    decimals
  }

  // Prevent checkStatus from creating failed transfer when called between track and withdraw
  urlParams.set({ withdrawing: 'processing' })

  transfer = await track(transfer) as Transfer

  await withdraw(transfer, options)
  return transfer
}

async function withdraw (
  transfer: Transfer,
  options?: {
    nearAccount?: ConnectedWalletAccount
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  // Set url params before this withdraw() returns, otherwise there is a chance that checkWithdraw() is called before
  // the wallet redirect and the transfer errors because the status is IN_PROGRESS but the expected
  // url param is not there
  urlParams.set({ withdrawing: transfer.id })

  // Calling `BridgeToken.withdraw` causes a redirect to NEAR Wallet.
  //
  // This adds some info about the current transaction to the URL params, then
  // returns to mark the transfer as in-progress, and THEN executes the
  // `withdraw` function.
  //
  // Since this happens very quickly in human time, a user will not have time
  // to start two `deposit` calls at the same time, and the `checkWithdraw` will be
  // able to correctly identify the transfer and see if the transaction
  // succeeded.
  setTimeout(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    nearAccount.functionCall(
      transfer.sourceToken,
      'withdraw',
      {
        amount: String(transfer.amount),
        recipient: transfer.recipient.replace('0x', '')
      },
      // 100Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      new BN('100' + '0'.repeat(12)),
      new BN('1')
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted withdraw transaction
 * checkWithdraw is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkWithdraw can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkWithdraw (
  transfer: Transfer,
  options?: {
    nearAccount?: ConnectedWalletAccount
  }
): Promise<Transfer> {
  options = options ?? {}
  const id = urlParams.get('withdrawing') as string | null
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes') as string | null
  const errorCode = urlParams.get('errorCode') as string | null
  if (!id && !txHash) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A withdraw transaction was initiated but could not be verified.
      If a transaction was sent from your account, please make sure to 'Restore transfer' and finalize it.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!id || id === 'processing') {
    console.log('Waiting for Near wallet redirect to sign withdraw')
    return transfer
  }
  if (id !== transfer.id) {
    // Another withdraw transaction cannot be in progress, ie if checkWithdraw is called on
    // an in process withdraw then the transfer ids must be equal or the url callback is invalid.
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
    // If checkWithdraw is called before withdraw sig wallet redirect
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Withdraw tx hash not received: pending redirect or wallet error'
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
  const withdrawTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a withdraw
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  // @ts-expect-error : wallet returns errorCode
  if (withdrawTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error : wallet returns errorCode
  if (withdrawTx.status.Failure) {
    urlParams.clear()
    const error = `NEAR transaction failed: ${txHash}`
    console.error(error)
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED,
      withdrawHashes: [...transfer.withdrawHashes, txHash]
    }
  }

  let withdrawReceipt
  try {
    withdrawReceipt = await parseWithdrawReceipt(withdrawTx, transfer.sender, transfer.sourceToken)
  } catch (e) {
    if (e instanceof TransferError) {
      urlParams.clear()
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED,
        withdrawHashes: [...transfer.withdrawHashes, txHash]
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkWithdraw will be called again.
    throw e
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: WITHDRAW,
    withdrawReceiptIds: [...transfer.withdrawReceiptIds, withdrawReceipt.id],
    withdrawReceiptBlockHeights: [...transfer.withdrawReceiptBlockHeights, withdrawReceipt.blockHeight],
    withdrawHashes: [...transfer.withdrawHashes, txHash]
  }
}

/**
 * Wait for a final block with a strictly greater height than withdrawTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 * @param {*} transfer
 */
async function checkFinality (
  transfer: Transfer,
  options?: {
    nearAccount?: ConnectedWalletAccount
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()

  const withdrawReceiptBlockHeight = last(transfer.withdrawReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearAccount.connection.provider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= withdrawReceiptBlockHeight) {
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
 * @param {*} transfer
 */
async function checkSync (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    erc20LockerAddress?: string
    sendToEthereumSyncInterval?: number
    ethChainId?: number
    nearAccount?: ConnectedWalletAccount
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

  const withdrawBlockHeight = last(transfer.withdrawReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(provider)
  let proof

  const nearAccount = options.nearAccount ?? await getNearAccount()
  if (nearOnEthClientBlockHeight > withdrawBlockHeight) {
    proof = await findNearProof(
      last(transfer.withdrawReceiptIds),
      transfer.sender,
      nearOnEthClientBlockHeight,
      nearAccount,
      provider
    )
    if (await proofAlreadyUsed(provider, proof, options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress)) {
      // TODO find the unlockTxHash
      return {
        ...transfer,
        completedStep: UNLOCK,
        nearOnEthClientBlockHeight,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Unlock proof already used.']
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
 * @param {*} provider
 * @param {*} proof
 */
async function proofAlreadyUsed (provider: ethers.providers.JsonRpcProvider, proof: any, erc20LockerAddress: string): Promise<boolean> {
  const usedProofsKey: string = bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex')
  // The usedProofs_ mapping is the 4th variable defined in the contract storage.
  const usedProofsMappingPosition = '0'.repeat(63) + '3'
  const storageIndex = ethers.utils.keccak256('0x' + usedProofsKey + usedProofsMappingPosition)
  // eth_getStorageAt docs: https://eth.wiki/json-rpc/API
  const proofIsUsed = await provider.getStorageAt(erc20LockerAddress, storageIndex)
  return Number(proofIsUsed) === 1
}

/**
 * Unlock tokens stored in the contract at process.env.ethLockerAddress,
 * passing the proof that the tokens were withdrawn/burned in the corresponding
 * NEAR BridgeToken contract.
 * @param {*} transfer
 */
async function unlock (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Web3Provider
    ethChainId?: number
    erc20LockerAddress?: string
    erc20LockerAbi?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  // Build burn proof
  transfer = await checkSync(transfer)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  const borshProof = borshifyOutcomeProof(proof)

  const ethTokenLocker = new ethers.Contract(
    options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
    options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
    provider.getSigner()
  )
  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingUnlockTx = await ethTokenLocker.unlockToken(borshProof, transfer.nearOnEthClientBlockHeight)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingUnlockTx.from,
      to: pendingUnlockTx.to,
      safeReorgHeight,
      data: pendingUnlockTx.data,
      nonce: pendingUnlockTx.nonce
    },
    unlockHashes: [...transfer.unlockHashes, pendingUnlockTx.hash]
  }
}

async function checkUnlock (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Web3Provider
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
      'Wrong eth network for checkUnlock, expected: %s, got: %s',
      expectedChainId, ethChainId
    )
    return transfer
  }

  const unlockHash = last(transfer.unlockHashes)
  let unlockReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(unlockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!unlockReceipt) {
    // don't break old transfers in case they were made before this functionality is released
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
      unlockReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!unlockReceipt) return transfer

  if (!unlockReceipt.status) {
    const error = `Transaction failed: ${unlockReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
    }
  }

  if (unlockReceipt.transactionHash !== unlockHash) {
    // Record the replacement tx unlockHash
    return {
      ...transfer,
      status: status.COMPLETE,
      completedStep: UNLOCK,
      unlockHashes: [...transfer.unlockHashes, unlockReceipt.transactionHash],
      unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
    }
  }

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: UNLOCK,
    unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
