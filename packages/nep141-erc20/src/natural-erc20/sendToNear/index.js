import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
import { track, get } from '@near-eth/client'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getNearAccount, formatLargeNum } from '@near-eth/client/dist/utils'
import getName from '../getName'
import { getDecimals } from '../getMetadata'
import findProof from './findProof'
import { lastBlockNumber } from './ethOnNearClient'
import * as urlParams from './urlParams'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/nep141-erc20/natural-erc20/sendToNear'

const APPROVE = 'approve-natural-erc20-to-nep141'
const LOCK = 'lock-natural-erc20-to-nep141'
const SYNC = 'sync-natural-erc20-to-nep141'
const MINT = 'mint-natural-erc20-to-nep141'

const steps = [
  APPROVE,
  LOCK,
  SYNC,
  MINT
]

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [APPROVE]: `Approve Token Locker to spend ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName}`,
      [LOCK]: `Lock ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} in Token Locker`,
      [SYNC]: `Sync ${transfer.neededConfirmations} blocks from Ethereum to NEAR`,
      [MINT]: `Mint ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in NEAR`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case APPROVE: return 'Ready to lock in Ethereum'
          case SYNC: return 'Ready to mint in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Approving Token Locker'
        case APPROVE: return 'Locking in Ethereum'
        case LOCK: return `Syncing block ${transfer.completedConfirmations + 1}/${transfer.neededConfirmations}`
        case SYNC: return 'Minting in NEAR'
        case MINT: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case APPROVE: return 'Lock'
        case SYNC: return 'Mint'
        default: return null
      }
    }
  }
}

// Called when status is ACTION_NEEDED or FAILED
export function act (transfer) {
  switch (transfer.completedStep) {
    case null: return approve(transfer)
    case APPROVE: return lock(transfer)
    case LOCK: return checkSync(transfer)
    case SYNC: return mint(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
  }
}

// Called when status is IN_PROGRESS
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkApprove(transfer)
    case APPROVE: return checkLock(transfer)
    case LOCK: return checkSync(transfer)
    case SYNC: return checkMint(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

// Call contract given by `erc20` contract, requesting permission for contract
// at `process.env.ethLockerAddress` to transfer 'amount' tokens
// on behalf of the default user set up in authEthereum.js.
// Only wait for transaction to have dependable transactionHash created. Avoid
// blocking to wait for transaction to be mined. Status of transactionHash
// being mined is then checked in checkStatus.
export async function initiate ({
  erc20Address,
  amount,
  sender,
  recipient
}) {
  // TODO: move to core 'decorate'; get both from contracts
  const sourceTokenName = await getName(erc20Address)
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = await getDecimals(erc20Address)
  const destinationTokenName = sourceTokenName + 'ⁿ'

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    // attributes common to all transfer types
    amount: (new Decimal(amount).times(10 ** decimals)).toFixed(),
    completedStep: null,
    destinationTokenName,
    errors: [],
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    decimals,
    status: status.ACTION_NEEDED,
    type: TRANSFER_TYPE,

    // attributes specific to natural-erc20-to-nep141 transfers
    approvalHashes: [],
    approvalReceipts: [],
    completedConfirmations: 0,
    lockHashes: [],
    lockReceipts: [],
    neededConfirmations: 30 // hard-coding until connector contract is updated with this information
  }

  transfer = await approve(transfer)

  track(transfer)
}

async function approve (transfer) {
  // Check if a transfer is pending lock: we don't want to override the approval of a previous transfer.
  const transfers = await get(
    { filter: t => t.sourceToken === transfer.sourceToken && (!t.completedStep || t.completedStep === APPROVE) }
  )
  if (transfers.length > 0) {
    throw new Error(
      'Another transfer is already in progress, please complete the "Lock" step and try again'
    )
  }
  const web3 = new Web3(getEthProvider())

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    transfer.sourceToken,
    { from: transfer.sender }
  )

  const approvalHash = await new Promise((resolve, reject) => {
    erc20Contract.methods
      .approve(process.env.ethLockerAddress, transfer.amount).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })

  return {
    ...transfer,
    approvalHashes: [...transfer.approvalHashes, approvalHash],
    status: status.IN_PROGRESS
  }
}

async function checkApprove (transfer) {
  const web3 = new Web3(getEthProvider())
  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkApprove, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }

  const approvalHash = last(transfer.approvalHashes)
  const approvalReceipt = await web3.eth.getTransactionReceipt(
    approvalHash
  )

  if (!approvalReceipt) return transfer

  if (!approvalReceipt.status) {
    let error
    try {
      error = await getRevertReason(approvalHash, ethNetwork)
    } catch (e) {
      console.error(e)
      error = `Could not determine why transaction failed; encountered error: ${e.message}`
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

// Initiate "lock" transaction.
//
// Only wait for transaction to have dependable transactionHash created. Avoid
// blocking to wait for transaction to be mined. Status of transactionHash
// being mined is then checked in checkStatus.
async function lock (transfer) {
  const web3 = new Web3(getEthProvider())
  const ethUserAddress = (await web3.eth.getAccounts())[0]

  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress,
    { from: ethUserAddress }
  )

  const lockHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .lockToken(transfer.sourceToken, transfer.amount, transfer.recipient).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    lockHashes: [...transfer.lockHashes, lockHash]
  }
}

async function checkLock (transfer) {
  const lockHash = last(transfer.lockHashes)
  const web3 = new Web3(getEthProvider())
  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }
  const lockReceipt = await web3.eth.getTransactionReceipt(
    lockHash
  )

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

// Mint NEP141 tokens to transfer.recipient. Causes a redirect to NEAR Wallet,
// currently dealt with using URL params.
async function mint (transfer) {
  const nearAccount = await getNearAccount({
    // TODO: authAgainst can be any account, is there a better way ?
    authAgainst: process.env.nearTokenFactoryAccount
  })
  const lockReceipt = last(transfer.lockReceipts)
  const proof = await findProof(lockReceipt.transactionHash)

  // Calling `nearFungibleTokenFactory.deposit` causes a redirect to NEAR Wallet.
  //
  // This adds some info about the current transaction to the URL params, then
  // returns to mark the transfer as in-progress, and THEN executes the
  // `deposit` function.
  //
  // Since this happens very quickly in human time, a user will not have time
  // to start two `deposit` calls at the same time, and the `checkMint` will be
  // able to correctly identify the transfer and see if the transaction
  // succeeded.
  setTimeout(async () => {
    urlParams.set({ minting: transfer.id })
    await nearAccount.functionCall(
      process.env.nearTokenFactoryAccount,
      'deposit',
      proof,
      new BN('300000000000000'),
      // We need to attach tokens because minting increases the contract state, by <600 bytes, which
      // requires an additional 0.06 NEAR to be deposited to the account for state staking.
      // Note technically 0.0537 NEAR should be enough, but we round it up to stay on the safe side.
      new BN('100000000000000000000').mul(new BN('600'))
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

export async function checkMint (transfer) {
  const id = urlParams.get('minting')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id || id !== transfer.id) {
    // Wallet returns transaction hash in redirect so it it not possible for another
    // minting transaction to be in process, ie if checkMint is called on an in process
    // minting then the transfer ids must be equal or the url callback is invalid.
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, "Couldn't determine transaction outcome"]
    }
  }
  if (errorCode) {
    // If errorCode, then the redirect succeded but the tx was rejected/failed
    // so clear url params
    urlParams.clear()
    const newError = 'Error from wallet: ' + errorCode
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!txHash) {
    // If checkWithdraw is called before withdraw sig wallet redirect
    // record the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Error from wallet: txHash not received'
    return {
      ...transfer,
      errors: [...transfer.errors, newError]
    }
  }

  // Clear url params after checks because checkWithdraw might get called before the withdraw() redirect to wallet
  // and we need the wallet to have the correct 'withdrawing' url param
  urlParams.clear()

  // Check status of tx broadcasted by wallet
  const decodedTxHash = utils.serialize.base_decode(txHash)
  const nearAccount = await getNearAccount()
  const mintTx = await nearAccount.connection.provider.txStatus(decodedTxHash, process.env.nearTokenFactoryAccount)
  if (mintTx.status.Failure) {
    console.error('mintTx.status.Failure', mintTx.status.Failure)
    const errorMessage = typeof mintTx.status.Failure === 'object'
      ? parseRpcError(mintTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${mintTx.transaction.hash}">${mintTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      mintTx
    }
  }

  const receiptIds = mintTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    return {
      ...transfer,
      errors: [
        ...transfer.errors,
          `Minting expects only one receipt, got ${receiptIds.length
          }. Full minting transaction: ${JSON.stringify(mintTx)}`
      ],
      status: status.FAILED,
      mintTx
    }
  }

  // const txReceiptId = receiptIds[0]
  // TODO check receipt id status ?

  return {
    ...transfer,
    completedStep: MINT,
    status: status.COMPLETE
  }
}

const last = arr => arr[arr.length - 1]
