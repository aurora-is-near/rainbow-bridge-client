import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { Account, providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'
import { getEthProvider, getSignerProvider, getNearProvider, formatLargeNum, getBridgeParams } from '@near-eth/client/dist/utils'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { ethOnNearSyncHeight, findEthProof, findFinalizationTxOnNear, ExplorerIndexerResult } from '@near-eth/utils'
import { getDecimals, getSymbol } from '../getMetadata'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-erc20/natural-erc20/sendToAurora'

// APPROVE step is only used in checkApprove(), but transfers are only recorded at lock step
const APPROVE = 'approve-natural-erc20-to-aurora'
const LOCK = 'lock-natural-erc20-to-aurora'
const SYNC = 'sync-natural-erc20-to-aurora'
const MINT = 'mint-natural-erc20-to-aurora'

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

export interface ApprovalInfo extends TransactionInfo, TransferStatus {
  approvalHashes: string[]
  approvalReceipts: ethers.providers.TransactionReceipt[]
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
  erc20LockerAddress?: string
  erc20LockerAbi?: string
  erc20Abi?: string
  sendToNearSyncInterval?: number
  nep141Factory?: string
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
          case SYNC: return 'Ready to deposit in Aurora'
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
  { fromBlock, toBlock, sender, erc20Address, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    erc20Address: string
    options?: {
      provider?: ethers.providers.Provider
      erc20LockerAddress?: string
      erc20LockerAbi?: string
      auroraEvmAccount?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const ethTokenLocker = new ethers.Contract(
    options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
    options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
    provider
  )
  const filter = ethTokenLocker.filters.Locked!(erc20Address, sender)
  const events = await ethTokenLocker.queryFilter(filter, fromBlock, toBlock)
  const auroraAddress = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount as string + ':'
  return events.filter(event => event.args!.accountId.startsWith(auroraAddress)).map(event => event.transactionHash)
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
  const lockTransactions = await findAllTransactions({ fromBlock, toBlock, sender, erc20Address, options })
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
  options?: TransferOptions & {
    decimals?: number
    symbol?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const receipt = await provider.getTransactionReceipt(lockTxHash)
  const ethTokenLocker = new ethers.Contract(
    options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
    options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
    provider
  )
  const filter = ethTokenLocker.filters.Locked!()
  const events = await ethTokenLocker.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const lockedEvent = events.find(event => event.transactionHash === lockTxHash)
  if (!lockedEvent) {
    throw new Error('Unable to process lock transaction event.')
  }
  const erc20Address = lockedEvent.args!.token
  const amount = lockedEvent.args!.amount.toString()
  const sender = lockedEvent.args!.sender
  const protocolMessage = lockedEvent.args!.accountId
  const [auroraAddress, auroraRecipient]: [auroraEvmAccount: string, auroraRecipient: string] = protocolMessage.split(':')
  if (auroraAddress !== (options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount)) {
    throw new Error('Failed to parse auroraEvmAccount in protocol message')
  }
  if (!/^(0x)?([A-Fa-f0-9]{40})$/.test(auroraRecipient)) {
    throw new Error('Failed to parse recipient in protocol message')
  }
  const symbol: string = options.symbol ?? await getSymbol({ erc20Address, options })
  const decimals = options.decimals ?? await getDecimals({ erc20Address, options })
  const destinationTokenName = 'a' + symbol
  const sourceTokenName = symbol

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
    sourceToken: erc20Address,
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
 * Allowance must be enough before tokens can be transfered.
 * Use `approve` to allow spending of ERC-20 tokens.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address ERC-20 address of token to transfer.
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient NEAR address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol ERC-20 symbol (queried if not provided).
 * @param params.options.decimals ERC-20 decimals (queried if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.ethChainId Ethereum chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.erc20LockerAddress Rainbow bridge ERC-20 token locker address.
 * @param params.options.erc20LockerAbi Rainbow bridge ERC-20 token locker abi.
 * @param params.options.erc20Abi Standard ERC-20 token abi.
 * @param params.options.auroraEvmAccount Aurora Cloud silo account on NEAR.
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
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      erc20LockerAddress?: string
      erc20LockerAbi?: string
      erc20Abi?: string
      auroraEvmAccount?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  const symbol: string = options.symbol ?? await getSymbol({ erc20Address, options })
  const sourceTokenName = symbol
  const destinationTokenName = 'a' + symbol
  const decimals = options.decimals ?? await getDecimals({ erc20Address, options })

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
    sourceToken: erc20Address,
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
 * Allow the bridge ERC-20 locker to transfer tokens from the user's address.
 * Allowance must be enough before tokens can be transfered with `initiate`
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address ERC-20 address of token to transfer.
 * @param params.amount Number of tokens to transfer.
 * @param params.options Optional arguments.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.ethChainId Ethereum chain id of the bridge.
 * @param params.options.erc20LockerAddress Rainbow bridge ERC-20 token locker address.
 * @param params.options.erc20Abi ERC-20 token abi.
 * @returns ApprovalInfo object which is used by checkApprove to track the transaction.
 */
export async function approve (
  { erc20Address, amount, options }: {
    erc20Address: string
    amount: string | ethers.BigNumber
    options?: {
      provider?: ethers.providers.JsonRpcProvider
      ethChainId?: number
      erc20LockerAddress?: string
      erc20Abi?: string
      signer?: ethers.Signer
    }
  }
): Promise<ApprovalInfo> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong eth network for approve, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const erc20Contract = new ethers.Contract(
    erc20Address,
    options.erc20Abi ?? bridgeParams.erc20Abi,
    options.signer ?? provider.getSigner()
  )
  const pendingApprovalTx = await erc20Contract.approve(
    options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
    amount
  )

  return {
    ...transferDraft,
    amount: amount.toString(),
    sourceToken: erc20Address,
    ethCache: {
      from: pendingApprovalTx.from,
      to: pendingApprovalTx.to,
      safeReorgHeight,
      data: pendingApprovalTx.data,
      nonce: pendingApprovalTx.nonce
    },
    approvalHashes: [pendingApprovalTx.hash],
    approvalReceipts: [],
    status: status.IN_PROGRESS
  }
}

export async function checkApprove (
  transfer: ApprovalInfo,
  options?: {
    provider?: ethers.providers.Provider
    ethChainId?: number
  }
): Promise<ApprovalInfo> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkApprove, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const approvalHash = last(transfer.approvalHashes)
  let approvalReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(approvalHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!approvalReceipt) {
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
      approvalReceipt = await provider.getTransactionReceipt(foundTx.hash)
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
  if (!approvalReceipt) return transfer

  if (!approvalReceipt.status) {
    const error = `Transaction failed: ${approvalReceipt.transactionHash}`
    return {
      ...transfer,
      approvalReceipts: [...transfer.approvalReceipts, approvalReceipt],
      errors: [...transfer.errors, error],
      status: status.FAILED
    }
  }

  if (approvalReceipt.transactionHash !== approvalHash) {
    // Record the replacement tx approvalHash
    transfer = {
      ...transfer,
      approvalHashes: [...transfer.approvalHashes, approvalReceipt.transactionHash]
    }
  }

  return {
    ...transfer,
    approvalReceipts: [...transfer.approvalReceipts, approvalReceipt],
    completedStep: APPROVE,
    status: status.ACTION_NEEDED
  }
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
    erc20LockerAddress?: string
    erc20LockerAbi?: string
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
    options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
    options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
    options.signer ?? provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const auroraEvmAccount: string = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingLockTx = await ethTokenLocker.lockToken(
    transfer.sourceToken,
    transfer.amount,
    auroraEvmAccount + ':' + transfer.recipient.slice(2)
  )

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingLockTx.from,
      to: pendingLockTx.to,
      safeReorgHeight,
      data: pendingLockTx.data,
      nonce: pendingLockTx.nonce
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
        data: transfer.ethCache.data
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
      'Locked',
      lockReceipt.transactionHash,
      options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
      options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
      provider
    )
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      account_id: options.nep141Factory ?? bridgeParams.nep141Factory,
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
            connectorAccount: options.nep141Factory ?? bridgeParams.nep141Factory,
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
    proof // used when checkSync() is called by unlock()
  }
  */
}
const last = (arr: any[]): any => arr[arr.length - 1]
