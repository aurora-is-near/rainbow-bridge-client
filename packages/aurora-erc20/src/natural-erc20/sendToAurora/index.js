import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getSignerProvider, formatLargeNum } from '@near-eth/client/dist/utils'
import { findReplacementTx } from '../../utils'
import { lastBlockNumber } from './ethOnNearClient'

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

const transferDraft = {
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
  //   signer,                   // tx.from of last broadcasted eth tx
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  approvalHashes: [],
  approvalReceipts: [],
  completedConfirmations: 0,
  lockHashes: [],
  lockReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  mintHashes: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} to Aurora`,
      [SYNC]: `Wait for ${transfer.neededConfirmations} transfer confirmations for security`,
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Aurora`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Ethereum'
          case SYNC: return 'Ready to deposit in Aurora'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Aurora'
        case LOCK: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations}`
        case SYNC: return 'Depositing in Aurora'
        case MINT: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case SYNC: return 'Deposit'
        default: return null
      }
    }
  }
}

/**
 * Called when status is ACTION_NEEDED or FAILED
 * @param {*} transfer
 */
export function act (transfer) {
  switch (transfer.completedStep) {
    case null: return lock(transfer)
    case LOCK: return checkSync(transfer)
    // case SYNC: return mint(transfer) // Not implemented, done by relayer
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkLock(transfer)
    case LOCK: return checkSync(transfer)
    // case SYNC: return checkMint(transfer) // Not implemented, done by relayer
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a lock tx hash
 * Track a new transfer at the completedStep = LOCK so that it can be minted
 * @param {*} lockTxHash
 */
export async function recover (lockTxHash) {
  // TODO
}

export async function initiate ({ amount, token }) {
  // TODO: move to core 'decorate'; get both from contracts
  const sourceTokenName = token.symbol
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = token.decimals
  const destinationTokenName = 'a' + sourceTokenName

  // TODO enable different recipient and consider multisig case where sender is not the signer
  const web3 = new Web3(getSignerProvider())
  const sender = web3.currentProvider.selectedAddress
  const recipient = sender

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: token.ethAddress,
    sourceTokenName,
    decimals
  }

  transfer = await lock(transfer)

  return track(transfer)
}

export async function approve ({ amount, token }) {
  const sourceTokenName = token.symbol
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = token.decimals
  const destinationTokenName = 'a' + sourceTokenName

  const web3 = new Web3(getSignerProvider())

  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
  }

  // TODO enable different recipient and consider multisig case where sender is not the signer
  const sender = web3.currentProvider.selectedAddress
  const recipient = sender

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: token.ethAddress,
    sourceTokenName,
    decimals
  }

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    token.ethAddress,
    { from: sender }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const approvalHash = await new Promise((resolve, reject) => {
    erc20Contract.methods
      .approve(process.env.ethLockerAddress, amount).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingApprovalTx = await web3.eth.getTransaction(approvalHash)

  return {
    ...transfer,
    ethCache: {
      from: pendingApprovalTx.from,
      safeReorgHeight,
      nonce: pendingApprovalTx.nonce
    },
    approvalHashes: [...transfer.approvalHashes, approvalHash],
    status: status.IN_PROGRESS
  }
}

export async function checkApprove (transfer) {
  const provider = getEthProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkApprove, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }

  const approvalHash = last(transfer.approvalHashes)
  let approvalReceipt = await web3.eth.getTransactionReceipt(approvalHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!approvalReceipt) {
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.sourceToken
      }
      const event = {
        name: 'Approval',
        abi: process.env.ethErc20AbiText,
        validate: ({ returnValues: { owner, spender, value } }) => {
          return (
            owner.toLowerCase() === transfer.sender.toLowerCase() &&
            spender.toLowerCase() === process.env.ethLockerAddress.toLowerCase()
            // Don't check value as the user may have increased approval before signing.
            // value === transfer.amount
          )
        }
      }
      approvalReceipt = await findReplacementTx(transfer.ethCache.safeReorgHeight, tx, event)
    } catch (error) {
      console.error(error)
      return {
        ...transfer,
        errors: [...transfer.errors, error.message],
        status: status.FAILED
      }
    }
  }
  if (!approvalReceipt) return transfer

  if (!approvalReceipt.status) {
    let error
    try {
      error = await getRevertReason(approvalHash, ethNetwork)
    } catch (e) {
      console.error(e)
      error = `Could not determine why transaction '${approvalReceipt.transactionHash}'
        failed; encountered error: ${e.message}`
    }
    return {
      ...transfer,
      approvalReceipts: [...transfer.approvalReceipts, approvalReceipt],
      errors: [...transfer.errors, error],
      status: status.FAILED
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
 * @param {*} transfer
 */
async function lock (transfer) {
  const web3 = new Web3(getSignerProvider())

  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
  }

  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress,
    { from: transfer.sender }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const lockHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .lockToken(
        transfer.sourceToken,
        transfer.amount,
        process.env.auroraEvmAccount + ':' + transfer.recipient.slice(2)
      )
      .send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingLockTx = await web3.eth.getTransaction(lockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingLockTx.from,
      safeReorgHeight,
      nonce: pendingLockTx.nonce
    },
    lockHashes: [...transfer.lockHashes, lockHash]
  }
}

async function checkLock (transfer) {
  const provider = getEthProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const lockHash = last(transfer.lockHashes)
  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }
  let lockReceipt = await web3.eth.getTransactionReceipt(lockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!lockReceipt) {
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: process.env.ethLockerAddress
      }
      const event = {
        name: 'Locked',
        abi: process.env.ethLockerAbiText,
        validate: ({ returnValues: { token, sender, amount, accountId } }) => {
          if (!event) return false
          return (
            token.toLowerCase() === transfer.sourceToken.toLowerCase() &&
            sender.toLowerCase() === transfer.sender.toLowerCase() &&
            amount === transfer.amount &&
            accountId === process.env.auroraEvmAccount + ':' + transfer.recipient.slice(2)
          )
        }
      }
      lockReceipt = await findReplacementTx(transfer.ethCache.safeReorgHeight, tx, event)
    } catch (error) {
      console.error(error)
      return {
        ...transfer,
        errors: [...transfer.errors, error.message],
        status: status.FAILED
      }
    }
  }

  if (!lockReceipt) return transfer

  if (!lockReceipt.status) {
    let error
    try {
      error = await getRevertReason(lockHash, ethNetwork)
    } catch (e) {
      console.error(e)
      error = `Could not determine why transaction failed; encountered error: ${e.message}`
    }
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      lockReceipts: [...transfer.lockReceipts, lockReceipt]
    }
  }
  if (lockReceipt.transactionHash !== lockHash) {
    // Record the replacement tx lockHash
    return {
      ...transfer,
      status: status.IN_PROGRESS,
      completedStep: LOCK,
      lockHashes: [...transfer.lockHashes, lockReceipt.transactionHash],
      lockReceipts: [...transfer.lockReceipts, lockReceipt]
    }
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    lockReceipts: [...transfer.lockReceipts, lockReceipt]
  }
}

async function checkSync (transfer) {
  const lockReceipt = last(transfer.lockReceipts)
  const eventEmittedAt = lockReceipt.blockNumber
  const syncedTo = await lastBlockNumber()
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)

  if (completedConfirmations < transfer.neededConfirmations) {
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
    status: status.ACTION_NEEDED
  }
}
const last = arr => arr[arr.length - 1]
