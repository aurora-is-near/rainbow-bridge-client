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
import getAllowance from '../getAllowance'
import { getDecimals } from '../getMetadata'
import findProof from './findProof'
import { lastBlockNumber } from './ethOnNearClient'
import * as urlParams from './urlParams'
import { findReplacementTx } from '../../utils'

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
  //   safeReorgHeight,           // Lower boundary for replacement tx search
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
      [APPROVE]: `Approve transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from Ethereum`,
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} to NEAR`,
      [SYNC]: `Wait for ${transfer.neededConfirmations} transfer confirmations for security`,
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in NEAR`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case APPROVE: return 'Ready to transfer from Ethereum'
          case SYNC: return 'Ready to deposit in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Approving transfer'
        case APPROVE: return 'Transfering to NEAR'
        case LOCK: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations}`
        case SYNC: return 'Depositing in NEAR'
        case MINT: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case APPROVE: return 'Transfer'
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
    case null: return approve(transfer)
    case APPROVE: return lock(transfer)
    case LOCK: return checkSync(transfer)
    case SYNC: return mint(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkApprove(transfer)
    case APPROVE: return checkLock(transfer)
    case LOCK: return checkSync(transfer)
    case SYNC: return checkMint(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a lock tx hash
 * Track a new transfer at the completedStep = LOCK so that it can be minted
 * @param {*} lockTxHash
 */
export async function recover (lockTxHash) {
  const web3 = new Web3(getEthProvider())
  const receipt = await web3.eth.getTransactionReceipt(lockTxHash)
  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress
  )
  const events = await ethTokenLocker.getPastEvents('Locked', {
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber
  })
  const lockedEvent = events.find(event => event.transactionHash === lockTxHash)
  if (!lockedEvent) {
    throw new Error('Unable to process lock transaction event.')
  }
  const erc20Address = lockedEvent.returnValues.token
  const amount = lockedEvent.returnValues.amount
  const recipient = lockedEvent.returnValues.accountId
  const sender = lockedEvent.returnValues.sender
  const sourceTokenName = await getName(erc20Address)
  const decimals = await getDecimals(erc20Address)
  const destinationTokenName = 'n' + sourceTokenName

  const transfer = {
    ...transferDraft,

    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    decimals,
    status: status.IN_PROGRESS,

    lockReceipts: [receipt]
  }
  return transfer
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
  const [conflictingTransfer] = await get({
    filter: ({ sourceToken, completedStep }) =>
      sourceToken === erc20Address &&
      (!completedStep || completedStep === APPROVE)
  })
  if (conflictingTransfer) {
    throw new Error(
      'Another transfer is already in progress, please complete the "Lock" step and try again'
    )
  }

  // TODO: move to core 'decorate'; get both from contracts
  const sourceTokenName = await getName(erc20Address)
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = await getDecimals(erc20Address)
  const destinationTokenName = 'n' + sourceTokenName
  const decimalAmount = new Decimal(amount).times(10 ** decimals)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: decimalAmount.toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    decimals
  }

  const allowance = await getAllowance({
    erc20Address,
    owner: sender,
    spender: process.env.ethLockerAddress
  })
  if (decimalAmount.comparedTo(new Decimal(allowance)) === 1) {
    // amount > allowance
    transfer = await approve(transfer)
  } else {
    transfer = await lock({
      ...transfer,
      completedStep: APPROVE,
      status: status.ACTION_NEEDED
    })
  }

  track(transfer)
}

async function approve (transfer) {
  const web3 = new Web3(getEthProvider())

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    transfer.sourceToken,
    { from: transfer.sender }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const approvalHash = await new Promise((resolve, reject) => {
    erc20Contract.methods
      .approve(process.env.ethLockerAddress, transfer.amount).send()
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
  let approvalReceipt = await web3.eth.getTransactionReceipt(approvalHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!approvalReceipt) {
    // don't break old transfers in case they were made before this functionality is released
    if (!transfer.ethCache) return transfer
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
            spender.toLowerCase() === process.env.ethLockerAddress.toLowerCase() &&
            value === transfer.amount
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
  const web3 = new Web3(getEthProvider())
  const ethUserAddress = (await web3.eth.getAccounts())[0]

  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress,
    { from: ethUserAddress }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const lockHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .lockToken(transfer.sourceToken, transfer.amount, transfer.recipient).send()
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
  let lockReceipt = await web3.eth.getTransactionReceipt(lockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!lockReceipt) {
    // don't break old transfers in case they were made before this functionality is released
    if (!transfer.ethCache) return transfer
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
            accountId === transfer.recipient
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

/**
 * Mint NEP141 tokens to transfer.recipient. Causes a redirect to NEAR Wallet,
 * currently dealt with using URL params.
 * @param {*} transfer
 */
async function mint (transfer) {
  const nearAccount = await getNearAccount()
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
      // 200Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      new BN('200' + '0'.repeat(12)),
      // We need to attach tokens because minting increases the contract state, by <600 bytes, which
      // requires an additional 0.006 NEAR to be deposited to the account for state staking.
      // Note technically 0.00537 NEAR should be enough, but we round it up to stay on the safe side.
      new BN('100000000000000000000').mul(new BN('60'))
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted mint transaction
 * checkMint is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkMint can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkMint (transfer) {
  const id = urlParams.get('minting')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id && !txHash) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A deposit transaction was initiated but could not be verified.
      If no transaction was sent from your account, please retry.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!id) {
    // checkstatus managed to call checkMint withing the 100ms before wallet redirect
    // so id is not yet set
    console.log('Waiting for Near wallet redirect to sign mint')
    return transfer
  }
  if (id !== transfer.id) {
    // Another minting transaction cannot be in progress, ie if checkMint is called on
    // an in progess mint then the transfer ids must be equal or the url callback is invalid.
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
    // If checkMint is called before mint sig wallet redirect,
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Tx hash not received: pending redirect or wallet error'
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
  const mintTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, nearAccount.accountId
  )

  if (mintTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (mintTx.status.Failure) {
    urlParams.clear()
    console.error('mintTx.status.Failure', mintTx.status.Failure)
    const errorMessage = typeof mintTx.status.Failure === 'object'
      ? parseRpcError(mintTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${mintTx.transaction.hash}">${mintTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      mintHashes: [...transfer.mintHashes, txHash],
      mintTx
    }
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    completedStep: MINT,
    status: status.COMPLETE,
    mintHashes: [...transfer.mintHashes, txHash]
  }
}

const last = arr => arr[arr.length - 1]
