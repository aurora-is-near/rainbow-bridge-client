import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import bs58 from 'bs58'
import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
import { toBuffer } from 'eth-util-lite'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import getErc20Name from '../../natural-erc20/getName'
import { getDecimals } from '../../natural-erc20/getMetadata'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { track } from '@near-eth/client'
import { borshifyOutcomeProof } from './borshify-proof'
import { getEthProvider, getNearAccount, formatLargeNum } from '@near-eth/client/dist/utils'
import getNep141Address from '../getAddress'
import * as urlParams from '../../natural-erc20/sendToNear/urlParams'
import { findReplacementTx } from '../../utils'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/nep141-erc20/bridged-nep141/sendToEthereum'

const WITHDRAW = 'withdraw-bridged-nep141-to-erc20'
const AWAIT_FINALITY = 'await-finality-bridged-nep141-to-erc20'
const SYNC = 'sync-bridged-nep141-to-erc20'
const UNLOCK = 'unlock-bridged-nep141-to-erc20'

const steps = [
  WITHDRAW,
  AWAIT_FINALITY,
  SYNC,
  UNLOCK
]

class TransferError extends Error {}

const transferDraft = {
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
  //   signer,                   // tx.from of last broadcasted eth tx
  //   safeReorgHight,           // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to bridged-nep141-to-erc20 transfers
  finalityBlockHeights: [],
  finalityBlockTimestamps: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  securityWindow: 4 * 60, // in minutes. TODO: seconds instead? hours? TODO: get from connector contract? prover?
  securityWindowProgress: 0,
  unlockHashes: [],
  unlockReceipts: [],
  withdrawReceiptBlockHeights: [],
  withdrawReceiptIds: [],
  nearOnEthClientBlockHeights: [],
  proofs: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [WITHDRAW]: `Withdraw ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from NEAR`,
      [AWAIT_FINALITY]: `Convert ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} to ${transfer.destinationTokenName}`,
      [SYNC]: 'Sync withdrawal transaction to Ethereum (up to 16 hours)',
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} on Ethereum`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to withdraw from NEAR'
          case SYNC: return 'Ready to unlock in Ethereum'
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Withdrawing from NEAR'
        case WITHDRAW: return 'Finalizing withdrawal'
        case AWAIT_FINALITY: return 'Syncing to Ethereum'
        case SYNC: return 'Unlocking in Ethereum'
        case UNLOCK: return 'Transfer complete'
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Withdraw'
        case SYNC: return 'Unlock'
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
    case null: return withdraw(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return unlock(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkWithdraw(transfer)
    case WITHDRAW: return checkFinality(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return checkUnlock(transfer)
  }
}

/**
 * Recover transfer from a withdraw tx hash
 * Track a new transfer at the completedStep = WITHDRAW so that it can be unlocked
 * @param {string} withdrawTxHash Near tx hash containing the token withdrawal
 * @param {string} sender Near account sender of withdrawTxHash
 */
export async function recover (withdrawTxHash, sender = 'todo') {
  const decodedTxHash = utils.serialize.base_decode(withdrawTxHash)
  const nearAccount = await getNearAccount()
  const withdrawTx = await nearAccount.connection.provider.txStatus(
    // TODO: when multiple shards, the sender should be known in order to query txStatus
    decodedTxHash, sender
  )
  sender = withdrawTx.transaction.signer_id

  if (withdrawTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Withdraw transaction pending: ${withdrawTxHash}`)
  }

  // Check status of tx broadcasted by wallet
  if (withdrawTx.status.Failure) {
    throw new Error(`Withdraw transaction failed: ${withdrawTxHash}`)
  }

  // Get withdraw event information from successValue
  const successValue = withdrawTx.status.SuccessValue
  if (!successValue) {
    throw new Error(
      `Invalid withdrawTx successValue: '${successValue}'
      Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
    )
  }

  class WithdrawEvent {
    constructor (args) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [WithdrawEvent, {
      kind: 'struct',
      fields: [
        ['flag', 'u8'],
        ['amount', 'u128'],
        ['token', [20]],
        ['recipient', [20]]
      ]
    }]
  ])
  const withdrawEvent = deserializeBorsh(
    SCHEMA, WithdrawEvent, Buffer.from(successValue, 'base64')
  )

  const amount = withdrawEvent.amount.toString()
  const recipient = '0x' + Buffer.from(withdrawEvent.recipient).toString('hex')
  const erc20Address = '0x' + Buffer.from(withdrawEvent.token).toString('hex')
  const destinationTokenName = await getErc20Name(erc20Address)
  const decimals = await getDecimals(erc20Address)
  const sourceTokenName = 'n' + destinationTokenName
  const sourceToken = getNep141Address(erc20Address)

  const withdrawReceipt = await parseWithdrawReceipt(withdrawTx, sender, sourceToken)

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    amount,
    completedStep: WITHDRAW,
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    decimals,

    withdrawReceiptBlockHeights: [withdrawReceipt.blockHeight],
    withdrawReceiptIds: [withdrawReceipt.id]
  }
  return transfer
}

/**
 * Parse the withdraw receipt id and block height needed to complete
 * the step WITHDRAW
 * @param {*} withdrawTx
 * @param {string} sender
 * @param {string} sourceToken
 */
async function parseWithdrawReceipt (withdrawTx, sender, sourceToken) {
  const nearAccount = await getNearAccount()
  const receiptIds = withdrawTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Withdrawal expects only one receipt, got ${receiptIds.length}.
      Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
    )
  }

  // Get receipt information for recording and building withdraw proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = withdrawTx.receipts_outcome
    .find(r => r.id === txReceiptId).outcome
  const successReceiptId = successReceiptOutcome.status.SuccessReceiptId
  const successReceiptExecutorId = successReceiptOutcome.executor_id

  let withdrawReceiptId

  // Check if this tx was made from a 2fa
  switch (successReceiptExecutorId) {
    case sender: {
      // `confirm` transaction executed on 2fa account
      const withdrawReceiptOutcome = withdrawTx.receipts_outcome
        .find(r => r.id === successReceiptId)
        .outcome

      withdrawReceiptId = withdrawReceiptOutcome.status.SuccessReceiptId

      const withdrawReceiptExecutorId = withdrawReceiptOutcome.executor_id
      // Expect this receipt to be the 2fa FunctionCall
      if (withdrawReceiptExecutorId !== sourceToken) {
        throw new TransferError(
          `Unexpected receipt outcome format in 2fa transaction.
          Expected sourceToken '${sourceToken}', got '${withdrawReceiptExecutorId}'
          Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
        )
      }
      break
    }
    case sourceToken:
      // `withdraw` called directly, successReceiptId is already correct, nothing to do
      withdrawReceiptId = successReceiptId
      break
    default:
      throw new TransferError(
        `Unexpected receipt outcome format.
        Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
      )
  }

  const txReceiptBlockHash = withdrawTx.receipts_outcome
    .find(r => r.id === withdrawReceiptId).block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: withdrawReceiptId, blockHeight: receiptBlockHeight }
}

export async function initiate ({
  erc20Address,
  amount,
  sender,
  recipient
}) {
  // TODO: move to core 'decorate'; get both from contracts
  const destinationTokenName = await getErc20Name(erc20Address)
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = await getDecimals(erc20Address)
  const sourceTokenName = 'n' + destinationTokenName
  const sourceToken = getNep141Address(erc20Address)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: (new Decimal(amount).times(10 ** decimals)).toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    decimals
  }

  transfer = await track(transfer)

  await withdraw(transfer)
}

async function withdraw (transfer) {
  const nearAccount = await getNearAccount()
  // Calling `BridgeToken.withdraw` causes a redirect to NEAR Wallet.
  //
  // This adds some info about the current transaction to the URL params, then
  // returns to mark the transfer as in-progress, and THEN executes the
  // `withdraw` function.
  //
  // Since this happens very quickly in human time, a user will not have time
  // to start two `deposit` calls at the same time, and the `checkWithdraw` will be
  // able to correctly identify the transfer and see if the transaction
  // succeeded.
  setTimeout(async () => {
    urlParams.set({ withdrawing: transfer.id })
    await nearAccount.functionCall(
      transfer.sourceToken,
      'withdraw',
      {
        amount: String(transfer.amount),
        recipient: transfer.recipient.replace('0x', '')
      },
      // 100Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      new BN('100' + '0'.repeat(12)),
      new BN('1')
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted withdraw transaction
 * checkWithdraw is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkWithdraw can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkWithdraw (transfer) {
  const id = urlParams.get('withdrawing')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id) {
    // checkstatus managed to call checkWithdraw withing the 100ms before wallet redirect
    // so id is not yet set
    console.log('Waiting for Near wallet redirect to sign withdraw')
    return transfer
  }
  if (id !== transfer.id) {
    // Wallet returns transaction hash in redirect so it is not possible for another
    // withdraw transaction to be in process, ie if checkWithdraw is called on an in process
    // withdraw then the transfer ids must be equal or the url callback is invalid.
    urlParams.clear()
    const newError = 'Couldn\'t determine transaction outcome'
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
    urlParams.clear()
    const newError = 'Error from wallet: ' + errorCode
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!txHash) {
    // If checkWithdraw is called before withdraw sig wallet redirect
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Withdraw tx hash not received: pending redirect or wallet error'
    console.log(newError)
    return transfer
  }
  if (txHash.includes(',')) {
    urlParams.clear()
    const newError = 'Error from wallet: expected single txHash, got: ' + txHash
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }

  const decodedTxHash = utils.serialize.base_decode(txHash)
  const nearAccount = await getNearAccount()
  const withdrawTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a withdraw
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  if (withdrawTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (withdrawTx.status.Failure) {
    urlParams.clear()
    console.error('withdrawTx.status.Failure', withdrawTx.status.Failure)
    const errorMessage = typeof withdrawTx.status.Failure === 'object'
      ? parseRpcError(withdrawTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${withdrawTx.transaction.hash}">${withdrawTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      withdrawTx
    }
  }

  let withdrawReceipt
  try {
    withdrawReceipt = await parseWithdrawReceipt(withdrawTx, transfer.sender, transfer.sourceToken)
  } catch (e) {
    if (e instanceof TransferError) {
      urlParams.clear()
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED,
        withdrawTx
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkWithdraw will be called again.
    throw e
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: WITHDRAW,
    withdrawReceiptIds: [...transfer.withdrawReceiptIds, withdrawReceipt.id],
    withdrawReceiptBlockHeights: [...transfer.withdrawReceiptBlockHeights, withdrawReceipt.blockHeight]
  }
}

/**
 * Wait for a final block with a strictly greater height than withdrawTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 * @param {*} transfer
 */
async function checkFinality (transfer) {
  const nearAccount = await getNearAccount()

  const withdrawReceiptBlockHeight = last(transfer.withdrawReceiptBlockHeights)
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
 * @param {*} transfer
 */
async function checkSync (transfer) {
  const web3 = new Web3(getEthProvider())
  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkSync, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }
  const nearAccount = await getNearAccount()

  const nearOnEthClient = new web3.eth.Contract(
    JSON.parse(process.env.ethNearOnEthClientAbiText),
    process.env.ethClientAddress
  )

  const finalityBlockHeight = last(transfer.finalityBlockHeights)
  const { currentHeight } = await nearOnEthClient.methods.bridgeState().call()
  const nearOnEthClientBlockHeight = Number(currentHeight)

  if (nearOnEthClientBlockHeight <= finalityBlockHeight) {
    return {
      ...transfer,
      nearOnEthClientBlockHeight,
      status: status.IN_PROGRESS
    }
  }

  const clientBlockHashB58 = bs58.encode(toBuffer(
    await nearOnEthClient.methods
      .blockHashes(nearOnEthClientBlockHeight).call()
  ))
  const withdrawReceiptId = last(transfer.withdrawReceiptIds)
  const proof = await nearAccount.connection.provider.sendJsonRpc(
    'light_client_proof',
    {
      type: 'receipt',
      receipt_id: withdrawReceiptId,
      receiver_id: transfer.sender,
      light_client_head: clientBlockHashB58
    }
  )

  return {
    ...transfer,
    completedStep: SYNC,
    nearOnEthClientBlockHeights: [...transfer.nearOnEthClientBlockHeights, nearOnEthClientBlockHeight],
    proofs: [...transfer.proofs, proof],
    status: status.ACTION_NEEDED
  }
}

/**
 * Unlock tokens stored in the contract at process.env.ethLockerAddress,
 * passing the proof that the tokens were withdrawn/burned in the corresponding
 * NEAR BridgeToken contract.
 * @param {*} transfer
 */
async function unlock (transfer) {
  const web3 = new Web3(getEthProvider())
  const ethUserAddress = (await web3.eth.getAccounts())[0]

  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress,
    { from: ethUserAddress }
  )

  const borshProof = borshifyOutcomeProof(last(transfer.proofs))
  const nearOnEthClientBlockHeight = new BN(last(transfer.nearOnEthClientBlockHeights))

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHight = await web3.eth.getBlockNumber() - 20
  const unlockHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .unlockToken(borshProof, nearOnEthClientBlockHeight).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingUnlockTx = await web3.eth.getTransaction(unlockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingUnlockTx.from,
      safeReorgHight,
      nonce: pendingUnlockTx.nonce
    },
    unlockHashes: [...transfer.unlockHashes, unlockHash]
  }
}

async function checkUnlock (transfer) {
  const web3 = new Web3(getEthProvider())
  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkUnlock, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }

  const unlockHash = last(transfer.unlockHashes)
  let unlockReceipt = await web3.eth.getTransactionReceipt(unlockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!unlockReceipt) {
    // don't break old transfers in case they were made before this functionality is released
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: process.env.ethLockerAddress
      }
      const event = {
        name: 'Unlocked',
        abi: process.env.ethLockerAbiText,
        validate: ({ returnValues: { amount, recipient } }) => {
          if (!event) return false
          return (
            amount === transfer.amount &&
            recipient.toLowerCase() === transfer.recipient.toLowerCase()
          )
        }
      }
      unlockReceipt = await findReplacementTx(transfer.ethCache.safeReorgHight, tx, event)
    } catch (error) {
      console.error(error)
      return {
        ...transfer,
        errors: [...transfer.errors, error.message],
        status: status.FAILED
      }
    }
  }

  if (!unlockReceipt) return transfer

  if (!unlockReceipt.status) {
    let error
    try {
      error = await getRevertReason(unlockHash, ethNetwork)
    } catch (e) {
      console.error(e)
      error = `Could not determine why transaction failed; encountered error: ${e.message}`
    }
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
    }
  }

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: UNLOCK,
    unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
  }
}

const last = arr => arr[arr.length - 1]
