import BN from 'bn.js'
import bs58 from 'bs58'
import { ethers } from 'ethers'
import { Account, utils, providers as najProviders } from 'near-api-js'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'
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
  parseETHBurnReceipt
} from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getEthProvider, getNearWallet, getNearProvider, getNearAccountId, formatLargeNum, getSignerProvider, getBridgeParams } from '@near-eth/client/dist/utils'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/near-ether/bridged-ether/sendToEthereum'

const BURN = 'burn-bridged-ether-to-natural-ether'
const AWAIT_FINALITY = 'await-finality-bridged-ether-to-natural-ether'
const SYNC = 'sync-bridged-ether-to-natural-ether'
const UNLOCK = 'unlock-bridged-ether-to-natural-ether'

const steps = [
  BURN,
  AWAIT_FINALITY,
  SYNC,
  UNLOCK
]

class TransferError extends Error {}

export interface TransferDraft extends TransferStatus {
  type: string
  finalityBlockHeights: number[]
  nearOnEthClientBlockHeight: null | number
  unlockHashes: string[]
  unlockReceipts: ethers.providers.TransactionReceipt[]
  burnHashes: string[]
  burnReceiptBlockHeights: number[]
  burnReceiptIds: string[]
}

export interface Transfer extends TransferDraft, TransactionInfo {
  id: string
  startTime: string
  finishTime?: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  sourceTokenName: string
  symbol: string
  checkSyncInterval?: number
  nextCheckSyncTimestamp?: Date
  proof?: Uint8Array
}
export interface TransferOptions {
  provider?: ethers.providers.Provider
  etherCustodianAddress?: string
  etherCustodianAbi?: string
  etherCustodianProxyAddress?: string
  etherCustodianProxyAbi?: string
  sendToEthereumSyncInterval?: number
  ethChainId?: number
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  ethClientAddress?: string
  ethClientAbi?: string
  auroraEvmAccount?: string
}

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
  burnReceiptBlockHeights: [],
  burnReceiptIds: [],
  burnHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from NEAR`,
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
        case null: return 'Transferring from NEAR'
        case BURN: return 'Confirming transfer'
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
 * @param transfer Transfer object to act on.
 */
export async function act (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null:
      try {
        return await burn(transfer)
      } catch (error) {
        console.error(error)
        if (error.message.includes('Failed to redirect to sign transaction')) {
          // Increase time to redirect to wallet before recording an error
          await new Promise(resolve => setTimeout(resolve, 10000))
        }
        if (typeof window !== 'undefined') urlParams.clear('withdrawing')
        throw error
      }
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await unlock(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param transfer Transfer object to check status on.
 */
export async function checkStatus (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await checkBurn(transfer)
    case BURN: return await checkFinality(transfer)
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await checkUnlock(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Find all burn transactions sending nETH back to Ethereum.
 * Any WAMP library can be used to query the indexer or near explorer backend via the `callIndexer` callback.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock NEAR block timestamp.
 * @param params.toBlock 'latest' | NEAR block timestamp.
 * @param params.sender NEAR account id.
 * @param params.callIndexer Function making the query to indexer.
 * @param params.options Optional arguments.
 * @param options.auroraEvmAccount nETH bridged ETH account on NEAR (aurora)
 * @returns Array of NEAR transaction hashes.
 */
export async function findAllTransactions (
  { fromBlock, toBlock, sender, callIndexer, options }: {
    fromBlock: string
    toBlock: string
    sender: string
    callIndexer: (query: string) => Promise<[{ originated_from_transaction_hash: string, args: { method_name: string } }]>
    options?: {
      auroraEvmAccount?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const auroraEvmAccount: string = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  const transactions = await callIndexer(buildIndexerTxQuery(
    { fromBlock, toBlock, predecessorAccountId: sender, receiverAccountId: auroraEvmAccount }
  ))
  return transactions.filter(tx => tx.args.method_name === 'withdraw').map(tx => tx.originated_from_transaction_hash)
}

/**
 * Recover all transfers sending nETH back to Ethereum.
 * Any WAMP library can be used to query the indexer or near explorer backend via the `callIndexer` callback.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock NEAR block timestamp.
 * @param params.toBlock 'latest' | NEAR block timestamp.
 * @param params.sender NEAR account id.
 * @param params.callIndexer Function making the query to indexer.
 * @param params.options TransferOptions.
 * @returns Array of recovered transfers.
 */
export async function findAllTransfers (
  { fromBlock, toBlock, sender, callIndexer, options }: {
    fromBlock: string
    toBlock: string
    sender: string
    callIndexer: (query: string) => Promise<[{ originated_from_transaction_hash: string, args: { method_name: string } }]>
    options?: TransferOptions
  }
): Promise<Transfer[]> {
  const burnTransactions = await findAllTransactions({ fromBlock, toBlock, sender, callIndexer, options })
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
 * Recover transfer from a burn tx hash
 * Track a new transfer at the completedStep = BURN so that it can be unlocked
 * @param burnTxHash Near tx hash containing the token withdrawal
 * @param sender Near account sender of burnTxHash
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  burnTxHash: string,
  sender: string = 'todo',
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  const bridgeParams = getBridgeParams()
  const decodedTxHash = utils.serialize.base_decode(burnTxHash)
  const burnTx = await nearProvider.txStatus(
    // TODO: when multiple shards, the sender should be known in order to query txStatus
    decodedTxHash, sender
  )
  sender = burnTx.transaction.signer_id

  // @ts-expect-error TODO
  if (burnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Burn transaction pending: ${burnTxHash}`)
  }

  // @ts-expect-error TODO
  if (burnTx.status.Failure) {
    throw new Error(`Burn transaction failed: ${burnTxHash}`)
  }

  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount

  const withdrawReceipt = await parseETHBurnReceipt(burnTx, auroraEvmAccount, nearProvider)
  const amount = withdrawReceipt.event.amount
  const recipient = withdrawReceipt.event.recipient
  const etherCustodian: string = withdrawReceipt.event.etherCustodian

  const etherCustodianAddress: string = options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress
  if (etherCustodian.toLowerCase() !== etherCustodianAddress.toLowerCase()) {
    throw new Error(
      `Unexpected ether custodian: got ${etherCustodian},
      expected ${etherCustodianAddress}`
    )
  }
  const symbol = 'ETH'
  const destinationTokenName = symbol
  const sourceTokenName = 'n' + symbol
  const sourceToken = auroraEvmAccount
  const decimals = 18

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(withdrawReceipt.blockTimestamp / 10 ** 6).toISOString(),
    amount: amount.toString(),
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender,
    symbol,
    sourceTokenName,
    sourceToken,
    decimals,

    burnHashes: [burnTxHash],
    burnReceiptBlockHeights: [withdrawReceipt.blockHeight],
    burnReceiptIds: [withdrawReceipt.id]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from NEAR to Ethereum by burning nETH tokens.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Ethereum address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.sender Sender of tokens (defaults to the connected NEAR wallet address).
 * @param options.auroraEvmAccount nETH bridged ETH account on NEAR (aurora)
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      sender?: string
      auroraEvmAccount?: string
      nearAccount?: Account
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const decimals = 18
  const symbol = 'ETH'
  const destinationTokenName = symbol
  const sourceTokenName = 'n' + symbol
  const sourceToken = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
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
    transfer = await burn(transfer, options)
    // Track for injected NEAR wallet (Sender)
    if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer
  } catch (error) {
    if (error.message.includes('Failed to redirect to sign transaction')) {
      // Increase time to redirect to wallet before alerting an error
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
    if (typeof window !== 'undefined' && urlParams.get('withdrawing')) {
      // If the urlParam is set then the transfer was tracked so delete it.
      await untrack(urlParams.get('withdrawing') as string)
      urlParams.clear('withdrawing')
    }
    // Throw the error to be handled by frontend
    throw error
  }
  return transfer
}

export async function burn (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearWallet = options.nearAccount ?? getNearWallet()
  const isNajAccount = nearWallet instanceof Account
  const browserRedirect = typeof window !== 'undefined' && (isNajAccount || nearWallet.type === 'browser')

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class BorshWithdrawArgs {
    constructor (args: any) {
      Object.assign(this, args)
    }
  };
  const withdrawCallArgsSchema = new Map([
    [BorshWithdrawArgs, {
      kind: 'struct',
      fields: [
        ['recipient_id', [20]],
        ['amount', 'u128']
        // TODO
        // ['fee', 'u128']
      ]
    }]
  ])
  const args = new BorshWithdrawArgs({
    recipient_id: ethers.utils.arrayify(ethers.utils.getAddress(transfer.recipient)),
    amount: transfer.amount.toString()
    // fee: fee.toString(),
  })
  const serializedArgs = serializeBorsh(withdrawCallArgsSchema, args)

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (browserRedirect) urlParams.set({ withdrawing: transfer.id })
  if (browserRedirect) transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  let tx
  if (isNajAccount) {
    tx = await nearWallet.functionCall({
      contractId: transfer.sourceToken,
      methodName: 'withdraw',
      args: serializedArgs,
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
            methodName: 'withdraw',
            args: serializedArgs,
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
    burnHashes: [...transfer.burnHashes, tx.transaction.hash]
  }
}

/**
 * Process a broadcasted burn transaction
 * checkBurn is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkBurn can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 */
export async function checkBurn (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    nearProvider?: najProviders.Provider
    auroraEvmAccount?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  let txHash: string
  let clearParams
  if (transfer.burnHashes.length === 0) {
    const id = urlParams.get('withdrawing') as string | null
    // NOTE: when a single tx is executed, transactionHashes is equal to that hash
    const transactionHashes = urlParams.get('transactionHashes') as string | null
    const errorCode = urlParams.get('errorCode') as string | null
    clearParams = ['withdrawing', 'transactionHashes', 'errorCode', 'errorMessage']
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
      // Another burn transaction cannot be in progress, ie if checkBurn is called on
      // an in process burn then the transfer ids must be equal or the url callback is invalid.
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
      // If checkBurn is called before burn sig wallet redirect
      // log the error but don't mark as FAILED and don't clear url params
      // as the wallet redirect has not happened yet
      const newError = 'Burn tx hash not received: pending redirect or wallet error'
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
    txHash = last(transfer.burnHashes)
  }

  const decodedTxHash = utils.serialize.base_decode(txHash)
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  const burnTx = await nearProvider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a burn
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  // @ts-expect-error : wallet returns errorCode
  if (burnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error : wallet returns errorCode
  if (burnTx.status.Failure) {
    if (clearParams) urlParams.clear(...clearParams)
    const error = `NEAR transaction failed: ${txHash}`
    console.error(error)
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED,
      burnHashes: [...transfer.burnHashes, txHash]
    }
  }

  let withdrawReceipt
  try {
    const auroraEvmAccount = options.auroraEvmAccount ?? getBridgeParams().auroraEvmAccount
    withdrawReceipt = await parseETHBurnReceipt(burnTx, auroraEvmAccount, nearProvider)
  } catch (e) {
    if (e instanceof TransferError) {
      if (clearParams) urlParams.clear(...clearParams)
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED,
        burnHashes: [...transfer.burnHashes, txHash]
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkBurn will be called again.
    throw e
  }

  const startTime = new Date(withdrawReceipt.blockTimestamp / 10 ** 6).toISOString()

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  if (clearParams) urlParams.clear(...clearParams)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    startTime,
    burnReceiptIds: [...transfer.burnReceiptIds, withdrawReceipt.id],
    burnReceiptBlockHeights: [...transfer.burnReceiptBlockHeights, withdrawReceipt.blockHeight],
    burnHashes: [...transfer.burnHashes, txHash]
  }
}

/**
 * Wait for a final block with a strictly greater height than burnTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 */
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

  const withdrawReceiptBlockHeight = last(transfer.burnReceiptBlockHeights)
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

/**
 * Wait for the block with the given receipt/transaction in Near2EthClient, and
 * get the outcome proof only use block merkle root that we know is available
 * on the Near2EthClient.
 */
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

  const withdrawBlockHeight = last(transfer.burnReceiptBlockHeights)
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
  if (nearOnEthClientBlockHeight > withdrawBlockHeight) {
    proof = await findNearProof(
      last(transfer.burnReceiptIds),
      options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
      nearOnEthClientBlockHeight,
      nearProvider,
      provider,
      options.ethClientAddress ?? bridgeParams.ethClientAddress,
      options.ethClientAbi ?? bridgeParams.ethClientAbi
    )
    if (await proofAlreadyUsed(
      provider,
      proof,
      options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
      options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi
    )) {
      try {
        const { transactions, block } = await findFinalizationTxOnEthereum({
          usedProofPosition: '3',
          proof,
          connectorAddress: options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
          connectorAbi: options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi,
          finalizationEvent: 'Withdrawn',
          recipient: transfer.recipient,
          amount: transfer.amount,
          provider
        })
        transfer = {
          ...transfer,
          finishTime: new Date(block.timestamp * 1000).toISOString(),
          unlockHashes: [...transfer.unlockHashes, ...transactions]
        }
      } catch (error) {
        // Not finding the finalization tx should not prevent processing/recovering the transfer.
        console.error(error)
      }
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
 */
export async function proofAlreadyUsed (provider: ethers.providers.Provider, proof: any, etherCustodianAddress: string, etherCustodianAbi: string): Promise<boolean> {
  const ethTokenLocker = new ethers.Contract(
    etherCustodianAddress,
    etherCustodianAbi,
    provider
  )
  const proofIsUsed = await ethTokenLocker.usedEvents_('0x' + bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex'))
  return proofIsUsed
}

/**
 * Unlock tokens stored in the contract at process.env.ethLockerAddress,
 * passing the proof that the tokens were withdrawn/burned in the corresponding
 * NEAR BridgeToken contract.
 */
export async function unlock (
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

  // Build burn proof
  transfer = await checkSync(transfer, options)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  const borshProof = borshifyOutcomeProof(proof)

  const ethTokenLocker = new ethers.Contract(
    options.etherCustodianProxyAddress ?? bridgeParams.etherCustodianProxyAddress,
    options.etherCustodianProxyAbi ?? bridgeParams.etherCustodianProxyAbi,
    options.signer ?? provider.getSigner()
  )
  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingUnlockTx = await ethTokenLocker.withdraw(borshProof, transfer.nearOnEthClientBlockHeight)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingUnlockTx.from,
      to: pendingUnlockTx.to,
      nonce: pendingUnlockTx.nonce,
      data: pendingUnlockTx.data,
      safeReorgHeight
    },
    unlockHashes: [...transfer.unlockHashes, pendingUnlockTx.hash]
  }
}

export async function checkUnlock (
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
      `Wrong eth network for checkUnlock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
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
    transfer = {
      ...transfer,
      unlockHashes: [...transfer.unlockHashes, unlockReceipt.transactionHash]
    }
  }

  const block = await provider.getBlock(unlockReceipt.blockNumber)

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: UNLOCK,
    finishTime: new Date(block.timestamp * 1000).toISOString(),
    unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
