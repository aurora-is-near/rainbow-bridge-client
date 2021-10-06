import BN from 'bn.js'
import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { utils, Account } from 'near-api-js'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { urlParams, ethOnNearSyncHeight, findEthProof } from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/near-ether/bridged-near/sendToNear'

const BURN = 'burn-e-near-to-natural-near'
const SYNC = 'sync-e-near-to-natural-near'
const UNLOCK = 'unlock-e-near-to-natural-near'

const steps = [
  BURN,
  SYNC,
  UNLOCK
]

export interface TransferDraft extends TransferStatus {
  type: string
  burnHashes: string[]
  burnReceipts: ethers.providers.TransactionReceipt[]
  unlockHashes: string[]
  completedConfirmations: number
  neededConfirmations: number
}

export interface Transfer extends TransferDraft, TransactionInfo {
  id: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  sourceTokenName: string
  symbol: string
  checkSyncInterval?: number
  nextCheckSyncTimestamp?: Date
  proof?: Uint8Array
  startTime?: string
}
export interface TransferOptions {
  provider?: ethers.providers.JsonRpcProvider
  eNEARAddress?: string
  eNEARAbi?: string
  nativeNEARLockerAddress?: string
  sendToNearSyncInterval?: number
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
  burnHashes: [],
  burnReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  unlockHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from Ethereum`,
      [SYNC]: `Wait for ${transfer.neededConfirmations + Number(getBridgeParams().nearEventRelayerMargin)} transfer confirmations for security`,
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in NEAR`
    }),
    statusMessage: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Ethereum'
          case SYNC: return 'Ready to deposit in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to NEAR'
        case BURN: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations + Number(getBridgeParams().nearEventRelayerMargin)}`
        case SYNC: return 'Depositing in NEAR'
        case UNLOCK: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Transfer'
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
    case null: return await burn(transfer)
    case BURN: return await checkSync(transfer)
    case SYNC:
      try {
        return await unlock(transfer)
      } catch (error) {
        console.error(error)
        if (error.message.includes('Failed to redirect to sign transaction')) {
          // Increase time to redirect to wallet before recording an error
          await new Promise(resolve => setTimeout(resolve, 10000))
        }
        if (typeof window !== 'undefined') urlParams.clear('unlocking')
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
    case null: return await checkBurn(transfer)
    case BURN: return await checkSync(transfer)
    case SYNC: return await checkUnlock(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Find all burn transactions sending wNEAR back to NEAR.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.options Optional arguments.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.eNEARAddress ERC-20 NEAR on Ethereum address.
 * @param params.options.eNEARAbi ERC-20 NEAR on Ethereum abi.
 * @returns Array of Ethereum transaction hashes.
 */
export async function findAllTransactions (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: {
      provider?: ethers.providers.Provider
      eNEARAddress?: string
      eNEARAbi?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const ethTokenLocker = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    provider
  )
  const filter = ethTokenLocker.filters.TransferToNearInitiated!(sender)
  const events = await ethTokenLocker.queryFilter(filter, fromBlock, toBlock)
  return events.filter(event => !event.args!.accountId.startsWith('aurora:')).map(event => event.transactionHash)
}

/**
 * Recover all transfers sending wNEAR back to Near.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.options TransferOptions.
 * @returns Array of recovered transfers.
 */
export async function findAllTransfers (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: TransferOptions
  }
): Promise<Transfer[]> {
  const lockTransactions = await findAllTransactions({ fromBlock, toBlock, sender, options })
  const transfers = await Promise.all(lockTransactions.map(async (tx) => await recover(tx, options)))
  return transfers
}

/**
 * Recover transfer from a burn tx hash
 * Track a new transfer at the completedStep = BURN so that it can be unlocked
 * @param burnTxHash Ethereum transaction hash which initiated the transfer.
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  burnTxHash: string,
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const receipt = await provider.getTransactionReceipt(burnTxHash)
  const eNEAR = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    provider
  )
  const filter = eNEAR.filters.TransferToNearInitiated!()
  const events = await eNEAR.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const burnEvent = events.find(event => event.transactionHash === burnTxHash)
  if (!burnEvent) {
    throw new Error('Unable to process burn transaction event.')
  }
  // TODO recover and check eNEAR address. (checking receipt.to doesn't work with multisigs)
  // const erc20Address = burnEvent.args!.token
  const erc20Address = options.eNEARAddress ?? bridgeParams.eNEARAddress
  const amount = burnEvent.args!.amount.toString()
  const recipient = burnEvent.args!.accountId
  const sender = burnEvent.args!.sender
  const symbol = 'NEAR'
  const sourceTokenName = symbol
  const decimals = 24
  const destinationTokenName = symbol

  const txBlock = await burnEvent.getBlock()

  const transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    amount: amount.toString(),
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    symbol,
    decimals,
    status: status.IN_PROGRESS,

    burnHashes: [burnTxHash],
    burnReceipts: [receipt]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Ethereum to NEAR by burning bridged eNEAR tokens.
 * Broadcasts the burn transaction and creates a transfer object.
 * The receipt will be fetched by checkStatus.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient NEAR address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.ethChainId Ethereum chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.eNEARAddress ERC-20 NEAR on Ethereum address.
 * @param params.options.eNEARAbi ERC-20 NEAR on Ethereum abi.
 * @param params.options.signer Ethers signer to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      sender?: string
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      eNEARAddress?: string
      eNEARAbi?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()
  const symbol = 'NEAR'
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = 24
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
    sourceToken: options.eNEARAddress ?? bridgeParams.eNEARAddress,
    symbol,
    sourceTokenName,
    decimals
  }

  transfer = await burn(transfer, options)

  if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer

  return transfer
}

/**
 * Initiate "burn" transaction.
 * Only wait for transaction to have dependable transactionHash created. Avoid
 * blocking to wait for transaction to be mined. Status of transactionHash
 * being mined is then checked in checkStatus.
 */
export async function burn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    ethChainId?: number
    eNEARAddress?: string
    eNEARAbi?: string
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
      `Wrong eth network for burn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const ethTokenLocker = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    options.signer ?? provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingBurnTx = await ethTokenLocker.transferToNear(transfer.amount, transfer.recipient)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to,
      safeReorgHeight,
      data: pendingBurnTx.data,
      nonce: pendingBurnTx.nonce
    },
    burnHashes: [...transfer.burnHashes, pendingBurnTx.hash]
  }
}

export async function checkBurn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    ethChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const burnHash = last(transfer.burnHashes)
  const ethChainId = (await provider.getNetwork()).chainId
  const expectedChainId = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    console.log(
      'Wrong eth network for checkBurn, expected: %s, got: %s',
      expectedChainId, ethChainId
    )
    return transfer
  }
  let burnReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(burnHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
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
      burnReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!burnReceipt) return transfer

  if (!burnReceipt.status) {
    const error = `Transaction failed: ${burnReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }

  if (burnReceipt.transactionHash !== burnHash) {
    // Record the replacement tx burnHash
    transfer = {
      ...transfer,
      burnHashes: [...transfer.burnHashes, burnReceipt.transactionHash]
    }
  }

  const txBlock = await provider.getBlock(burnReceipt.blockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    burnReceipts: [...transfer.burnReceipts, burnReceipt]
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
  const burnReceipt = last(transfer.burnReceipts)
  const eventEmittedAt = burnReceipt.blockNumber
  const syncedTo = await ethOnNearSyncHeight(
    options.nearClientAccount ?? bridgeParams.nearClientAccount,
    nearAccount
  )
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)
  let proof

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'TransferToNearInitiated',
      burnReceipt.transactionHash,
      options.eNEARAddress ?? bridgeParams.eNEARAddress,
      options.eNEARAbi ?? bridgeParams.eNEARAbi,
      provider
    )
    const proofAlreadyUsed = await nearAccount.viewFunction(
      options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
      'is_used_proof',
      Buffer.from(proof),
      { stringify: (args) => args }
    )
    if (proofAlreadyUsed) {
      // TODO: find the event relayer tx hash
      return {
        ...transfer,
        completedStep: UNLOCK,
        completedConfirmations,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Transfer already finalized.']
        // unlockHashes: [...transfer.unlockHashes, txHash]
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
 * Unlock NEAR tokens to transfer.recipient. Causes a redirect to NEAR Wallet,
 * currently dealt with using URL params.
 */
export async function unlock (
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
  if (typeof window !== 'undefined') urlParams.set({ unlocking: transfer.id })
  if (typeof window !== 'undefined') transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  const tx = await nearAccount.functionCall({
    contractId: options.nativeNEARLockerAddress ?? bridgeParams.nativeNEARLockerAddress,
    methodName: 'finalise_eth_to_near_transfer',
    args: proof!,
    // 200Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
    gas: new BN('200' + '0'.repeat(12)),
    attachedDeposit: new BN('100000000000000000000').mul(new BN('600'))
  })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    unlockHashes: [...transfer.unlockHashes, tx.transaction.hash]
  }
}

/**
 * Process a broadcasted unlock transaction
 * checkUnlock is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkUnlock can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 */
export async function checkUnlock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const id = urlParams.get('unlocking') as string | null
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes') as string | null
  const errorCode = urlParams.get('errorCode') as string | null
  const clearParams = ['unlocking', 'transactionHashes', 'errorCode', 'errorMessage']
  if (!id) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A finalization transaction was initiated but could not be verified.
      Click 'Retry' to make sure the transfer is finalized.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (id !== transfer.id) {
    // Another unlocking transaction cannot be in progress, ie if checkUnlock is called on
    // an in progess unlock then the transfer ids must be equal or the url callback is invalid.
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
    // If checkUnlock is called before unlock sig wallet redirect,
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
  const unlockTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, nearAccount.accountId
  )

  // @ts-expect-error : wallet returns errorCode
  if (unlockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error : wallet returns errorCode
  if (unlockTx.status.Failure) {
    urlParams.clear(...clearParams)
    const error = `NEAR transaction failed: ${txHash}`
    console.error(error)
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED,
      unlockHashes: [...transfer.unlockHashes, txHash]
    }
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear(...clearParams)

  return {
    ...transfer,
    completedStep: UNLOCK,
    status: status.COMPLETE,
    unlockHashes: [...transfer.unlockHashes, txHash]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
