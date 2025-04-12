import BN from 'bn.js'
import bs58 from 'bs58'
import { ethers } from 'ethers'
import { Account, utils, providers as najProviders } from 'near-api-js'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { track, untrack } from '@near-eth/client'
import {
  borshifyOutcomeProof,
  urlParams,
  nearOnEthSyncHeight,
  findNearProof,
  buildIndexerTxQuery,
  findFinalizationTxOnEthereum,
  parseNep141LockReceipt,
  nep141
} from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import {
  getEthProvider,
  getNearWallet,
  getNearAccountId,
  getNearProvider,
  formatLargeNum,
  getSignerProvider,
  getBridgeParams
} from '@near-eth/client/dist/utils'
import getMetadata from '../getMetadata'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/nep141-erc20/natural-nep141/sendToEthereum'

const LOCK = 'lock-natural-nep141-to-erc20'
const AWAIT_FINALITY = 'await-finality-natural-nep141-to-erc20'
const SYNC = 'sync-natural-nep141-to-erc20'
const MINT = 'mint-natural-nep141-to-erc20'

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
  startTime: string
  finishTime?: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  symbol: string
  sourceTokenName: string
  checkSyncInterval?: number
  nextCheckSyncTimestamp?: Date
  proof?: Uint8Array
}

export interface TransferOptions {
  provider?: ethers.providers.Provider
  sendToEthereumSyncInterval?: number
  ethChainId?: number
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  ethClientAddress?: string
  ethClientAbi?: string
  nep141LockerAccount?: string
  erc20FactoryAbi?: string
  erc20FactoryAddress?: string
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

  // Attributes specific to natural-nep141-to-erc20 transfers
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
        case null: return 'Transferring from NEAR'
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
export async function act (transfer: Transfer, options?: TransferOptions): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null:
      try {
        return await lock(transfer,options)
      } catch (error) {
        console.error(error)
        if (error.message?.includes('Failed to redirect to sign transaction')) {
          // Increase time to redirect to wallet before recording an error
          await new Promise(resolve => setTimeout(resolve, 10000))
        }
        if (typeof window !== 'undefined') urlParams.clear('locking')
        throw error
      }
    case AWAIT_FINALITY: return await checkSync(transfer,options)
    case SYNC: return await mint(transfer,options)
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
 * Find all lock transactions sending nep141Address tokens from NEAR to Ethereum.
 * Any WAMP library can be used to query the indexer or near explorer backend via the `callIndexer` callback.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock NEAR block timestamp.
 * @param params.toBlock 'latest' | NEAR block timestamp.
 * @param params.sender NEAR account id.
 * @param params.erc20Address Token address on Ethereum.
 * @param params.callIndexer Function making the query to indexer.
 * @param params.options Optional arguments.
 * @param params.options.nep141Address Token address on NEAR.
 * @returns Array of NEAR transaction hashes.
 */
export async function findAllTransactions (
  { fromBlock, toBlock, sender, nep141Address, callIndexer, options }: {
    fromBlock: string
    toBlock: string
    sender: string
    nep141Address: string
    callIndexer: (query: string) => Promise<[{ originated_from_transaction_hash: string, args: { method_name: string } }]>
    options?: {
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const transactions = await callIndexer(buildIndexerTxQuery(
    { fromBlock, toBlock, predecessorAccountId: sender, receiverAccountId: nep141Address }
  ))
  return transactions.filter(tx => tx.args.method_name === 'withdraw').map(tx => tx.originated_from_transaction_hash)
}

/**
 * Recover all transfers sending nep141Address tokens from NEAR to Ethereum.
 * Any WAMP library can be used to query the indexer or near explorer backend via the `callIndexer` callback.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock NEAR block timestamp.
 * @param params.toBlock 'latest' | NEAR block timestamp.
 * @param params.sender NEAR account id.
 * @param params.erc20Address Token address on Ethereum.
 * @param params.callIndexer Function making the query to indexer.
 * @param params.options TransferOptions.
 * @returns Array of recovered transfers.
 */
export async function findAllTransfers (
  { fromBlock, toBlock, sender, nep141Address, callIndexer, options }: {
    fromBlock: string
    toBlock: string
    sender: string
    nep141Address: string
    callIndexer: (query: string) => Promise<[{ originated_from_transaction_hash: string, args: { method_name: string } }]>
    options?: TransferOptions & {
      decimals?: number
      symbol?: string
    }
  }
): Promise<Transfer[]> {
  const burnTransactions = await findAllTransactions({ fromBlock, toBlock, sender, nep141Address, callIndexer, options })
  const transfers = await Promise.all(burnTransactions.map(async (tx) => {
    try {
      return await recover(tx, sender, options)
    } catch (error) {
      // Unlike with Ethereum events, the transaction exists even if it failed.
      // So ignore the transfer if it cannot be recovered
      console.log('Failed to recover transfer (transaction failed ?): ', tx, error)
      return null
    }
  }))
  return transfers.filter((transfer: Transfer | null): transfer is Transfer => transfer !== null)
}

/**
 * Recover transfer from a lock tx hash
 * @param lockTxHash Near tx hash containing the token lock
 * @param sender Near account sender of lockTxHash
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  lockTxHash: string,
  sender: string = 'todo',
  options?: TransferOptions & {
    decimals?: number
    symbol?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  const decodedTxHash = utils.serialize.base_decode(lockTxHash)
  const lockTx = await nearProvider.txStatus(
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

  const nep141LockerAccount = options.nep141LockerAccount ?? getBridgeParams().nep141LockerAccount
  const lockReceipt = await parseNep141LockReceipt(lockTx, nep141LockerAccount, nearProvider)

  const { amount, recipient, token: nep141Address } = lockReceipt.event
  let metadata = { symbol: '', decimals: 0 }
  if (!options.symbol || !options.decimals) {
    metadata = await getMetadata({ nep141Address, options })
  }
  const symbol = options.symbol ?? metadata.symbol
  const decimals = options.decimals ?? metadata.decimals
  const destinationTokenName = symbol
  const sourceTokenName = symbol
  const sourceToken = nep141Address

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(lockReceipt.blockTimestamp / 10 ** 6).toISOString(),
    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    symbol,
    decimals,

    lockHashes: [lockTxHash],
    lockReceiptBlockHeights: [lockReceipt.blockHeight],
    lockReceiptIds: [lockReceipt.id]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from NEAR to Ethereum by locking tokens.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.nep141Address NEP-141 address of the NEAR token to transfer.
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Ethereum address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol ERC-20 symbol (queried if not provided).
 * @param params.options.decimals ERC-20 decimals (queried if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected NEAR wallet address).
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 * @param params.options.nearProvider NEAR provider.
 * @returns The created transfer object.
 */
export async function initiate (
  { nep141Address, amount, recipient, options }: {
    nep141Address: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      nearAccount?: Account
      nearProvider?: najProviders.Provider
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  let metadata = { symbol: '', decimals: 0 }
  if (!options.symbol || !options.decimals) {
    const nearProvider =
      options.nearProvider ??
      options.nearAccount?.connection.provider ??
      getNearProvider()
    metadata = await nep141.getMetadata({ nep141Address, nearProvider })
  }
  const symbol: string = options.symbol ?? metadata.symbol
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const sourceToken = nep141Address
  const decimals = options.decimals ?? metadata.decimals
  const sender = options.sender ?? await getNearAccountId()

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    symbol,
    decimals
  }

  try {
    transfer = await lock(transfer, options)
    // Track for injected NEAR wallet (Sender)
    if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer
  } catch (error) {
    console.error(error)
    if (error.message?.includes('Failed to redirect to sign transaction')) {
      // Increase time to redirect to wallet before alerting an error
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
    if (typeof window !== 'undefined' && urlParams.get('locking')) {
      // If the urlParam is set then the transfer was tracked so delete it.
      await untrack(urlParams.get('locking') as string)
      urlParams.clear('locking')
    }
    // Throw the error to be handled by frontend
    throw error
  }

  return transfer
}

export async function lock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    nep141LockerAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearWallet = options.nearAccount ?? getNearWallet()
  const isNajAccount = nearWallet instanceof Account
  const browserRedirect = typeof window !== 'undefined' && (isNajAccount || nearWallet.type === 'browser')

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (browserRedirect) urlParams.set({ locking: transfer.id })
  if (browserRedirect) transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  let tx
  if (isNajAccount) {
    tx = await nearWallet.functionCall({
      contractId: transfer.sourceToken,
      methodName: 'ft_transfer_call',
      args: {
        receiver_id: options.nep141LockerAccount ?? getBridgeParams().nep141LockerAccount,
        amount: transfer.amount,
        memo: null,
        msg: transfer.recipient.toLowerCase().slice(2)
      },
      // 100Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      gas: new BN('100' + '0'.repeat(12)),
      attachedDeposit: new BN('1')
    })
  } else {
    tx = await nearWallet.signAndSendTransaction({
      receiverId: transfer.sourceToken,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'ft_transfer_call',
            args: {
              receiver_id: options.nep141LockerAccount ?? getBridgeParams().nep141LockerAccount,
              amount: transfer.amount,
              memo: null,
              msg: transfer.recipient.toLowerCase().slice(2)
            },
            gas: '100' + '0'.repeat(12),
            deposit: '1'
          }
        }
      ]
    })
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    lockHashes: [...transfer.lockHashes, tx.transaction.hash]
  }
}

export async function checkLock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    nearProvider?: najProviders.Provider
    nep141LockerAccount?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  let txHash: string
  let clearParams
  if (transfer.lockHashes.length === 0) {
    const id = urlParams.get('locking') as string | null
    // NOTE: when a single tx is executed, transactionHashes is equal to that hash
    const transactionHashes = urlParams.get('transactionHashes') as string | null
    const errorCode = urlParams.get('errorCode') as string | null
    clearParams = ['locking', 'transactionHashes', 'errorCode', 'errorMessage']
    if (!id) {
      // The user closed the tab and never rejected or approved the tx from Near wallet.
      // This doesn't protect agains the user broadcasting a tx and closing the tab before
      // redirect. So the dapp has no way of knowing the status of that transaction.
      // Set status to FAILED so that it can be retried
      const newError = `A transaction was initiated but could not be verified.
        Click 'Rescan the blockchain' to check if a transfer was created.`
      console.error(newError)
      return {
        ...transfer,
        status: status.FAILED,
        errors: [...transfer.errors, newError]
      }
    }
    if (id !== transfer.id) {
      // Another withdraw transaction cannot be in progress, ie if checkLock is called on
      // an in process withdraw then the transfer ids must be equal or the url callback is invalid.
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
      urlParams.clear(...clearParams)
      const newError = 'Error from wallet: ' + errorCode
      console.error(newError)
      return {
        ...transfer,
        status: status.FAILED,
        errors: [...transfer.errors, newError]
      }
    }
    if (!transactionHashes) {
      // If checkLock is called before withdraw sig wallet redirect
      // log the error but don't mark as FAILED and don't clear url params
      // as the wallet redirect has not happened yet
      const newError = 'Withdraw tx hash not received: pending redirect or wallet error'
      console.log(newError)
      return transfer
    }
    if (transactionHashes.includes(',')) {
      urlParams.clear(...clearParams)
      const newError = 'Error from wallet: expected single txHash, got: ' + transactionHashes
      console.error(newError)
      return {
        ...transfer,
        status: status.FAILED,
        errors: [...transfer.errors, newError]
      }
    }
    txHash = transactionHashes
  } else {
    txHash = last(transfer.lockHashes)
  }

  const decodedTxHash = utils.serialize.base_decode(txHash)
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  const lockTx = await nearProvider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a withdraw
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
    if (clearParams) urlParams.clear(...clearParams)
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
  const nep141LockerAccount = options.nep141LockerAccount ?? getBridgeParams().nep141LockerAccount
  try {
    lockReceipt = await parseNep141LockReceipt(lockTx, nep141LockerAccount, nearProvider)
  } catch (e) {
    if (e instanceof TransferError) {
      if (clearParams) urlParams.clear(...clearParams)
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

  const startTime = new Date(lockReceipt.blockTimestamp / 10 ** 6).toISOString()

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  if (clearParams) urlParams.clear(...clearParams)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    startTime,
    lockReceiptIds: [...transfer.lockReceiptIds, lockReceipt.id],
    lockReceiptBlockHeights: [...transfer.lockReceiptBlockHeights, lockReceipt.blockHeight],
    lockHashes: [...transfer.lockHashes, txHash]
  }
}

export async function checkFinality (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    nearProvider?: najProviders.Provider
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()

  const withdrawReceiptBlockHeight = last(transfer.lockReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearProvider.block({ finality: 'final' })
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

export async function checkSync (
  transfer: Transfer | string,
  options?: TransferOptions
): Promise<Transfer> {
  if (typeof transfer === 'string') {
    return await recover(transfer, 'todo', options)
  }
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

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkSync, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const lockBlockHeight = last(transfer.lockReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(
    provider,
    options.ethClientAddress ?? bridgeParams.ethClientAddress,
    options.ethClientAbi ?? bridgeParams.ethClientAbi
  )
  let proof

  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  if (nearOnEthClientBlockHeight > lockBlockHeight) {
    proof = await findNearProof(
      last(transfer.lockReceiptIds),
      options.nep141LockerAccount ?? bridgeParams.nep141LockerAccount,
      nearOnEthClientBlockHeight,
      nearProvider,
      provider,
      options.ethClientAddress ?? bridgeParams.ethClientAddress,
      options.ethClientAbi ?? bridgeParams.ethClientAbi
    )
    if (await proofAlreadyUsed(
      provider,
      proof,
      options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
      options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi
    )) {
      try {
        const { transactions, block } = await findFinalizationTxOnEthereum({
          usedProofPosition: '3',
          proof,
          connectorAddress: options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
          connectorAbi: options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
          finalizationEvent: 'Deposit',
          recipient: transfer.recipient,
          amount: transfer.amount,
          provider
        })
        transfer = {
          ...transfer,
          finishTime: new Date(block.timestamp * 1000).toISOString(),
          mintHashes: [...transfer.mintHashes, ...transactions]
        }
      } catch (error) {
        // Not finding the finalization tx should not prevent processing/recovering the transfer.
        console.error(error)
      }
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
    proof // used when checkSync() is called by mint()
  }
}

export async function proofAlreadyUsed (provider: ethers.providers.Provider, proof: any, erc20FactoryAddress: string, erc20FactoryAbi: string): Promise<boolean> {
  const erc20Factory = new ethers.Contract(
    erc20FactoryAddress,
    erc20FactoryAbi,
    provider
  )
  const proofIsUsed = await erc20Factory.usedProofs('0x' + bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex'))
  return proofIsUsed
}

export async function mint (
  transfer: Transfer | string,
  options?: Omit<TransferOptions, 'provider'> & {
    provider?: ethers.providers.JsonRpcProvider
    signer?: ethers.Signer
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkSync, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  // Build lock proof
  transfer = await checkSync(transfer, options)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  const borshProof = borshifyOutcomeProof(proof)

  const erc20Factory = new ethers.Contract(
    options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
    options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
    options.signer ?? provider.getSigner()
  )
  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingMintTx = await erc20Factory.deposit(borshProof, transfer.nearOnEthClientBlockHeight)

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

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkMint, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const mintHash = last(transfer.mintHashes)
  let mintReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(mintHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!mintReceipt) {
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
    transfer = {
      ...transfer,
      mintHashes: [...transfer.mintHashes, mintReceipt.transactionHash]
    }
  }

  const block = await provider.getBlock(mintReceipt.blockNumber)

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: LOCK,
    finishTime: new Date(block.timestamp * 1000).toISOString(),
    mintReceipts: [...transfer.mintReceipts, mintReceipt]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
