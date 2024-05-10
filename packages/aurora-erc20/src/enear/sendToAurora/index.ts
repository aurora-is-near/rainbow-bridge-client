import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { Account, providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getNearProvider, formatLargeNum, getSignerProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { ethOnNearSyncHeight, findEthProof, findFinalizationTxOnNear, ExplorerIndexerResult } from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-erc20/enear/sendToAurora'

const BURN = 'burn-e-near-to-aurora-wnear'
const SYNC = 'sync-e-near-to-aurora-wnear'
const UNLOCK = 'unlock-e-near-to-aurora-wnear'

const steps = [
  BURN,
  SYNC,
  UNLOCK
]

export interface TransferDraft extends TransferStatus {
  type: string
  burnHashes: string[]
  burnReceipts: ethers.providers.TransactionReceipt[]
  unlockHashes: string[]
  completedConfirmations: number
  neededConfirmations: number
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
}
export interface TransferOptions {
  provider?: ethers.providers.JsonRpcProvider
  eNEARAddress?: string
  eNEARAbi?: string
  nativeNEARLockerAddress?: string
  sendToNearSyncInterval?: number
  nearEventRelayerMargin?: number
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  maxFindEthProofInterval?: number
  nearClientAccount?: string
  auroraEvmAccount?: string
  callIndexer?: (query: string) => Promise<ExplorerIndexerResult[] | string>
  eventRelayerAccount?: string
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
  // decimals,
  status: status.ACTION_NEEDED,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  completedConfirmations: 0,
  burnHashes: [],
  burnReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  unlockHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from Ethereum`,
      [SYNC]: `Wait for ${transfer.neededConfirmations + Number(getBridgeParams().nearEventRelayerMargin)} transfer confirmations for security`,
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in Aurora`
    }),
    statusMessage: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Ethereum'
          case SYNC: return 'Ready to deposit in Aurora'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transferring to Aurora'
        case BURN: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations}`
        case SYNC: return 'Depositing in Aurora'
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
    case BURN: return await checkSync(transfer)
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
    case BURN: return await checkSync(transfer)
    // case SYNC: return await checkUnlock(transfer) // Not implemented, done by relayer
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Find all burn transactions sending eNEAR back to NEAR (Aurora).
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.options Optional arguments.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.eNEARAddress ERC-20 NEAR on Ethereum address.
 * @param params.options.eNEARAbi ERC-20 NEAR on Ethereum abi.
 * @param params.options.auroraEvmAccount Aurora silo account.
 * @returns Array of Ethereum transaction hashes.
 */
export async function findAllTransactions (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: {
      provider?: ethers.providers.Provider
      eNEARAddress?: string
      eNEARAbi?: string
      auroraEvmAccount?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const ethTokenLocker = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    provider
  )
  const filter = ethTokenLocker.filters.TransferToNearInitiated!(sender)
  const events = await ethTokenLocker.queryFilter(filter, fromBlock, toBlock)
  const auroraAddress = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount as string + ':'
  return events.filter(event => event.args!.accountId.startsWith(auroraAddress)).map(event => event.transactionHash)
}

/**
 * Recover all transfers sending eNEAR back to NEAR (Aurora).
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.options TransferOptions.
 * @returns Array of recovered transfers.
 */
export async function findAllTransfers (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: TransferOptions
  }
): Promise<Transfer[]> {
  const lockTransactions = await findAllTransactions({ fromBlock, toBlock, sender, options })
  const transfers = await Promise.all(lockTransactions.map(async (tx) => await recover(tx, options)))
  return transfers
}

/**
 * Recover transfer from a burn tx hash
 * Track a new transfer at the completedStep = BURN so that it can be unlocked
 * @param burnTxHash Ethereum transaction hash which initiated the transfer.
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  burnTxHash: string,
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const receipt = await provider.getTransactionReceipt(burnTxHash)
  const eNEAR = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    provider
  )
  const filter = eNEAR.filters.TransferToNearInitiated!()
  const events = await eNEAR.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const burnEvent = events.find(event => event.transactionHash === burnTxHash)
  if (!burnEvent) {
    throw new Error('Unable to process burn transaction event.')
  }
  const erc20Address = options.eNEARAddress ?? bridgeParams.eNEARAddress
  const amount = burnEvent.args!.amount.toString()
  const sender = burnEvent.args!.sender
  const protocolMessage = burnEvent.args!.accountId
  const [auroraAddress, auroraRecipient]: [auroraEvmAccount: string, auroraRecipient: string] = protocolMessage.split(':')
  if (auroraAddress !== (options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount)) {
    throw new Error('Failed to parse auroraEvmAccount in protocol message')
  }
  if (!/^(0x)?([A-Fa-f0-9]{40})$/.test(auroraRecipient)) {
    throw new Error('Failed to parse recipient in protocol message')
  }
  const symbol = 'NEAR'
  const sourceTokenName = symbol
  const decimals = 24
  const destinationTokenName = symbol

  const txBlock = await burnEvent.getBlock()

  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    amount: amount.toString(),
    completedStep: BURN,
    destinationTokenName,
    recipient: '0x' + auroraRecipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    symbol,
    decimals,
    auroraEvmAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
    status: status.IN_PROGRESS,
    burnHashes: [burnTxHash],
    burnReceipts: [receipt]
  }
  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Ethereum to Aurora by burning bridged eNEAR tokens.
 * Broadcasts the burn transaction and creates a transfer object.
 * The receipt will be fetched by checkStatus.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient NEAR address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.ethChainId Ethereum chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.eNEARAddress ERC-20 NEAR on Ethereum address.
 * @param params.options.eNEARAbi ERC-20 NEAR on Ethereum abi.
 * @param params.options.auroraEvmAccount Aurora Cloud silo account on NEAR.
 * @param params.options.signer Ethers signer to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      sender?: string
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      eNEARAddress?: string
      eNEARAbi?: string
      auroraEvmAccount?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()
  const symbol = 'NEAR'
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = 24
  const signer = options.signer ?? provider.getSigner()
  const sender = options.sender ?? (await signer.getAddress()).toLowerCase()

  // various attributes stored as arrays, to keep history of retries
  let transfer: Transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: options.eNEARAddress ?? bridgeParams.eNEARAddress,
    sourceTokenName,
    auroraEvmAccount: options.auroraEvmAccount ?? getBridgeParams().auroraEvmAccount,
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
    ethChainId?: number
    eNEARAddress?: string
    eNEARAbi?: string
    auroraEvmAccount?: string
    signer?: ethers.Signer
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong eth network for burn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const ethTokenLocker = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    options.signer ?? provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const auroraEvmAccount: string = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingBurnTx = await ethTokenLocker.transferToNear(
    transfer.amount,
    auroraEvmAccount + ':' + transfer.recipient.slice(2)
  )

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to,
      safeReorgHeight,
      data: pendingBurnTx.data,
      nonce: pendingBurnTx.nonce
    },
    burnHashes: [...transfer.burnHashes, pendingBurnTx.hash]
  }
}

export async function checkBurn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    ethChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const burnHash = last(transfer.burnHashes)
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkBurn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  let burnReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(burnHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
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
      burnReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!burnReceipt.status) {
    const error = `Transaction failed: ${burnReceipt.transactionHash}`
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
      burnHashes: [...transfer.burnHashes, burnReceipt.transactionHash]
    }
  }

  const txBlock = await provider.getBlock(burnReceipt.blockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    burnReceipts: [...transfer.burnReceipts, burnReceipt]
  }
}

export async function checkSync (
  transfer: Transfer | string,
  options?: TransferOptions
): Promise<Transfer> {
  if (typeof transfer === 'string') {
    return await recover(transfer, options)
  }
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()

  if (!transfer.checkSyncInterval) {
    // checkSync every 20s: reasonable value to show the confirmation counter x/30
    transfer = {
      ...transfer,
      checkSyncInterval: options.sendToNearSyncInterval ?? bridgeParams.sendToNearSyncInterval
    }
  }
  if (transfer.nextCheckSyncTimestamp && new Date() < new Date(transfer.nextCheckSyncTimestamp)) {
    return transfer
  }
  const burnReceipt = last(transfer.burnReceipts)
  const eventEmittedAt = burnReceipt.blockNumber
  const syncedTo = await ethOnNearSyncHeight(
    options.nearClientAccount ?? bridgeParams.nearClientAccount,
    nearProvider
  )
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)
  let proof
  let newCheckSyncInterval = transfer.checkSyncInterval

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'TransferToNearInitiated',
      burnReceipt.transactionHash,
      options.eNEARAddress ?? bridgeParams.eNEARAddress,
      options.eNEARAbi ?? bridgeParams.eNEARAbi,
      provider
    )
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      account_id: options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
      method_name: 'is_used_proof',
      args_base64: Buffer.from(proof).toString('base64'),
      finality: 'optimistic'
    })
    const proofAlreadyUsed = JSON.parse(Buffer.from(result.result).toString())
    if (proofAlreadyUsed) {
      if (options.callIndexer) {
        try {
          const { transactions, timestamps } = await findFinalizationTxOnNear({
            proof: Buffer.from(proof).toString('base64'),
            connectorAccount: options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
            eventRelayerAccount: options.eventRelayerAccount ?? bridgeParams.eventRelayerAccount,
            finalizationMethod: 'finalise_eth_to_near_transfer',
            ethTxHash: burnReceipt.transactionHash,
            callIndexer: options.callIndexer
          })
          let finishTime: string | undefined
          if (timestamps.length > 0) {
            finishTime = new Date(timestamps[0]! / 10 ** 6).toISOString()
          }
          transfer = {
            ...transfer,
            finishTime,
            unlockHashes: [...transfer.unlockHashes, ...transactions]
          }
        } catch (error) {
          // Not finding the finalization tx should not prevent processing/recovering the transfer.
          console.error(error)
        }
      }
      return {
        ...transfer,
        completedStep: UNLOCK,
        completedConfirmations,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Transfer already finalized.']
      }
    }
    // Increase the interval for the next findEthProof call.
    const maxFindEthProofInterval = options.maxFindEthProofInterval ?? bridgeParams.maxFindEthProofInterval
    newCheckSyncInterval = transfer.checkSyncInterval! * 2 > maxFindEthProofInterval ? transfer.checkSyncInterval : transfer.checkSyncInterval! * 2
  }
  return {
    ...transfer,
    nextCheckSyncTimestamp: new Date(Date.now() + newCheckSyncInterval!),
    checkSyncInterval: newCheckSyncInterval,
    completedConfirmations,
    status: status.IN_PROGRESS
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
