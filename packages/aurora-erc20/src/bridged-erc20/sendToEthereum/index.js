import BN from 'bn.js'
import { borshifyOutcomeProof, nearOnEthSyncHeight } from '@near-eth/utils'
import getRevertReason from 'eth-revert-reason'
import Web3 from 'web3'
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
import { findReplacementTx, SearchError } from 'find-replacement-tx'
import findProof from './findProof'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'ethereum'
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
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  finalityBlockHeights: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  burnHashes: [],
  burnReceipts: [],
  nearBurnHashes: [], // TODO
  nearBurnReceiptIds: [], // TODO
  nearBurnReceiptBlockHeights: [], // TODO
  unlockHashes: [],
  unlockReceipts: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from Aurora`,
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

    amount: amount,
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

  const auroraErc20 = new web3.eth.Contract(
    JSON.parse(process.env.auroraErc20AbiText), // TODO add abi to frontend
    transfer.sourceToken,
    { from: transfer.sender }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const burnHash = await new Promise((resolve, reject) => {
    auroraErc20.methods
      .withdrawToEthereum(transfer.recipient, transfer.amount).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingBurnTx = await web3.eth.getTransaction(burnHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to,
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
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to
      }
      const event = {
        name: 'Transfer', // TODO
        abi: process.env.auroraErc20AbiText,
        address: transfer.sourceToken,
        validate: ({ returnValues: { from, to, value } }) => {
          if (!event) return false
          return (
            from.toLowerCase() === transfer.sender.toLowerCase() &&
            to === 0 && // TODO address(0)
            value === transfer.amount
          )
        }
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx, event)
      if (!foundTx) return transfer
      burnReceipt = await web3.eth.getTransactionReceipt(foundTx.hash)
    } catch (error) {
      console.error(error)
      if (error instanceof SearchError) {
        return {
          ...transfer,
          errors: [...transfer.errors, error.message],
          status: status.FAILED
        }
      }
      throw error
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

  const withdrawReceiptBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
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
  const provider = getEthProvider()
  const web3 = new Web3(provider)
  const ethNetwork = await web3.eth.net.getNetworkType()
  if (ethNetwork !== process.env.ethNetworkId) {
    console.log(
      'Wrong eth network for checkSync, expected: %s, got: %s',
      process.env.ethNetworkId, ethNetwork
    )
    return transfer
  }

  const burnBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(provider)

  if (nearOnEthClientBlockHeight <= burnBlockHeight) {
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
 * Check if a NEAR outcome receipt_id has already been used to finalize a transfer to Ethereum.
 * @param {*} web3
 * @param {*} proof
 */
async function proofAlreadyUsed (web3, proof) {
  const usedProofsKey = bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex')
  // The usedProofs_ mapping is the 4th variable defined in the contract storage.
  const usedProofsMappingPosition = '0'.repeat(63) + '3'
  const storageIndex = web3.utils.sha3('0x' + usedProofsKey + usedProofsMappingPosition)
  // eth_getStorageAt docs: https://eth.wiki/json-rpc/API
  const proofIsUsed = await web3.eth.getStorageAt(process.env.ethLockerAddress, storageIndex)
  return Number(proofIsUsed) === 1
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
  transfer = await checkSync(transfer)
  const proof = await findProof(transfer)

  if (await proofAlreadyUsed(web3, proof)) {
    // TODO find the unlockTxHash (requires ERC20Locker upgrade)
    return {
      ...transfer,
      errors: [...transfer.errors, 'Unlock proof already used.'],
      status: status.COMPLETE,
      completedStep: UNLOCK
    }
  }

  // Unlock
  const borshProof = borshifyOutcomeProof(proof)

  const ethUserAddress = (await web3.eth.getAccounts())[0]
  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress,
    { from: ethUserAddress }
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await web3.eth.getBlockNumber() - 20
  const unlockHash = await new Promise((resolve, reject) => {
    ethTokenLocker.methods
      .unlockToken(borshProof, BN(transfer.nearOnEthClientBlockHeight)).send()
      .on('transactionHash', resolve)
      .catch(reject)
  })
  const pendingUnlockTx = await web3.eth.getTransaction(unlockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingUnlockTx.from,
      to: pendingUnlockTx.to,
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
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to
      }
      const event = {
        name: 'Unlocked',
        abi: process.env.ethLockerAbiText,
        address: process.env.ethLockerAddress,
        validate: ({ returnValues: { amount, recipient } }) => {
          if (!event) return false
          return (
            amount === transfer.amount &&
            recipient.toLowerCase() === transfer.recipient.toLowerCase()
          )
        }
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx, event)
      if (!foundTx) return transfer
      unlockReceipt = await web3.eth.getTransactionReceipt(foundTx.hash)
    } catch (error) {
      console.error(error)
      if (error instanceof SearchError) {
        return {
          ...transfer,
          errors: [...transfer.errors, error.message],
          status: status.FAILED
        }
      }
      throw error
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

  if (unlockReceipt.transactionHash !== unlockHash) {
    // Record the replacement tx unlockHash
    return {
      ...transfer,
      status: status.COMPLETE,
      completedStep: UNLOCK,
      unlockHashes: [...transfer.unlockHashes, unlockReceipt.transactionHash],
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
