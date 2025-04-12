import {
  borshifyOutcomeProof,
  nearOnEthSyncHeight,
  findNearProof,
  findFinalizationTxOnEthereum,
  parseNEARLockReceipt
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
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { BURN_SIGNATURE } from '@near-eth/utils/dist/aurora'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/aurora-erc20/wnear/sendToEthereum'

const BURN = 'burn-aurora-wnear-to-enear'
const AWAIT_FINALITY = 'await-finality-aurora-wnear-to-enear'
const SYNC = 'sync-aurora-wnear-to-enear'
const MINT = 'mint-aurora-wnear-to-enear'

const steps = [
  BURN,
  AWAIT_FINALITY,
  SYNC,
  MINT
]

class TransferError extends Error {}

export interface TransferDraft extends TransferStatus {
  type: string
  finalityBlockHeights: number[]
  nearOnEthClientBlockHeight: null | number
  mintHashes: string[]
  mintReceipts: ethers.providers.TransactionReceipt[]
  burnHashes: string[]
  burnReceipts: string[]
  nearLockHashes: string[]
  nearLockReceiptIds: string[]
  nearLockReceiptBlockHeights: number[]
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
  auroraChainId?: number
}

export interface TransferOptions {
  provider?: ethers.providers.JsonRpcProvider
  auroraProvider?: ethers.providers.JsonRpcProvider
  erc20LockerAddress?: string
  erc20LockerAbi?: string
  erc20Abi?: string
  sendToEthereumSyncInterval?: number
  ethChainId?: number
  auroraChainId?: number
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  ethClientAddress?: string
  ethClientAbi?: string
  nativeNEARLockerAddress?: string
  eNEARAddress?: string
  eNEARAbi?: string
  wNearBridgeAddress?: string
  wNearBridgeAbi?: string
  auroraEvmAccount?: string
  signer?: ethers.Signer
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
  nearLockHashes: [],
  nearLockReceiptIds: [],
  nearLockReceiptBlockHeights: [],
  mintHashes: [],
  mintReceipts: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from Aurora`,
      [AWAIT_FINALITY]: 'Confirming in Aurora',
      [SYNC]: 'Confirming in Aurora. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in Ethereum`
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
    case null: return await burn(transfer, options)
    case AWAIT_FINALITY: return await checkSync(transfer, options)
    case SYNC: return await mint(transfer, options)
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
    case SYNC: return await checkMint(transfer)
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
      wNearBridgeAddress?: string
      wNearBridgeAbi?: string
      auroraEvmAccount?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraCloudProvider({ auroraEvmAccount: options.auroraEvmAccount })
  const wNearBridge = new ethers.Contract(
    options.wNearBridgeAddress ?? bridgeParams.wNearBridgeAddresses?.[options.auroraEvmAccount ?? 'aurora'],
    options.wNearBridgeAbi ?? bridgeParams.wNearBridgeAbi,
    provider
  )
  const filterBurns = wNearBridge.filters.InitBridgeToEthereum!(sender)
  const events = await wNearBridge.queryFilter(filterBurns, fromBlock, toBlock)
  const receipts = await Promise.all(events.map(async (event) => {
    const receipt = await provider.getTransactionReceipt(event.transactionHash)
    return receipt
  }))
  return receipts.map(r => r.transactionHash)
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
  options?: TransferOptions
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
  const nearLockHash = bs58.encode(decodedTxHash)

  const wNearBridge = new ethers.Contract(
    options.wNearBridgeAddress ?? bridgeParams.wNearBridgeAddresses?.[options.auroraEvmAccount ?? 'aurora'],
    options.wNearBridgeAbi ?? bridgeParams.wNearBridgeAbi,
    auroraProvider
  )
  const filter = wNearBridge.filters.InitBridgeToEthereum!()
  const events = await wNearBridge.queryFilter(filter, auroraBurnReceipt.blockNumber, auroraBurnReceipt.blockNumber)
  const burnEvent = events.find(event => event.transactionHash === burnTxHash)
  if (!burnEvent) {
    throw new Error('Unable to process lock transaction event.')
  }
  const auroraSender = burnEvent.args!.sender
  const recipient = burnEvent.args!.recipient
  const amount = burnEvent.args!.amount.toString()

  const sourceToken = auroraBurnReceipt.logs.find(
    (log: ethers.providers.Log) => log.topics[0] === BURN_SIGNATURE
  ).address.toLowerCase()

  const nearLockTx = await nearProvider.txStatus(decodedTxHash, sender)

  // @ts-expect-error
  if (nearLockTx.status.Unknown) {
    throw new Error(`Withdraw transaction pending: ${burnTxHash}`)
  }

  // @ts-expect-error
  if (nearLockTx.status.Failure) {
    throw new Error(`Withdraw transaction failed: ${burnTxHash}`)
  }

  const nearLockReceipt = await parseNEARLockReceipt(
    nearLockTx,
    options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
    nearProvider
  )
  const symbol = 'NEAR'
  const sourceTokenName = symbol
  const destinationTokenName = 'NEAR'
  const decimals = 24

  // @ts-expect-error
  const txBlock = await nearProvider.block({ blockId: nearLockTx.transaction_outcome.block_hash })

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
    auroraEvmAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
    auroraChainId: options.auroraChainId ?? bridgeParams.auroraChainId,
    burnHashes: [burnTxHash],
    nearLockHashes: [nearLockHash],
    nearLockReceiptIds: [nearLockReceipt.id],
    nearLockReceiptBlockHeights: [nearLockReceipt.blockHeight]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Aurora to Ethereum by burning minted tokens.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.wNearAddress ERC-20 address of the bridged wNEAR to transfer.
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Ethereum address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol ERC-20 symbol (queried if not provided).
 * @param params.options.decimals ERC-20 decimals (queried if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.auroraChainId Aurora chain id of the bridge.
 * @param params.options.wNearBridgeAbi wNEAR bridge abi to call bridgeToEthereum with XCC.
 * @param params.options.wNearBridgeAddress Contract address of wNEAR bridge to call bridgeToEthereum with XCC.
 * @param params.options.auroraEvmAccount Aurora Cloud silo account on NEAR.
 * @param params.options.provider Aurora provider to use.
 * @param params.options.nearProvider NEAR provider.
 * @param params.options.signer Ethers signer to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { wNearAddress, amount, recipient, options }: {
    wNearAddress: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      sender?: string
      auroraChainId?: number
      wNearBridgeAbi?: string
      wNearBridgeAddress?: string
      auroraEvmAccount?: string
      provider?: ethers.providers.JsonRpcProvider
      nearProvider?: najProviders.Provider
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  const symbol = 'NEAR'
  const sourceTokenName = symbol
  const destinationTokenName = 'NEAR'
  const decimals = 24

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
    sourceToken: wNearAddress,
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

export async function burn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    auroraChainId?: number
    wNearBridgeAbi?: string
    wNearBridgeAddress?: string
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

  const wNearBridge = new ethers.Contract(
    options.wNearBridgeAddress ?? bridgeParams.wNearBridgeAddresses?.[transfer.auroraEvmAccount ?? 'aurora'],
    options.wNearBridgeAbi ?? bridgeParams.wNearBridgeAbi,
    options.signer ?? provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingBurnTx = await wNearBridge.bridgeToEthereum(
    transfer.recipient,
    transfer.amount,
    { gasLimit: 1000000 }
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
    nearProvider?: najProviders.Provider
    nativeNEARLockerAddress?: string
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
  const nearLockHash = bs58.encode(decodedTxHash)

  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  const nearLockTx = await nearProvider.txStatus(
    decodedTxHash, options.auroraRelayerAccount ?? bridgeParams.auroraRelayerAccount
  )

  // @ts-expect-error
  if (nearLockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error
  if (nearLockTx.status.Failure) {
    const error = 'NEAR relay.aurora transaction failed.'
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED
    }
  }

  let nearLockReceipt
  try {
    nearLockReceipt = await parseNEARLockReceipt(
      nearLockTx,
      options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
      nearProvider
    )
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

  // @ts-expect-error
  const txBlock = await nearProvider.block({ blockId: nearLockTx.transaction_outcome.block_hash })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    startTime: new Date(txBlock.header.timestamp / 10 ** 6).toISOString(),
    burnReceipts: [...transfer.burnReceipts, burnReceipt],
    nearLockHashes: [...transfer.nearLockHashes, nearLockHash],
    nearLockReceiptIds: [...transfer.nearLockReceiptIds, nearLockReceipt.id],
    nearLockReceiptBlockHeights: [...transfer.nearLockReceiptBlockHeights, nearLockReceipt.blockHeight]
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

  const withdrawReceiptBlockHeight = last(transfer.nearLockReceiptBlockHeights)
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

  const burnBlockHeight = last(transfer.nearLockReceiptBlockHeights)
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
    proof = await findNearProof(
      last(transfer.nearLockReceiptIds),
      options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
      nearOnEthClientBlockHeight,
      nearProvider,
      provider,
      options.ethClientAddress ?? bridgeParams.ethClientAddress,
      options.ethClientAbi ?? bridgeParams.ethClientAbi
    )
    if (await proofAlreadyUsed(
      provider,
      proof,
      options.eNEARAddress ?? bridgeParams.eNEARAddress,
      options.eNEARAbi ?? bridgeParams.eNEARAbi
    )) {
      try {
        const { transactions, block } = await findFinalizationTxOnEthereum({
          usedProofPosition: '8',
          proof,
          connectorAddress: options.eNEARAddress ?? bridgeParams.eNEARAddress,
          connectorAbi: options.eNEARAbi ?? bridgeParams.eNEARAbi,
          finalizationEvent: 'NearToEthTransferFinalised',
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

/**
 * Check if a NEAR outcome receipt_id has already been used to finalize a transfer to Ethereum.
 */
export async function proofAlreadyUsed (provider: ethers.providers.Provider, proof: any, eNEARAddress: string, eNEARAbi: string): Promise<boolean> {
  const eNEAR = new ethers.Contract(
    eNEARAddress,
    eNEARAbi,
    provider
  )
  const proofIsUsed = await eNEAR.usedProofs('0x' + bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex'))
  return proofIsUsed
}

/**
 * Mint eNEAR tokens,
 * passing the proof that the tokens were locked in the corresponding
 * NEAR BridgeToken contract.
 */
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

  // Build burn proof
  transfer = await checkSync(transfer, options)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  // Mint
  const borshProof = borshifyOutcomeProof(proof)

  const eNEAR = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    options.signer ?? provider.getSigner()
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
      nonce: pendingMintTx.nonce,
      data: pendingMintTx.data,
      safeReorgHeight
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

  const unlockHash = last(transfer.mintHashes)
  let mintReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(unlockHash)

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

  if (mintReceipt.transactionHash !== unlockHash) {
    // Record the replacement tx unlockHash
    transfer = {
      ...transfer,
      mintHashes: [...transfer.mintHashes, mintReceipt.transactionHash]
    }
  }

  const block = await provider.getBlock(mintReceipt.blockNumber)

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: MINT,
    finishTime: new Date(block.timestamp * 1000).toISOString(),
    mintReceipts: [...transfer.mintReceipts, mintReceipt]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
