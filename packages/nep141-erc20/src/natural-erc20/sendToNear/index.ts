import BN from 'bn.js'
import { ethers } from 'ethers'
import { track, get } from '@near-eth/client'
import { utils, Account } from 'near-api-js'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { urlParams, ethOnNearSyncHeight, findEthProof } from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getDecimals, getSymbol } from '../getMetadata'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/nep141-erc20/natural-erc20/sendToNear'

const APPROVE = 'approve-natural-erc20-to-nep141'
const LOCK = 'lock-natural-erc20-to-nep141'
const SYNC = 'sync-natural-erc20-to-nep141'
const MINT = 'mint-natural-erc20-to-nep141'

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
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  sourceTokenName: string
  checkSyncInterval?: number
  nextCheckSyncTimestamp?: Date
  proof?: Uint8Array
  startTime?: string
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
  nearClientAccount?: string
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
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} to NEAR`,
      [SYNC]: `Wait for ${transfer.neededConfirmations + Number(getBridgeParams().nearEventRelayerMargin)} transfer confirmations for security`,
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in NEAR`
    }),
    statusMessage: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Ethereum'
          case APPROVE: return 'Ready to transfer from Ethereum' // TODO: remove. This was only needed to prevent breaking user's ongoing transfer
          case SYNC: return 'Ready to deposit in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to NEAR'
        case APPROVE: return 'Transfering to NEAR' // TODO: remove. This was only needed to prevent breaking user's ongoing transfer
        case LOCK: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations + Number(getBridgeParams().nearEventRelayerMargin)}`
        case SYNC: return 'Depositing in NEAR'
        case MINT: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Transfer'
        case APPROVE: return 'Transfer' // TODO: remove. This was only needed to prevent breaking user's ongoing transfer
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
    case APPROVE: return await lock(transfer) // TODO: remove. This was only needed to prevent breaking user's ongoing transfer
    case LOCK: return await checkSync(transfer)
    case SYNC:
      try {
        return await mint(transfer)
      } catch (error) {
        console.error(error)
        if (error.message.includes('Failed to redirect to sign transaction')) {
          // Increase time to redirect to wallet before recording an error
          await new Promise(resolve => setTimeout(resolve, 10000))
        }
        if (typeof window !== 'undefined') urlParams.clear('minting')
        throw error
      }
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
    case APPROVE: return await checkLock(transfer) // TODO: remove. This was only needed to prevent breaking user's ongoing transfer
    case LOCK: return await checkSync(transfer)
    case SYNC: return await checkMint(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Find all lock transactions sending `erc20Address` tokens to NEAR.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.erc20Address Token address.
 * @param params.options Optional arguments.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.erc20LockerAddress Rainbow bridge ERC-20 token locker address.
 * @param params.options.erc20LockerAbi Rainbow bridge ERC-20 token locker abi.
 * @returns Array of Ethereum transaction hashes.
 */
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
  return events.filter(event => !event.args!.accountId.startsWith('aurora:')).map(event => event.transactionHash)
}

/**
 * Recover all transfers sending `erc20Address` tokens to Near.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.erc20Address Token address.
 * @param params.options TransferOptions.
 * @returns Array of recovered transfers.
 */
export async function findAllTransfers (
  { fromBlock, toBlock, sender, erc20Address, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    erc20Address: string
    options?: TransferOptions
  }
): Promise<Transfer[]> {
  const lockTransactions = await findAllTransactions({ fromBlock, toBlock, sender, erc20Address, options })
  const transfers = await Promise.all(lockTransactions.map(async (tx) => await recover(tx, options)))
  return transfers
}

/**
 * Recover transfer from a lock tx hash.
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
  const recipient = lockedEvent.args!.accountId
  const sender = lockedEvent.args!.sender
  const sourceTokenName: string = await getSymbol({ erc20Address, options })
  const decimals = await getDecimals({ erc20Address, options })
  const destinationTokenName = 'n' + sourceTokenName

  const txBlock = await lockedEvent.getBlock()

  const transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    decimals,
    status: status.IN_PROGRESS,

    lockHashes: [lockTxHash],
    lockReceipts: [receipt]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Ethereum to NEAR by locking tokens.
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
 * @param params.options.erc20Abi ERC-20 token abi.
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
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()

  const [conflictingTransfer] = await get({
    filter: ({ sourceToken, completedStep }) =>
      sourceToken === erc20Address &&
      (!completedStep || completedStep === null)
  })
  if (conflictingTransfer) {
    throw new Error(
      'Another transfer is already in progress, please complete the "Start transfer" step and try again.'
    )
  }

  const sourceTokenName: string = options.symbol ?? await getSymbol({ erc20Address, options })
  const decimals = options.decimals ?? await getDecimals({ erc20Address, options })
  const destinationTokenName = 'n' + sourceTokenName
  const signer = options.signer ?? provider.getSigner()
  const sender = options.sender ?? (await signer.getAddress()).toLowerCase()

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
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

  const [conflictingTransfer] = await get({
    filter: ({ sourceToken, completedStep }) =>
      sourceToken === erc20Address &&
      (!completedStep || completedStep === null)
  })
  if (conflictingTransfer) {
    throw new Error(
      'Another transfer is already in progress, please complete the "Start transfer" step and try again.'
    )
  }

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

/**
 * Check the status of the `approve` transaction.
 * @param transfer Object returned by `approve` to check it's status
 * @param param.options Optional arguments.
 * @param param.options.provider Ethereum provider to use.
 * @param param.options.ethChainId Ethereum chain id of the bridge.
 */
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

  const ethChainId = (await provider.getNetwork()).chainId
  const expectedChainId = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    console.log(
      'Wrong eth network for checkApprove, expected: %s, got: %s',
      expectedChainId, ethChainId
    )
    return transfer
  }

  const approvalHash = last(transfer.approvalHashes)
  let approvalReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(approvalHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!approvalReceipt) {
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
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingLockTx = await ethTokenLocker.lockToken(transfer.sourceToken, transfer.amount, transfer.recipient)

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
  const ethChainId = (await provider.getNetwork()).chainId
  const expectedChainId = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    console.log(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      expectedChainId, ethChainId
    )
    return transfer
  }
  let lockReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(lockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!lockReceipt) {
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
  const nearAccount = options.nearAccount ?? await getNearAccount()

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
    nearAccount
  )
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)
  let proof

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'Locked',
      lockReceipt.transactionHash,
      options.erc20LockerAddress ?? bridgeParams.erc20LockerAddress,
      options.erc20LockerAbi ?? bridgeParams.erc20LockerAbi,
      provider
    )
    const proofAlreadyUsed = await nearAccount.viewFunction(
      options.nep141Factory ?? bridgeParams.nep141Factory,
      'is_used_proof',
      Buffer.from(proof)
    )
    if (proofAlreadyUsed) {
      // TODO: find the event relayer tx hash
      return {
        ...transfer,
        completedStep: MINT,
        completedConfirmations,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Transfer already finalized.']
        // mintHashes: [...transfer.mintHashes, txHash]
      }
    }
  }

  const nearEventRelayerMargin: number = options.nearEventRelayerMargin ?? bridgeParams.nearEventRelayerMargin
  if (completedConfirmations < transfer.neededConfirmations + nearEventRelayerMargin) {
    // Leave some time for the relayer to finalize
    return {
      ...transfer,
      nextCheckSyncTimestamp: new Date(Date.now() + transfer.checkSyncInterval!),
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
}

/**
 * Mint NEP141 tokens to transfer.recipient. Causes a redirect to NEAR Wallet,
 * currently dealt with using URL params.
 */
export async function mint (
  transfer: Transfer | string,
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()

  // Check if the transfer is finalized and get the proof if not
  transfer = await checkSync(transfer, options)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (typeof window !== 'undefined') urlParams.set({ minting: transfer.id })
  if (typeof window !== 'undefined') transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  const tx = await nearAccount.functionCall({
    contractId: options.nep141Factory ?? bridgeParams.nep141Factory,
    methodName: 'deposit',
    args: proof!,
    // 200Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
    gas: new BN('200' + '0'.repeat(12)),
    // We need to attach tokens because minting increases the contract state, by <600 bytes, which
    // requires an additional 0.06 NEAR to be deposited to the account for state staking.
    // Note technically 0.0537 NEAR should be enough, but we round it up to stay on the safe side.
    attachedDeposit: new BN('100000000000000000000').mul(new BN('600'))
  })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    mintHashes: [...transfer.mintHashes, tx.transaction.hash]
  }
}

/**
 * Process a broadcasted mint transaction
 * checkMint is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkMint can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 */
export async function checkMint (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const id = urlParams.get('minting') as string | null
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes') as string | null
  const errorCode = urlParams.get('errorCode') as string | null
  const clearParams = ['minting', 'transactionHashes', 'errorCode', 'errorMessage']
  if (!id) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A deposit transaction was initiated but could not be verified.
      Click 'rescan the blockchain' to check if a transfer was made.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (id !== transfer.id) {
    // Another minting transaction cannot be in progress, ie if checkMint is called on
    // an in progess mint then the transfer ids must be equal or the url callback is invalid.
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
  if (!txHash) {
    // If checkMint is called before mint sig wallet redirect,
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Tx hash not received: pending redirect or wallet error'
    console.log(newError)
    return transfer
  }
  if (txHash.includes(',')) {
    urlParams.clear(...clearParams)
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
  const mintTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, nearAccount.accountId
  )

  // @ts-expect-error : wallet returns errorCode
  if (mintTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error : wallet returns errorCode
  if (mintTx.status.Failure) {
    urlParams.clear(...clearParams)
    const error = `NEAR transaction failed: ${txHash}`
    console.error(error)
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED,
      mintHashes: [...transfer.mintHashes, txHash]
    }
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear(...clearParams)

  return {
    ...transfer,
    completedStep: MINT,
    status: status.COMPLETE,
    mintHashes: [...transfer.mintHashes, txHash]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
