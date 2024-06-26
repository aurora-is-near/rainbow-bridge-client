import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { Account, providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { getEthProvider, getSignerProvider, getNearProvider, formatLargeNum, getBridgeParams } from '@near-eth/client/dist/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { ethOnNearSyncHeight, findEthProof, findFinalizationTxOnNear, ExplorerIndexerResult } from '@near-eth/utils'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-ether/natural-ether/sendToAurora'

const LOCK = 'lock-natural-ether-to-aurora'
const SYNC = 'sync-natural-ether-to-aurora'
const MINT = 'mint-natural-ether-to-aurora'

const steps = [
  LOCK,
  SYNC,
  MINT
]

export interface TransferDraft extends TransferStatus {
  type: string
  lockHashes: string[]
  lockReceipts: ethers.providers.TransactionReceipt[]
  mintHashes: string[]
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
  etherCustodianAddress?: string
  etherCustodianAbi?: string
  auroraEvmAccount?: string
  sendToNearSyncInterval?: number
  nearEventRelayerMargin?: number
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  maxFindEthProofInterval?: number
  nearClientAccount?: string
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
  lockHashes: [],
  lockReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  mintHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from Ethereum`,
      [SYNC]: `Wait for ${transfer.neededConfirmations} transfer confirmations for security`,
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in Aurora`
    }),
    statusMessage: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Ethereum'
          case SYNC: return 'Ready to deposit in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transferring to Aurora'
        case LOCK: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations}`
        case SYNC: return 'Depositing in Aurora'
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
    case LOCK: return await checkSync(transfer)
    // case SYNC: return mint(transfer) // Not implemented, done by relayer
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param transfer Transfer object to check status on.
 */
export async function checkStatus (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await checkLock(transfer)
    case LOCK: return await checkSync(transfer)
    // case SYNC: return checkMint(transfer) // Not implemented, done by relayer
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
      etherCustodianAddress?: string
      etherCustodianAbi?: string
      etherCustodianProxyAddress?: string
      etherCustodianProxyAbi?: string
      auroraEvmAccount?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const etherCustodians: [string, string][] = [
    [options.etherCustodianProxyAddress ?? bridgeParams.etherCustodianProxyAddress,
      options.etherCustodianProxyAbi ?? bridgeParams.etherCustodianProxyAbi],
    [options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
      options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi]
  ]
  const auroraAddress = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount as string + ':'

  const promises = etherCustodians.map(async ([ethCustodianAddress, ethCustodianAbi]) => {
    const ethTokenLocker = new ethers.Contract(
      ethCustodianAddress,
      ethCustodianAbi,
      provider
    )
    const filter = ethTokenLocker.filters.Deposited!(sender)
    const events = await ethTokenLocker.queryFilter(filter, fromBlock, toBlock)
    return events.filter(event => event.args!.recipient.startsWith(auroraAddress)).map(event => event.transactionHash)
  })

  const transactions = await Promise.all(promises)
  return transactions.flat()
}

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
 * Recover transfer from a lock tx hash
 * @param lockTxHash Ethereum transaction hash which initiated the transfer.
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  lockTxHash: string,
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const receipt = await provider.getTransactionReceipt(lockTxHash)
  const ethTokenLocker = new ethers.Contract(
    options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
    options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi,
    provider
  )
  const filter = ethTokenLocker.filters.Deposited!()
  const events = await ethTokenLocker.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const lockedEvent = events.find(event => event.transactionHash === lockTxHash)
  if (!lockedEvent) {
    throw new Error('Unable to process lock transaction event.')
  }
  const sender = lockedEvent.args!.sender
  const protocolMessage = lockedEvent.args!.recipient
  const [auroraAddress, auroraRecipient]: [auroraAddress: string, auroraRecipient: string] = protocolMessage.split(':')
  if (auroraAddress !== (options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount)) {
    throw new Error('Failed to parse auroraEvmAccount in protocol message')
  }
  if (!/^(0x)?([A-Fa-f0-9]{40})$/.test(auroraRecipient)) {
    throw new Error('Failed to parse recipient in protocol message')
  }
  const amount = lockedEvent.args!.amount.toString()
  const symbol = 'ETH'
  const sourceToken = symbol
  const sourceTokenName = symbol
  const destinationTokenName = 'a' + symbol
  const decimals = 18

  const txBlock = await lockedEvent.getBlock()

  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient: '0x' + auroraRecipient,
    sender,
    sourceToken,
    sourceTokenName,
    symbol,
    decimals,
    auroraEvmAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
    status: status.IN_PROGRESS,
    lockHashes: [lockTxHash],
    lockReceipts: [receipt]
  }
  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Ethereum to Aurora by locking tokens.
 * Broadcasts the lock transaction and creates a transfer object.
 * The receipt will be fetched by checkStatus.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Aurora address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol ERC-20 symbol (ETH if not provided).
 * @param params.options.decimals ERC-20 decimals (18 if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.ethChainId Ethereum chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.etherCustodianProxyAddress Rainbow bridge ether custodian proxy address.
 * @param params.options.etherCustodianProxyAbi Rainbow bridge ether custodian proxy abi.
 * @param params.options.auroraEvmAccount Aurora Cloud silo account on NEAR.
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
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      etherCustodianProxyAddress?: string
      etherCustodianProxyAbi?: string
      auroraEvmAccount?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  const symbol = options.symbol ?? 'ETH'
  const sourceToken = symbol
  const sourceTokenName = symbol
  const decimals = options.decimals ?? 18
  const destinationTokenName = 'a' + symbol

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
    sourceToken,
    sourceTokenName,
    auroraEvmAccount: options.auroraEvmAccount ?? getBridgeParams().auroraEvmAccount,
    symbol,
    decimals
  }

  transfer = await lock(transfer, options)

  if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer

  return transfer
}

/**
 * Initiate "lock" transaction.
 * Only wait for transaction to have dependable transactionHash created. Avoid
 * blocking to wait for transaction to be mined. Status of transactionHash
 * being mined is then checked in checkStatus.
 */
export async function lock (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    ethChainId?: number
    etherCustodianProxyAddress?: string
    etherCustodianProxyAbi?: string
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
      `Wrong eth network for lock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const ethTokenLocker = new ethers.Contract(
    options.etherCustodianProxyAddress ?? bridgeParams.etherCustodianProxyAddress,
    options.etherCustodianProxyAbi ?? bridgeParams.etherCustodianProxyAbi,
    options.signer ?? provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20

  const auroraEvmAccount: string = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount ?? 'aurora'
  const pendingLockTx = await ethTokenLocker.depositToNear(
    `${auroraEvmAccount}:${transfer.recipient.slice(2).toLowerCase()}`, 0, { value: transfer.amount }
  )

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingLockTx.from,
      to: pendingLockTx.to,
      nonce: pendingLockTx.nonce,
      data: pendingLockTx.data,
      value: pendingLockTx.value.toString(),
      safeReorgHeight
    },
    lockHashes: [...transfer.lockHashes, pendingLockTx.hash]
  }
}

export async function checkLock (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    ethChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const lockHash = last(transfer.lockHashes)
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkLock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  let lockReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(lockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!lockReceipt) {
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        data: transfer.ethCache.data,
        value: transfer.ethCache.value
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      lockReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!lockReceipt) return transfer

  if (!lockReceipt.status) {
    const error = `Transaction failed: ${lockReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      lockReceipts: [...transfer.lockReceipts, lockReceipt]
    }
  }
  if (lockReceipt.transactionHash !== lockHash) {
    // Record the replacement tx lockHash
    transfer = {
      ...transfer,
      lockHashes: [...transfer.lockHashes, lockReceipt.transactionHash]
    }
  }

  const txBlock = await provider.getBlock(lockReceipt.blockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    lockReceipts: [...transfer.lockReceipts, lockReceipt]
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
  const lockReceipt = last(transfer.lockReceipts)
  const eventEmittedAt = lockReceipt.blockNumber
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
      'Deposited',
      lockReceipt.transactionHash,
      options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
      options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi,
      provider
    )
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      // NOTE: options.auroraEvmAccount cannot be used because checkSync can be called by recover using a different silo's auroraEvmAccount.
      account_id: bridgeParams.auroraEvmAccount,
      method_name: 'is_used_proof',
      args_base64: Buffer.from(proof).toString('base64'),
      finality: 'optimistic'
    })
    const proofAlreadyUsed = Boolean(result.result[0])
    if (proofAlreadyUsed) {
      if (options.callIndexer) {
        try {
          const { transactions, timestamps } = await findFinalizationTxOnNear({
            proof: Buffer.from(proof).toString('base64'),
            connectorAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
            eventRelayerAccount: options.eventRelayerAccount ?? bridgeParams.eventRelayerAccount,
            finalizationMethod: 'deposit',
            ethTxHash: lockReceipt.transactionHash,
            callIndexer: options.callIndexer
          })
          let finishTime: string | undefined
          if (timestamps.length > 0) {
            finishTime = new Date(timestamps[0]! / 10 ** 6).toISOString()
          }
          transfer = {
            ...transfer,
            finishTime,
            mintHashes: [...transfer.mintHashes, ...transactions]
          }
        } catch (error) {
          // Not finding the finalization tx should not prevent processing/recovering the transfer.
          console.error(error)
        }
      }
      return {
        ...transfer,
        completedStep: MINT,
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

  /*
  // TODO: uncomment this when manual transfer finalization becomes available on aurora.dev
  if (completedConfirmations < transfer.neededConfirmations + Number(process.env.nearEventRelayerMargin)) {
    // Leave some time for the relayer to finalize
    return {
      ...transfer,
      completedConfirmations,
      status: status.IN_PROGRESS
    }
  }

  return {
    ...transfer,
    completedConfirmations,
    completedStep: SYNC,
    status: status.ACTION_NEEDED,
    proof // used when checkSync() is called by mint()
  }
  */
}
const last = (arr: any[]): any => arr[arr.length - 1]
