import { Decimal } from 'decimal.js'
import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getSignerProvider, getAuroraProvider, formatLargeNum } from '@near-eth/client/dist/utils'
import { findReplacementTx } from '../../utils'

// ============================================================================================
// TODO
// ============================================================================================

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-erc20/bridged-erc20/sendToEthereum'

const APPROVE = 'approve-bridged-erc20-to-ethereum'
const BURN = 'burn-bridged-erc20-to-ethereum'
const SYNC = 'sync-bridged-erc20-to-ethereum'

const steps = [
  APPROVE,
  BURN,
  SYNC
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
  burnHashes: [],
  burnReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  unlockHashes: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [APPROVE]: `Approve transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from Aurora`,
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} to Ethereum`,
      [SYNC]: `Wait for ${transfer.neededConfirmations} transfer confirmations for security`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case APPROVE: return 'Ready to transfer from Aurora'
          case SYNC: return 'Ready to deposit in Ethereum'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Approving transfer'
        case APPROVE: return 'Transfering to Ethereum'
        case BURN: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations}`
        case SYNC: return 'Depositing in Ethereum'
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
    case APPROVE: return burn(transfer)
    case BURN: return checkSync(transfer)
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
    case APPROVE: return checkBurn(transfer)
    case BURN: return checkSync(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a burn tx hash
 * Track a new transfer at the completedStep = BURN so that it can be minted
 * @param {*} burnTxHash
 */
export async function recover (burnTxHash) {
  // TODO
}

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
  const destinationTokenName = sourceTokenName
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

  transfer = await burn({
    ...transfer,
    completedStep: APPROVE,
    status: status.ACTION_NEEDED
  })

  track(transfer)
}

async function approve (transfer) {
  const web3 = new Web3(getSignerProvider())

  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.auroraNetworkId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
  }

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    transfer.sourceToken,
    { from: transfer.sender }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  // const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const approvalHash = await new Promise((resolve, reject) => {
    erc20Contract.methods
      .approve(process.env.ethLockerAddress, transfer.amount).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  /*
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
  */
  return approvalHash
}

async function checkApprove (transfer) {
  /*
  A transfer is recorded after the burn step. So the approval hash is not recorded in
  a transfer object in local storage.
  Instead of checking that transaction, we can instead check that the allowance has
  become enough.
  */
  // TODO check allowance is larger than transfer amount.
  /*
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
  */
}

/**
 * Initiate "burn" transaction.
 * Only wait for transaction to have dependable transactionHash created. Avoid
 * blocking to wait for transaction to be mined. Status of transactionHash
 * being mined is then checked in checkStatus.
 * @param {*} transfer
 */
async function burn (transfer) {
  const web3 = new Web3(getSignerProvider())

  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.auroraNetworkId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
  }

  const ethUserAddress = (await web3.eth.getAccounts())[0]

  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress,
    { from: ethUserAddress }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const burnHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .lockToken(transfer.sourceToken, transfer.amount, transfer.recipient).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingLockTx = await web3.eth.getTransaction(burnHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingLockTx.from,
      safeReorgHeight,
      nonce: pendingLockTx.nonce
    },
    burnHashes: [...transfer.burnHashes, burnHash]
  }
}

async function checkBurn (transfer) {
  const provider = getAuroraProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const burnHash = last(transfer.burnHashes)
  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkBurn, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }
  let burnReceipt = await web3.eth.getTransactionReceipt(burnHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
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
            accountId === transfer.recipient // TODO account id is aurora_near_account:recipient_eth_address
          )
        }
      }
      burnReceipt = await findReplacementTx(transfer.ethCache.safeReorgHeight, tx, event)
    } catch (error) {
      console.error(error)
      return {
        ...transfer,
        errors: [...transfer.errors, error.message],
        status: status.FAILED
      }
    }
  }

  if (!burnReceipt) return transfer

  if (!burnReceipt.status) {
    let error
    try {
      error = await getRevertReason(burnHash, ethNetwork)
    } catch (e) {
      console.error(e)
      error = `Could not determine why transaction failed; encountered error: ${e.message}`
    }
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }
  if (burnReceipt.transactionHash !== burnHash) {
    // Record the replacement tx lockHash
    return {
      ...transfer,
      status: status.IN_PROGRESS,
      completedStep: BURN,
      lockHashes: [...transfer.lockHashes, burnReceipt.transactionHash],
      lockReceipts: [...transfer.lockReceipts, burnReceipt]
    }
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    burnReceipts: [...transfer.burnReceipts, burnReceipt]
  }
}

/**
 * Wait for the block with the given receipt/transaction in Near2EthClient, and
 * get the outcome proof only use block merkle root that we know is available
 * on the Near2EthClient.
 * @param {*} transfer
 */
async function checkSync (transfer) {
  // TODO
}

const last = arr => arr[arr.length - 1]
