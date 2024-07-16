import {
  borshifyOutcomeProof,
  nearOnEthSyncHeight,
  findNearProof,
  findFinalizationTxOnEthereum,
  parseETHBurnReceipt,
  parseNep141BurnReceipt,
  selectEtherNep141Factory
} from '@near-eth/utils'
import { ethers } from 'ethers'
import bs58 from 'bs58'
import { Account, providers as najProviders } from 'near-api-js'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import {
  getSignerProvider,
  getAuroraCloudProvider,
  getEthProvider,
  getNearProvider,
  formatLargeNum,
  getBridgeParams
} from '@near-eth/client/dist/utils'
import { EXIT_TO_ETHEREUM_SIGNATURE } from '@near-eth/utils/dist/aurora'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/aurora-ether/bridged-ether/sendToEthereum'

const BURN = 'burn-bridged-ether-to-ethereum'
const AWAIT_FINALITY = 'await-finality-bridged-ether-to-ethereum'
const SYNC = 'sync-bridged-ether-to-ethereum'
const UNLOCK = 'unlock-bridged-ether-to-ethereum'

const steps = [
  BURN,
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
  burnHashes: string[]
  burnReceipts: string[]
  nearBurnHashes: string[]
  nearBurnReceiptIds: string[]
  nearBurnReceiptBlockHeights: number[]
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
  auroraEvmAccount?: string
  auroraChainId?: string
}

export interface TransferOptions {
  provider?: ethers.providers.Provider
  etherCustodianAddress?: string
  etherCustodianAbi?: string
  etherCustodianProxyAddress?: string
  etherCustodianProxyAbi?: string
  sendToEthereumSyncInterval?: number
  ethChainId?: number
  auroraChainId?: string
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  ethClientAddress?: string
  ethClientAbi?: string
  auroraProvider?: ethers.providers.JsonRpcProvider
  auroraEvmAccount?: string
  symbol?: string
  etherNep141Factory?: string
  etherNep141FactoryMigrationHeight?: number
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
        case null: return 'Transferring to Ethereum'
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

export async function findAllTransactions (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: {
      provider?: ethers.providers.Provider
      etherExitToEthereumPrecompile?: string
      auroraEvmAccount?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraCloudProvider({ auroraEvmAccount: options?.auroraEvmAccount })

  const filter = {
    address: options.etherExitToEthereumPrecompile ?? bridgeParams.etherExitToEthereumPrecompile,
    fromBlock,
    toBlock,
    topics: [
      EXIT_TO_ETHEREUM_SIGNATURE,
      ethers.utils.hexZeroPad(sender, 32)
    ]
  }
  const logs = await provider.getLogs(filter)
  return logs.map(l => l.transactionHash)
}

export async function findAllTransfers (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: TransferOptions
  }
): Promise<Transfer[]> {
  const burnTransactions = await findAllTransactions({ fromBlock, toBlock, sender, options })
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
    nep141Factory?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()

  const auroraProvider = options.auroraProvider ?? getAuroraCloudProvider({ auroraEvmAccount: options?.auroraEvmAccount })
  // Ethers formats the receipts and removes nearTransactionHash
  const auroraBurnReceipt = await auroraProvider.send('eth_getTransactionReceipt', [burnTxHash])
  const decodedTxHash = Buffer.from(auroraBurnReceipt.nearTransactionHash.slice(2), 'hex')
  const nearBurnTxHash = bs58.encode(decodedTxHash)
  const exitLog: ethers.providers.Log = auroraBurnReceipt.logs.find(
    (log: ethers.providers.Log) => log.topics[0] === EXIT_TO_ETHEREUM_SIGNATURE
  )
  const auroraSender = '0x' + exitLog.topics[1]!.slice(26)

  const burnTx = await nearProvider.txStatus(decodedTxHash, sender)

  // @ts-expect-error TODO
  if (burnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Withdraw transaction pending: ${nearBurnTxHash}`)
  }

  // Check status of tx broadcasted by relayer
  // @ts-expect-error TODO
  if (burnTx.status.Failure) {
    throw new Error(`Withdraw transaction failed: ${nearBurnTxHash}`)
  }

  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount

  let nearBurnReceipt
  let amount
  let recipient
  if (options.symbol && options.symbol !== 'ETH') {
    // Withdraw native currency from a silo which doesn't use ETH as native currency
    const nep141Factory = options.nep141Factory ?? bridgeParams.nep141Factory
    nearBurnReceipt = await parseNep141BurnReceipt(burnTx, nep141Factory, nearProvider)
    amount = nearBurnReceipt.event.amount
    recipient = nearBurnReceipt.event.recipient
  } else {
    const etherNep141Factory = await selectEtherNep141Factory({
      etherNep141FactoryMigrationHeight: options.etherNep141FactoryMigrationHeight ?? bridgeParams.etherNep141FactoryMigrationHeight,
      etherNep141Factory: options.etherNep141Factory ?? bridgeParams.etherNep141Factory,
      auroraEvmAccount,
      // @ts-expect-error
      blockHash: burnTx.transaction_outcome.block_hash,
      nearProvider
    })
    nearBurnReceipt = await parseETHBurnReceipt(burnTx, etherNep141Factory, nearProvider)
    amount = nearBurnReceipt.event.amount
    recipient = nearBurnReceipt.event.recipient
  }
  // A silo might not use ETH as its base currency.
  const symbol = options.symbol ?? 'ETH'
  const destinationTokenName = symbol
  const decimals = 18
  const sourceTokenName = 'a' + symbol
  const sourceToken = symbol

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(nearBurnReceipt.blockTimestamp / 10 ** 6).toISOString(),
    amount,
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender: auroraSender,
    sourceToken,
    sourceTokenName,
    symbol,
    decimals,
    auroraEvmAccount,
    auroraChainId: options.auroraChainId ?? bridgeParams.auroraChainId,
    burnHashes: [burnTxHash],
    nearBurnHashes: [nearBurnTxHash],
    nearBurnReceiptIds: [nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [nearBurnReceipt.blockHeight]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Aurora to Ethereum by burning tokens.
 * Broadcasts the lock transaction and creates a transfer object.
 * The receipt will be fetched by checkStatus.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Ethereum address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol Ether symbol (ETH if not provided).
 * @param params.options.decimals Ether decimals (18 if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.auroraChainId Aurora chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.etherExitToEthereumPrecompile Aurora ether exit to Ethereum precompile address.
 * @param params.options.auroraEvmAccount NEAR account of the silo to witdraw from.
 * @param params.options.signer Ethers signer to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      auroraChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      etherExitToEthereumPrecompile?: string
      auroraEvmAccount?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const symbol = options.symbol ?? 'ETH'
  const destinationTokenName = symbol
  const sourceTokenName = 'a' + symbol
  const sourceToken = symbol
  const decimals = options.decimals ?? 18

  const provider = options.provider ?? getSignerProvider()
  const signer = options.signer ?? provider.getSigner()
  const sender = options.sender ?? (await signer.getAddress()).toLowerCase()
  const bridgeParams = getBridgeParams()

  // various attributes stored as arrays, to keep history of retries
  let transfer: Transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    auroraEvmAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
    auroraChainId: options.auroraChainId ?? bridgeParams.auroraChainId,
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
    etherExitToEthereumPrecompile?: string
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
      `Wrong aurora network for burn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const safeReorgHeight = await provider.getBlockNumber() - 20
  const exitToEthereumData = '0x00' + transfer.recipient.slice(2)
  let txHash
  if (typeof window !== 'undefined') {
    // MetaMask
    txHash = await provider.send('eth_sendTransaction', [{
      from: transfer.sender,
      to: options.etherExitToEthereumPrecompile ?? bridgeParams.etherExitToEthereumPrecompile,
      value: ethers.BigNumber.from(transfer.amount).toHexString(),
      data: exitToEthereumData,
      gas: ethers.BigNumber.from(121000).toHexString()
    }])
  } else {
    // Ethers signer
    const transaction = await options.signer?.sendTransaction({
      from: transfer.sender,
      to: options.etherExitToEthereumPrecompile ?? bridgeParams.etherExitToEthereumPrecompile,
      value: ethers.BigNumber.from(transfer.amount),
      data: exitToEthereumData,
      gasLimit: ethers.BigNumber.from(121000)
    })
    txHash = transaction!.hash
  }
  let pendingBurnTx = null
  while (!pendingBurnTx) {
    try {
      await new Promise(resolve => setTimeout(resolve, 1000))
      pendingBurnTx = await provider.getTransaction(txHash)
    } catch (error) {
      console.log(error)
    }
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to!,
      data: pendingBurnTx.data,
      nonce: pendingBurnTx.nonce,
      value: pendingBurnTx.value.toString(),
      safeReorgHeight
    },
    burnHashes: [...transfer.burnHashes, txHash]
  }
}

export async function checkBurn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    auroraChainId?: number
    auroraRelayerAccount?: string
    nearAccount?: Account
    nearProvider?: najProviders.Provider
    nep141Factory?: string
    etherNep141Factory?: string
    etherNep141FactoryMigrationHeight?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraCloudProvider({ auroraEvmAccount: transfer.auroraEvmAccount })

  const burnHash = last(transfer.burnHashes)

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.auroraChainId ?? transfer.auroraChainId ?? bridgeParams.auroraChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong aurora network for checkBurn, expected: ${expectedChainId}, got: ${ethChainId}`
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
        to: transfer.ethCache.to,
        value: transfer.ethCache.value
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

  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  const nearBurnTx = await nearProvider.txStatus(
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
  if (transfer.symbol !== 'ETH') {
    // Withdraw native currency from a silo which doesn't use ETH as native currency
    const nep141Factory = options.nep141Factory ?? bridgeParams.nep141Factory
    nearBurnReceipt = await parseNep141BurnReceipt(nearBurnTx, nep141Factory, nearProvider)
  } else {
    const etherNep141Factory = await selectEtherNep141Factory({
      etherNep141FactoryMigrationHeight: options.etherNep141FactoryMigrationHeight ?? bridgeParams.etherNep141FactoryMigrationHeight,
      etherNep141Factory: options.etherNep141Factory ?? bridgeParams.etherNep141Factory,
      auroraEvmAccount: bridgeParams.auroraEvmAccount,
      // @ts-expect-error
      blockHash: nearBurnTx.transaction_outcome.block_hash,
      nearProvider
    })
    nearBurnReceipt = await parseETHBurnReceipt(nearBurnTx, etherNep141Factory, nearProvider)
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    startTime: new Date(nearBurnReceipt.blockTimestamp / 10 ** 6).toISOString(),
    burnReceipts: [...transfer.burnReceipts, burnReceipt],
    nearBurnHashes: [...transfer.nearBurnHashes, nearBurnHash],
    nearBurnReceiptIds: [...transfer.nearBurnReceiptIds, nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [...transfer.nearBurnReceiptBlockHeights, nearBurnReceipt.blockHeight]
  }
}

/**
 * Wait for a final block with a strictly greater height than nearBurnTx
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
  const burnReceiptBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearProvider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= burnReceiptBlockHeight) {
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

  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  if (nearOnEthClientBlockHeight > burnBlockHeight) {
    const etherNep141FactoryMigrationHeight = options.etherNep141FactoryMigrationHeight ?? bridgeParams.etherNep141FactoryMigrationHeight
    const etherNep141Factory = burnBlockHeight >= etherNep141FactoryMigrationHeight
      ? (options.etherNep141Factory ?? bridgeParams.etherNep141Factory)
      : bridgeParams.auroraEvmAccount
    proof = await findNearProof(
      last(transfer.nearBurnReceiptIds),
      // NOTE: If another token than ETH is being transfered with @near-eth/aurora-ether it means that ETH is not the silo's native currency
      transfer.symbol !== 'ETH'
        ? bridgeParams.nep141Factory
        : etherNep141Factory,
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
 * Unlock tokens stored in the contract at process.env.etherCustodianAddress,
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

  // Unlock
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
  // TODO: Handle erc20Locker.unlockToken when ETH is not the native silo token.

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
