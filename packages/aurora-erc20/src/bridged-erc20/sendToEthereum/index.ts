import { borshifyOutcomeProof, nearOnEthSyncHeight, findNearProof, findFinalizationTxOnEthereum } from '@near-eth/utils'
import { ethers } from 'ethers'
import bs58 from 'bs58'
import BN from 'bn.js'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import { FinalExecutionOutcome } from 'near-api-js/lib/providers'
import { Account, utils } from 'near-api-js'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import {
  getSignerProvider,
  getAuroraProvider,
  getEthProvider,
  getNearAccount,
  formatLargeNum,
  getBridgeParams
} from '@near-eth/client/dist/utils'
import { BURN_SIGNATURE, EXIT_TO_ETHEREUM_SIGNATURE } from '@near-eth/utils/dist/aurora'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getDecimals, getSymbol } from '../../natural-erc20/getMetadata'
import getAuroraErc20Address from '../getAddress'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/aurora-erc20/bridged-erc20/sendToEthereum'

const BURN = 'burn-bridged-erc20-to-ethereum'
const AWAIT_FINALITY = 'await-finality-bridged-erc20-to-ethereum'
const SYNC = 'sync-bridged-erc20-to-ethereum'
const UNLOCK = 'unlock-bridged-erc20-to-ethereum'

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
  burnReceipts: string[]
  nearBurnHashes: string[]
  nearBurnReceiptIds: string[]
  nearBurnReceiptBlockHeights: number[]
}

export interface Transfer extends TransferDraft, TransactionInfo {
  id: string
  startTime: string
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
  auroraProvider?: ethers.providers.JsonRpcProvider
  erc20LockerAddress?: string
  erc20LockerAbi?: string
  erc20Abi?: string
  sendToEthereumSyncInterval?: number
  ethChainId?: number
  nearAccount?: Account
  ethClientAddress?: string
  ethClientAbi?: string
  nearTokenFactoryAccount?: string
}

const transferDraft: TransferDraft = {
  // Attributes common to all transfer types
  // amount,
  completedStep: null,
  // destinationTokenName,
  errors: [],
  // recipient,
  // sender,
  // sourceToken: erc20Address,
  // sourceTokenName,
  // symbol,
  // decimals,
  status: status.ACTION_NEEDED,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  //   data                     // tx.data of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  finalityBlockHeights: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  burnHashes: [],
  burnReceipts: [],
  nearBurnHashes: [],
  nearBurnReceiptIds: [],
  nearBurnReceiptBlockHeights: [],
  unlockHashes: [],
  unlockReceipts: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from Aurora`,
      [AWAIT_FINALITY]: 'Confirming in Aurora',
      [SYNC]: 'Confirming in Aurora. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in Ethereum`
    }),
    statusMessage: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Aurora'
          case SYNC: return 'Ready to deposit in Ethereum'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Ethereum'
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
    case null: return await burn(transfer)
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await unlock(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
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
 * Parse the burn receipt id and block height needed to complete
 * the step BURN
 * @param nearBurnTx
 * @param nearAccount
 */
export async function parseBurnReceipt (
  nearBurnTx: FinalExecutionOutcome,
  nearAccount: Account
): Promise<{id: string, blockHeight: number }> {
  const receiptIds = nearBurnTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Burn expects only one receipt, got ${receiptIds.length}.
      Full withdrawal transaction: ${JSON.stringify(nearBurnTx)}`
    )
  }

  // Get receipt information for recording and building burn proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = nearBurnTx.receipts_outcome
    .find(r => r.id === txReceiptId)!
    .outcome
  const withdrawReceiptId = successReceiptOutcome.receipt_ids[0]
  const withdrawReceiptOutcome = nearBurnTx.receipts_outcome
    .find(r => r.id === withdrawReceiptId)!
    .outcome

  // @ts-expect-error TODO
  const burnReceiptId = withdrawReceiptOutcome.status.SuccessReceiptId

  const txReceiptBlockHash = nearBurnTx.receipts_outcome
    .find(r => r.id === burnReceiptId)!
    // @ts-expect-error TODO
    .block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: burnReceiptId, blockHeight: receiptBlockHeight }
}

export async function findAllTransactions (
  { fromBlock, toBlock, sender, erc20Address, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    erc20Address: string
    options?: {
      provider?: ethers.providers.Provider
      auroraErc20Address?: string
      auroraErc20Abi?: string
      auroraEvmAccount?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()
  const auroraErc20Address = options.auroraErc20Address ?? await getAuroraErc20Address(
    { erc20Address, options }
  )
  const auroraErc20 = new ethers.Contract(
    auroraErc20Address,
    options.auroraErc20Abi ?? bridgeParams.auroraErc20Abi,
    provider
  )
  const filterBurns = auroraErc20.filters.Transfer!(sender, '0x0000000000000000000000000000000000000000')
  const events = await auroraErc20.queryFilter(filterBurns, fromBlock, toBlock)
  const receipts = await Promise.all(events.map(async (event) => {
    const receipt = await provider.getTransactionReceipt(event.transactionHash)
    return receipt
  }))
  // Keep only transfers from Aurora to Ethereum.
  const transferReceipts = receipts.filter((receipt) => receipt.logs.find(
    (log) => log.topics[0] === EXIT_TO_ETHEREUM_SIGNATURE
  ))
  return transferReceipts.map(r => r.transactionHash)
}

export async function findAllTransfers (
  { fromBlock, toBlock, sender, erc20Address, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    erc20Address: string
    options?: TransferOptions & {
      decimals?: number
      symbol?: string
    }
  }
): Promise<Transfer[]> {
  const burnTransactions = await findAllTransactions({ fromBlock, toBlock, sender, erc20Address, options })
  const transfers = await Promise.all(burnTransactions.map(async (tx) => await recover(tx, sender, options)))
  return transfers
}

/**
 * Recover transfer from a burn tx hash
 * @param burnTxHash Aurora or NEAR relayer tx hash containing the token withdrawal
 * @param sender Near account sender of burnTxHash (aurora relayer)
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  burnTxHash: string,
  sender: string = 'todo',
  options?: TransferOptions & {
    decimals?: number
    symbol?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()

  let nearBurnTxHash
  let decodedTxHash
  let auroraTxHash
  let sourceToken
  let auroraSender = 'NA' // Aurora event is needed
  if (/^0x[A-Fa-f0-9]{64}$/.test(burnTxHash)) {
    const auroraProvider = options.auroraProvider ?? getAuroraProvider()
    // Ethers formats the receipts and removes nearTransactionHash
    const auroraBurnReceipt = await auroraProvider.send('eth_getTransactionReceipt', [burnTxHash])
    decodedTxHash = Buffer.from(auroraBurnReceipt.nearTransactionHash.slice(2), 'hex')
    nearBurnTxHash = bs58.encode(decodedTxHash)

    const burnLog: ethers.providers.Log = auroraBurnReceipt.logs.find(
      (log: ethers.providers.Log) => log.topics[0] === BURN_SIGNATURE
    )
    auroraSender = '0x' + burnLog.topics[1]!.slice(26)

    sourceToken = auroraBurnReceipt.logs.find(
      (log: ethers.providers.Log) => log.topics[0] === EXIT_TO_ETHEREUM_SIGNATURE
    ).address.toLowerCase()

    auroraTxHash = burnTxHash
  } else {
    nearBurnTxHash = burnTxHash
    decodedTxHash = utils.serialize.base_decode(nearBurnTxHash)
  }

  const burnTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, sender
  )

  // @ts-expect-error TODO
  if (burnTx.status.Unknown) {
    throw new Error(`Withdraw transaction pending: ${burnTxHash}`)
  }

  // @ts-expect-error TODO
  if (burnTx.status.Failure) {
    throw new Error(`Withdraw transaction failed: ${burnTxHash}`)
  }

  // Get withdraw event information from successValue
  const nearBurnReceipt = await parseBurnReceipt(burnTx, nearAccount)
  const burnReceiptOutcome = burnTx.receipts_outcome
    .find(r => r.id === nearBurnReceipt.id)!
    .outcome

  // @ts-expect-error TODO
  const successValue: string = burnReceiptOutcome.status.SuccessValue
  if (!successValue) {
    throw new Error(
      `Invalid burnTx successValue: '${successValue}'
      Full withdrawal transaction: ${JSON.stringify(burnTx)}`
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class BurnEvent {
    constructor (args: any) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [BurnEvent, {
      kind: 'struct',
      fields: [
        ['flag', 'u8'],
        ['amount', 'u128'],
        ['token', [20]],
        ['recipient', [20]]
      ]
    }]
  ])
  const burnEvent = deserializeBorsh(
    SCHEMA, BurnEvent, Buffer.from(successValue, 'base64')
  ) as { amount: BN, token: Uint8Array, recipient: Uint8Array }

  const amount = burnEvent.amount.toString()
  const recipient = '0x' + Buffer.from(burnEvent.recipient).toString('hex')
  const erc20Address = '0x' + Buffer.from(burnEvent.token).toString('hex')
  const symbol = options.symbol ?? await getSymbol({ erc20Address, options })
  const decimals = options.decimals ?? await getDecimals({ erc20Address, options })
  const sourceTokenName = 'a' + symbol
  const destinationTokenName = symbol

  if (!auroraTxHash) {
    auroraTxHash = ethers.utils.keccak256(
      Buffer.from(burnTx.transaction.actions[0].FunctionCall.args, 'base64')
    )
    sourceToken = await getAuroraErc20Address({ erc20Address, options })
  }

  // @ts-expect-error TODO
  const txBlock = await nearAccount.connection.provider.block({ blockId: burnTx.transaction_outcome.block_hash })

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(txBlock.header.timestamp / 10 ** 6).toISOString(),
    amount,
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender: auroraSender,
    sourceTokenName,
    sourceToken,
    symbol,
    decimals,
    burnHashes: [auroraTxHash],
    nearBurnHashes: [nearBurnTxHash],
    nearBurnReceiptIds: [nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [nearBurnReceipt.blockHeight]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Aurora to Ethereum by burning minted tokens.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address ERC-20 address of the bridged token to transfer.
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Ethereum address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol ERC-20 symbol (queried if not provided).
 * @param params.options.decimals ERC-20 decimals (queried if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.auroraChainId Aurora chain id of the bridge.
 * @param params.options.auroraErc20Abi Aurora ERC-20 abi to call withdrawToEthereum.
 * @param params.options.auroraErc20Address params.erc20Address's address on Aurora.
 * @param options.auroraEvmAccount Aurora account on NEAR.
 * @param params.options.nep141Factory ERC-20 connector factory to determine the NEAR address.
 * @param options.provider Aurora provider to use.
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 * @param params.options.signer Ethers signer to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { erc20Address, amount, recipient, options }: {
    erc20Address: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      auroraChainId?: number
      auroraErc20Abi?: string
      auroraErc20Address?: string
      auroraEvmAccount?: string
      nep141Factory?: string
      provider?: ethers.providers.JsonRpcProvider
      nearAccount?: Account
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  const auroraErc20Address = options.auroraErc20Address ?? await getAuroraErc20Address(
    { erc20Address, options }
  )
  const symbol = options.symbol ?? await getSymbol({
    erc20Address: auroraErc20Address, options: { provider, erc20Abi: options.auroraErc20Abi }
  })
  const sourceTokenName = 'a' + symbol
  const destinationTokenName = symbol
  const decimals = options.decimals ?? await getDecimals({
    erc20Address: auroraErc20Address, options: { provider, erc20Abi: options.auroraErc20Abi }
  })

  const signer = options.signer ?? provider.getSigner()
  const sender = options.sender ?? (await signer.getAddress()).toLowerCase()

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: auroraErc20Address,
    sourceTokenName,
    symbol,
    decimals
  }

  transfer = await burn(transfer, options)

  if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer

  return transfer
}

/**
 * Initiate "burn" transaction.
 * Only wait for transaction to have dependable transactionHash created. Avoid
 * blocking to wait for transaction to be mined. Status of transactionHash
 * being mined is then checked in checkStatus.
 */
export async function burn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    auroraChainId?: number
    auroraErc20Abi?: string
    signer?: ethers.Signer
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.auroraChainId ?? bridgeParams.auroraChainId
  if (ethChainId !== expectedChainId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong aurora network for lock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const auroraErc20 = new ethers.Contract(
    transfer.sourceToken,
    options.auroraErc20Abi ?? bridgeParams.auroraErc20Abi,
    options.signer ?? provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingBurnTx = await auroraErc20.withdrawToEthereum(
    transfer.recipient,
    transfer.amount,
    { gasLimit: 100000 }
  )

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to,
      data: pendingBurnTx.data,
      nonce: pendingBurnTx.nonce,
      safeReorgHeight
    },
    burnHashes: [...transfer.burnHashes, pendingBurnTx.hash]
  }
}

export async function checkBurn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    auroraChainId?: number
    auroraRelayerAccount?: string
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()

  const burnHash = last(transfer.burnHashes)

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.auroraChainId ?? bridgeParams.auroraChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong aurora network for checkLock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  // Ethers formats the receipts and removes nearTransactionHash
  let burnReceipt = await provider.send('eth_getTransactionReceipt', [burnHash])

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        data: transfer.ethCache.data,
        to: transfer.ethCache.to
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      // Ethers formats the receipts and removes nearTransactionHash
      burnReceipt = await provider.send('eth_getTransactionReceipt', [foundTx.hash])
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

  if (!burnReceipt) return transfer

  if (burnReceipt.status !== '0x1') {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    const error = `Aurora transaction failed: ${burnReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }
  if (burnReceipt.transactionHash !== burnHash) {
    // Record the replacement tx burnHash
    transfer = {
      ...transfer,
      burnHashes: [...transfer.burnHashes, burnReceipt.transactionHash],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }

  // Parse NEAR tx burn receipt
  const decodedTxHash = Buffer.from(burnReceipt.nearTransactionHash.slice(2), 'hex')
  const nearBurnHash = bs58.encode(decodedTxHash)

  const nearAccount = options.nearAccount ?? await getNearAccount()
  const nearBurnTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, options.auroraRelayerAccount ?? bridgeParams.auroraRelayerAccount
  )

  // @ts-expect-error
  if (nearBurnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error
  if (nearBurnTx.status.Failure) {
    const error = 'NEAR relay.aurora transaction failed.'
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED
    }
  }

  let nearBurnReceipt
  try {
    nearBurnReceipt = await parseBurnReceipt(nearBurnTx, nearAccount)
  } catch (e) {
    if (e instanceof TransferError) {
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkWithdraw will be called again.
    throw e
  }

  // @ts-expect-error TODO
  const txBlock = await nearAccount.connection.provider.block({ blockId: nearBurnTx.transaction_outcome.block_hash })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    startTime: new Date(txBlock.header.timestamp / 10 ** 6).toISOString(),
    burnReceipts: [...transfer.burnReceipts, burnReceipt],
    nearBurnHashes: [...transfer.nearBurnHashes, nearBurnHash],
    nearBurnReceiptIds: [...transfer.nearBurnReceiptIds, nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [...transfer.nearBurnReceiptBlockHeights, nearBurnReceipt.blockHeight]
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
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()

  const withdrawReceiptBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
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

  const burnBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(
    provider,
    options.ethClientAddress ?? bridgeParams.ethClientAddress,
    options.ethClientAbi ?? bridgeParams.ethClientAbi
  )
  let proof

  const nearAccount = options.nearAccount ?? await getNearAccount()
  if (nearOnEthClientBlockHeight > burnBlockHeight) {
    proof = await findNearProof(
      last(transfer.nearBurnReceiptIds),
      options.nearTokenFactoryAccount ?? bridgeParams.nearTokenFactoryAccount,
      nearOnEthClientBlockHeight,
      nearAccount,
      provider,
      options.ethClientAddress ?? bridgeParams.ethClientAddress,
      options.ethClientAbi ?? bridgeParams.ethClientAbi
    )
    if (await proofAlreadyUsed(
      provider,
      proof,
      options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
      options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi
    )) {
      try {
        const finalizationTxHash = await findFinalizationTxOnEthereum({
          usedProofPosition: '3',
          proof,
          connectorAddress: options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
          connectorAbi: options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
          finalizationEvent: 'Unlocked',
          recipient: transfer.recipient,
          amount: transfer.amount,
          provider
        })
        transfer = {
          ...transfer,
          unlockHashes: [...transfer.unlockHashes, ...finalizationTxHash]
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
export async function proofAlreadyUsed (provider: ethers.providers.Provider, proof: any, erc20LockerAddress: string, erc20LockerAbi: string): Promise<boolean> {
  const ethTokenLocker = new ethers.Contract(
    erc20LockerAddress,
    erc20LockerAbi,
    provider
  )
  const proofIsUsed = await ethTokenLocker.usedProofs_('0x' + bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex'))
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

  // Build burn proof
  transfer = await checkSync(transfer, { ...options, provider })
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  // Unlock
  const borshProof = borshifyOutcomeProof(proof)

  const ethTokenLocker = new ethers.Contract(
    options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
    options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
    options.signer ?? provider.getSigner()
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

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: UNLOCK,
    unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
