import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import bs58 from 'bs58'
import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
import { toBuffer } from 'ethereumjs-util'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { track } from '@near-eth/client'
import { borshifyOutcomeProof } from './borshify-proof'
import { getEthProvider, getNearAccount, formatLargeNum } from '@near-eth/client/dist/utils'
import * as urlParams from '../../natural-erc20/sendToNear/urlParams'
import { findReplacementTx } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/near-ether/natural-near/sendToEthereum'

const LOCK = 'lock-natural-near-to-e-near'
const AWAIT_FINALITY = 'await-finality-natural-near-to-e-near'
const SYNC = 'sync-natural-near-to-e-near'
const MINT = 'mint-natural-near-to-e-near'

const steps = [
  LOCK,
  AWAIT_FINALITY,
  SYNC,
  MINT
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
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to bridged-nep141-to-erc20 transfers
  finalityBlockHeights: [],
  finalityBlockTimestamps: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  securityWindow: 4 * 60, // in minutes. TODO: seconds instead? hours? TODO: get from connector contract? prover?
  securityWindowProgress: 0,
  mintHashes: [],
  mintReceipts: [],
  lockReceiptBlockHeights: [],
  lockReceiptIds: [],
  nearOnEthClientBlockHeights: [],
  proofs: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from NEAR`,
      [AWAIT_FINALITY]: 'Confirming in NEAR',
      [SYNC]: 'Confirming in Ethereum. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Ethereum`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from NEAR'
          case SYNC: return 'Ready to deposit in Ethereum'
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Ethereum'
        case LOCK: return 'Confirming transfer'
        case AWAIT_FINALITY: return 'Confirming transfer'
        case SYNC: return 'Depositing in Ethereum'
        case MINT: return 'Transfer complete'
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Transfer'
        case SYNC: return 'Deposit'
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
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return mint(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkLock(transfer)
    case LOCK: return checkFinality(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return checkMint(transfer)
  }
}

/**
 * Recover transfer from a lock tx hash
 * Track a new transfer at the completedStep = LOCK so that it can be minted
 * @param {string} lockTxHash Near tx hash containing the token lock
 * @param {string} sender Near account sender of lockTxHash
 */
export async function recover (lockTxHash, sender = 'todo') {
  const decodedTxHash = utils.serialize.base_decode(lockTxHash)
  const nearAccount = await getNearAccount()
  const lockTx = await nearAccount.connection.provider.txStatus(
    // TODO: when multiple shards, the sender should be known in order to query txStatus
    decodedTxHash, sender
  )
  sender = lockTx.transaction.signer_id

  if (lockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Lock transaction pending: ${lockTxHash}`)
  }

  // Check status of tx broadcasted by wallet
  if (lockTx.status.Failure) {
    throw new Error(`Lock transaction failed: ${lockTxHash}`)
  }

  // Get lock event information from successValue
  const successValue = lockTx.status.SuccessValue
  if (!successValue) {
    throw new Error(
      `Invalid lockTx successValue: '${successValue}'
      Full lock transaction: ${JSON.stringify(lockTx)}`
    )
  }

  class LockEvent {
    constructor (args) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [LockEvent, {
      kind: 'struct',
      fields: [
        ['flag', 'u8'],
        ['amount', 'u128'],
        ['token', [20]], // TODO remove unnecessary field
        ['recipient', [20]]
      ]
    }]
  ])
  const lockEvent = deserializeBorsh(
    SCHEMA, LockEvent, Buffer.from(successValue, 'base64')
  )

  const amount = lockEvent.amount.toString()
  const recipient = '0x' + Buffer.from(lockEvent.recipient).toString('hex')
  const destinationTokenName = 'eNEAR'
  const decimals = 18
  const sourceTokenName = '$NEAR'

  const lockReceipt = await parseLockReceipt(lockTx, sender)

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    decimals,

    lockReceiptBlockHeights: [lockReceipt.blockHeight],
    lockReceiptIds: [lockReceipt.id]
  }
  return transfer
}

/**
 * Parse the lock receipt id and block height needed to complete
 * the step LOCK
 * @param {*} lockTx
 * @param {string} sender
 */
async function parseLockReceipt (lockTx, sender) {
  const nearAccount = await getNearAccount()
  const receiptIds = lockTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Lock expects only one receipt, got ${receiptIds.length}.
      Full lock transaction: ${JSON.stringify(lockTx)}`
    )
  }

  // Get receipt information for recording and building lock proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = lockTx.receipts_outcome
    .find(r => r.id === txReceiptId).outcome
  const successReceiptId = successReceiptOutcome.status.SuccessReceiptId
  const successReceiptExecutorId = successReceiptOutcome.executor_id

  let lockReceiptId

  // Check if this tx was made from a 2fa
  // TODO test 2fa, sourceToken is replaced by process.env.nativeNEARLockedAddress as executor_id
  switch (successReceiptExecutorId) {
    case sender: {
      // `confirm` transaction executed on 2fa account
      const lockReceiptOutcome = lockTx.receipts_outcome
        .find(r => r.id === successReceiptId)
        .outcome

      lockReceiptId = lockReceiptOutcome.status.SuccessReceiptId

      const lockReceiptExecutorId = lockReceiptOutcome.executor_id
      // Expect this receipt to be the 2fa FunctionCall
      if (lockReceiptExecutorId !== process.env.nativeNEARLockerAddress) {
        throw new TransferError(
          `Unexpected receipt outcome format in 2fa transaction.
          Expected sourceToken '${process.env.nativeNEARLockerAddress}', got '${lockReceiptExecutorId}'
          Full withdrawal transaction: ${JSON.stringify(lockTx)}`
        )
      }
      break
    }
    case process.env.nativeNEARLockerAddress:
      // `lock` called directly, successReceiptId is already correct, nothing to do
      lockReceiptId = successReceiptId
      break
    default:
      throw new TransferError(
        `Unexpected receipt outcome format.
        Full withdrawal transaction: ${JSON.stringify(lockTx)}`
      )
  }

  const txReceiptBlockHash = lockTx.receipts_outcome
    .find(r => r.id === lockReceiptId).block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: lockReceiptId, blockHeight: receiptBlockHeight }
}

export async function initiate ({
  amount,
  sender,
  recipient
}) {
  // TODO: move to core 'decorate'; get both from contracts
  const destinationTokenName = 'eNEAR'
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = 18
  const sourceTokenName = '$NEAR'

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: (new Decimal(amount).times(10 ** decimals)).toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    decimals
  }

  transfer = await track(transfer)

  await lock(transfer)
}

async function lock (transfer) {
  const nearAccount = await getNearAccount()
  // Calling `BridgeToken.lock` causes a redirect to NEAR Wallet.
  //
  // This adds some info about the current transaction to the URL params, then
  // returns to mark the transfer as in-progress, and THEN executes the
  // `lock` function.
  //
  // Since this happens very quickly in human time, a user will not have time
  // to start two `deposit` calls at the same time, and the `checkLock` will be
  // able to correctly identify the transfer and see if the transaction
  // succeeded.
  setTimeout(async () => {
    await nearAccount.functionCall(
      process.env.nativeNEARLockerAddress,
      'migrate_to_ethereum',
      {
        amount: String(transfer.amount), // TODO fix arguments and gas
        recipient: transfer.recipient.replace('0x', '')
      },
      // 100Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      new BN('100' + '0'.repeat(12)),
      new BN('1')
    )
  }, 100)
  // Set url params before this lock() returns, otherwise there is a chance that checkLock() is called before
  // the wallet redirect and the transfer errors because the status is IN_PROGRESS but the expected
  // url param is not there
  urlParams.set({ locking: transfer.id })

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted lock transaction
 * checkLock is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkLock can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkLock (transfer) {
  const id = urlParams.get('locking')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id && !txHash) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A lock transaction was initiated but could not be verified.
      If a transaction was sent from your account, please make sure to 'Restore transfer' and finalize it.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!id) {
    // checkstatus managed to call checkLock withing the 100ms before wallet redirect
    // so id is not yet set
    console.log('Waiting for Near wallet redirect to sign lock')
    return transfer
  }
  if (id !== transfer.id) {
    // Another lock transaction cannot be in progress, ie if checkLock is called on
    // an in process lock then the transfer ids must be equal or the url callback is invalid.
    urlParams.clear()
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
    // If checkLock is called before lock sig wallet redirect
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Lock tx hash not received: pending redirect or wallet error'
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
  const lockTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a lock
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  if (lockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (lockTx.status.Failure) {
    urlParams.clear()
    console.error('lockTx.status.Failure', lockTx.status.Failure)
    const errorMessage = typeof lockTx.status.Failure === 'object'
      ? parseRpcError(lockTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${lockTx.transaction.hash}">${lockTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      lockTx
    }
  }

  let lockReceipt
  try {
    lockReceipt = await parseLockReceipt(lockTx, transfer.sender)
  } catch (e) {
    if (e instanceof TransferError) {
      urlParams.clear()
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED,
        lockTx
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkLock will be called again.
    throw e
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    lockReceiptIds: [...transfer.lockReceiptIds, lockReceipt.id],
    lockReceiptBlockHeights: [...transfer.lockReceiptBlockHeights, lockReceipt.blockHeight]
  }
}

/**
 * Wait for a final block with a strictly greater height than lockTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 * @param {*} transfer
 */
async function checkFinality (transfer) {
  const nearAccount = await getNearAccount()

  const lockReceiptBlockHeight = last(transfer.lockReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearAccount.connection.provider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= lockReceiptBlockHeight) {
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
  const lockReceiptId = last(transfer.lockReceiptIds)
  const proof = await nearAccount.connection.provider.sendJsonRpc(
    'light_client_proof',
    {
      type: 'receipt',
      receipt_id: lockReceiptId,
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
 * Mint eNEAR tokens,
 * passing the proof that the tokens were locked in the corresponding
 * NEAR BridgeToken contract.
 * @param {*} transfer
 */
async function mint (transfer) {
  const web3 = new Web3(getEthProvider())
  const ethUserAddress = (await web3.eth.getAccounts())[0]

  const eNEAR = new web3.eth.Contract(
    JSON.parse(process.env.eNEARAbiText),
    process.env.eNEARAddress,
    { from: ethUserAddress }
  )

  const borshProof = borshifyOutcomeProof(last(transfer.proofs))
  const nearOnEthClientBlockHeight = new BN(last(transfer.nearOnEthClientBlockHeights))

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const mintHash = await new Promise((resolve, reject) => {
    eNEAR.methods
      .finaliseNearToEthTransfer(borshProof, nearOnEthClientBlockHeight).send() // TODO correct function call
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingMintTx = await web3.eth.getTransaction(mintHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingMintTx.from,
      safeReorgHeight,
      nonce: pendingMintTx.nonce
    },
    mintHashes: [...transfer.mintHashes, mintHash]
  }
}

async function checkMint (transfer) {
  const provider = getEthProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkMint, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }

  const mintHash = last(transfer.mintHashes)
  let mintReceipt = await web3.eth.getTransactionReceipt(mintHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!mintReceipt) {
    // don't break old transfers in case they were made before this functionality is released
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: process.env.ethLockerAddress
      }
      const event = {
        name: 'NearToEthTransferFinalised', // TODO test speedup
        abi: process.env.eNEARAbiText,
        validate: ({ returnValues: { sender, amount, recipient } }) => {
          if (!event) return false
          return (
            // sender.toLowerCase() === transfer.sender.toLowerCase() && // Don't check sender, anyone can mint
            amount === transfer.amount &&
            recipient.toLowerCase() === transfer.recipient.toLowerCase()
          )
        }
      }
      mintReceipt = await findReplacementTx(transfer.ethCache.safeReorgHeight, tx, event)
    } catch (error) {
      console.error(error)
      return {
        ...transfer,
        errors: [...transfer.errors, error.message],
        status: status.FAILED
      }
    }
  }

  if (!mintReceipt) return transfer

  if (!mintReceipt.status) {
    let error
    try {
      error = await getRevertReason(mintHash, ethNetwork)
    } catch (e) {
      console.error(e)
      error = `Could not determine why transaction failed; encountered error: ${e.message}`
    }
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      mintReceipts: [...transfer.mintReceipts, mintReceipt]
    }
  }

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: MINT,
    mintReceipts: [...transfer.mintReceipts, mintReceipt]
  }
}

const last = arr => arr[arr.length - 1]
