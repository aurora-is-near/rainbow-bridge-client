import BN from 'bn.js'
import { borshifyOutcomeProof } from './borshify-proof'
import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
import { toBuffer } from 'ethereumjs-util'
import bs58 from 'bs58'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import {
  getSignerProvider,
  getAuroraProvider,
  getEthProvider,
  getNearAccount,
  formatLargeNum
} from '@near-eth/client/dist/utils'
import { findReplacementTx } from '../../utils'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-erc20/bridged-erc20/sendToEthereum'

const BURN = 'burn-bridged-erc20-to-ethereum'
const AWAIT_FINALITY = 'await-finality-bridged-erc20-to-ethereum'
const SYNC = 'sync-bridged-erc20-to-ethereum'
const UNLOCK = 'unlock-bridged-erc20-to-ethereum'

const steps = [
  BURN,
  AWAIT_FINALITY,
  SYNC,
  UNLOCK
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
  finalityBlockHeights: [],
  finalityBlockTimestamps: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  securityWindow: 4 * 60, // in minutes. TODO: seconds instead? hours? TODO: get from connector contract? prover?
  securityWindowProgress: 0,
  burnHashes: [],
  burnReceipts: [],
  nearBurnHashes: [], // TODO
  nearBurnReceipts: [], // TODO
  nearBurnReceiptBlockHeights: [], // TODO
  unlockHashes: [],
  unlockReceipts: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} to Ethereum`,
      [AWAIT_FINALITY]: 'Confirming in Aurora',
      [SYNC]: 'Confirming in Aurora. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Ethereum`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Aurora'
          case SYNC: return 'Ready to deposit in Ethereum'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Ethereum'
        case BURN: return 'Confirming transfer'
        case AWAIT_FINALITY: return 'Confirming transfer'
        case SYNC: return 'Depositing in Ethereum'
        case UNLOCK: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Transfer'
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
    case null: return burn(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return unlock(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkBurn(transfer)
    case BURN: return checkFinality(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return checkUnlock(transfer)
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

export async function initiate ({ amount, token }) {
  // TODO: move to core 'decorate'; get both from contracts
  const sourceTokenName = 'a' + token.symbol
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = token.decimals
  const destinationTokenName = token.symbol

  // TODO enable different recipient and consider multisig case where sender is not the signer
  const web3 = new Web3(getSignerProvider())
  const sender = web3.currentProvider.selectedAddress
  const recipient = sender

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: amount.toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: token.auroraAddress,
    sourceTokenName,
    decimals
  }

  transfer = await burn(transfer)
  return track(transfer)
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

  // TODO: BURN tokens on Aurora
  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText), // TODO burn precompile address and abi
    process.env.ethLockerAddress,
    { from: transfer.sender }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const burnHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .lockToken(transfer.sourceToken, transfer.amount, transfer.recipient).send() // TODO burn precompile
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingBurnTx = await web3.eth.getTransaction(burnHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      safeReorgHeight,
      nonce: pendingBurnTx.nonce
    },
    burnHashes: [...transfer.burnHashes, burnHash]
  }
}

async function checkBurn (transfer) {
  // TODO check BURN with Aurora tx or NEAR tx ?
  // TODO record NEAR BURN tx so that it can be used to build the proof
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
        to: process.env.ethLockerAddress // TODO
      }
      const event = {
        name: 'Locked', // TODO
        abi: process.env.ethLockerAbiText,
        validate: ({ returnValues: { token, sender, amount, accountId } }) => {
          if (!event) return false
          return (
            token.toLowerCase() === transfer.sourceToken.toLowerCase() &&
            sender.toLowerCase() === transfer.sender.toLowerCase() &&
            amount === transfer.amount &&
            accountId === transfer.recipient // TODO
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
      burnHashes: [...transfer.burnHashes, burnReceipt.transactionHash],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }

  // TODO parse burn receipt block height like in nep141 checkWithdraw

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    burnReceipts: [...transfer.burnReceipts, burnReceipt]
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

  return {
    ...transfer,
    completedStep: SYNC,
    nearOnEthClientBlockHeight,
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

  // Build burn proof
  const { nearOnEthClientBlockHeight } = await checkSync(transfer)
  const nearOnEthClient = new web3.eth.Contract(
    JSON.parse(process.env.ethNearOnEthClientAbiText),
    process.env.ethClientAddress
  )
  const clientBlockHashB58 = bs58.encode(toBuffer(
    await nearOnEthClient.methods
      .blockHashes(nearOnEthClientBlockHeight).call()
  ))
  const withdrawReceiptId = last(transfer.withdrawReceiptIds)
  const nearAccount = await getNearAccount()
  const proof = await nearAccount.connection.provider.sendJsonRpc(
    'light_client_proof',
    {
      type: 'receipt',
      receipt_id: withdrawReceiptId,
      receiver_id: transfer.sender,
      light_client_head: clientBlockHashB58
    }
  )

  // Unlock
  const ethUserAddress = (await web3.eth.getAccounts())[0]

  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress,
    { from: ethUserAddress }
  )

  const borshProof = borshifyOutcomeProof(proof)

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const unlockHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .unlockToken(borshProof, BN(nearOnEthClientBlockHeight)).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingUnlockTx = await web3.eth.getTransaction(unlockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingUnlockTx.from,
      safeReorgHeight,
      nonce: pendingUnlockTx.nonce
    },
    unlockHashes: [...transfer.unlockHashes, unlockHash]
  }
}

async function checkUnlock (transfer) {
  const provider = getEthProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

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
      unlockReceipt = await findReplacementTx(transfer.ethCache.safeReorgHeight, tx, event)
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
