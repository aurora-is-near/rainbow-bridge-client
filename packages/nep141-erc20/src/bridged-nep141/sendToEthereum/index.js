import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import bs58 from 'bs58'
import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
import { toBuffer } from 'eth-util-lite'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import getErc20Name from '../../natural-erc20/getName'
import { getDecimals } from '../../natural-erc20/getMetadata'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { track } from '@near-eth/client'
import { borshifyOutcomeProof } from './borshify-proof'
import { getEthProvider, getNearAccount, formatLargeNum } from '@near-eth/client/dist/utils'
import getNep141Address from '../getAddress'
import * as urlParams from '../../natural-erc20/sendToNear/urlParams'

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

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [WITHDRAW]: `Withdraw ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from NEAR`,
      [AWAIT_FINALITY]: 'Await NEAR finality for withdrawal transaction',
      [SYNC]: 'Sync withdrawal transaction to Ethereum',
      [UNLOCK]: `Unlock ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Ethereum`
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

// Called when status is ACTION_NEEDED or FAILED
export function act (transfer) {
  switch (transfer.completedStep) {
    case null: return withdraw(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return unlock(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

// Called when status is IN_PROGRESS
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkWithdraw(transfer)
    case WITHDRAW: return checkFinality(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return checkUnlock(transfer)
  }
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
  const sourceTokenName = destinationTokenName + 'ⁿ'
  const sourceToken = getNep141Address(erc20Address)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    // attributes common to all transfer types
    amount: (new Decimal(amount).times(10 ** decimals)).toFixed(),
    completedStep: null,
    destinationTokenName,
    errors: [],
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    decimals,
    status: status.IN_PROGRESS,
    type: TRANSFER_TYPE,

    // attributes specific to bridged-nep141-to-erc20 transfers
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

  transfer = await track(transfer)

  await withdraw(transfer)
}

async function withdraw (transfer) {
  const nearAccount = await getNearAccount({
    // TODO: authAgainst can be any account, is there a better way ?
    authAgainst: process.env.nearTokenFactoryAccount
  })
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
      new BN('3' + '0'.repeat(14)) // 10x current default from near-api-js
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

export async function checkWithdraw (transfer) {
  const id = urlParams.get('withdrawing')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id || id !== transfer.id) {
    // Wallet returns transaction hash in redirect so it it not possible for another
    // minting transaction to be in process, ie if checkWithdraw is called on an in process
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
  const withdrawTx = await nearAccount.connection.provider.txStatus(decodedTxHash, transfer.sourceToken)
  if (withdrawTx.status.Failure) {
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

  const receiptIds = withdrawTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    return {
      ...transfer,
      errors: [
        ...transfer.errors,
          `Withdrawal expects only one receipt, got ${receiptIds.length
          }. Full withdrawal transaction: ${JSON.stringify(withdrawTx)}`
      ],
      status: status.FAILED,
      withdrawTx
    }
  }

  const txReceiptId = receiptIds[0]

  // TODO check receipt id status ?

  const successReceiptId = withdrawTx.receipts_outcome
    .find(r => r.id === txReceiptId).outcome.status.SuccessReceiptId
  const txReceiptBlockHash = withdrawTx.receipts_outcome
    .find(r => r.id === successReceiptId).block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: WITHDRAW,
    withdrawReceiptIds: [...transfer.withdrawReceiptIds, successReceiptId],
    withdrawReceiptBlockHeights: [...transfer.withdrawReceiptBlockHeights, Number(receiptBlock.header.height)]
  }
}

// Wait for a final block with a strictly greater height than withdrawTx
// receipt. This block (or one of its ancestors) should hold the outcome.
// Although this may not support sharding.
// TODO: support sharding
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

// Wait for the block with the given receipt/transaction in Near2EthClient, and
// get the outcome proof only use block merkle root that we know is available
// on the Near2EthClient.
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

// Unlock tokens stored in the contract at process.env.ethLockerAddress,
// passing the proof that the tokens were withdrawn/burned in the corresponding
// NEAR BridgeToken contract.
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

  const unlockHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .unlockToken(borshProof, nearOnEthClientBlockHeight).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
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
  const unlockReceipt = await web3.eth.getTransactionReceipt(unlockHash)

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
