import BN from 'bn.js'
import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { utils, Account, providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getSignerProvider, getNearWallet, getNearProvider, formatLargeNum, getBridgeParams } from '@near-eth/client/dist/utils'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { urlParams, ethOnNearSyncHeight, findEthProof, findFinalizationTxOnNear, ExplorerIndexerResult } from '@near-eth/utils'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/near-ether/natural-ether/sendToNear'

const LOCK = 'lock-natural-ether-to-nep141'
const SYNC = 'sync-natural-ether-to-nep141'
const MINT = 'mint-natural-ether-to-nep141'

const steps = [
  LOCK,
  SYNC,
  MINT
]

export interface TransferDraft extends TransferStatus {
  type: string
  lockHashes: string[]
  lockReceipts: ethers.providers.TransactionReceipt[]
  mintHashes: string[]
  completedConfirmations: number
  neededConfirmations: number
}

export interface Transfer extends TransferDraft, TransactionInfo {
  id: string
  startTime: string
  finishTime?: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  sourceTokenName: string
  symbol: string
  checkSyncInterval?: number
  nextCheckSyncTimestamp?: Date
  proof?: Uint8Array
}

export interface TransferOptions {
  provider?: ethers.providers.JsonRpcProvider
  etherCustodianAddress?: string
  etherCustodianAbi?: string
  auroraEvmAccount?: string
  sendToNearSyncInterval?: number
  nearEventRelayerMargin?: number
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  nearClientAccount?: string
  callIndexer?: (query: string) => Promise<ExplorerIndexerResult[] | string>
  eventRelayerAccount?: string
  etherNep141Factory?: string
}

const transferDraft: TransferDraft = {
  // Attributes common to all transfer types
  // amount,
  completedStep: null,
  // destinationTokenName,
  errors: [],
  // recipient,
  // sender,
  // sourceToken: null, // ETH
  // sourceTokenName,
  // decimals,
  status: status.ACTION_NEEDED,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce,                     // tx.nonce of last broadcasted eth tx
  //   data                     // tx.data of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  completedConfirmations: 0,
  lockHashes: [],
  lockReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  mintHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from Ethereum`,
      [SYNC]: `Wait for ${transfer.neededConfirmations + Number(getBridgeParams().nearEventRelayerMargin)} transfer confirmations for security`,
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in NEAR`
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
        case null: return 'Transferring to NEAR'
        case LOCK: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations + Number(getBridgeParams().nearEventRelayerMargin)}`
        case SYNC: return 'Depositing in NEAR'
        case MINT: return 'Transfer complete'
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
    case null: return await lock(transfer)
    case LOCK: return await checkSync(transfer)
    case SYNC:
      try {
        return await mint(transfer)
      } catch (error) {
        console.error(error)
        if (error.message?.includes('Failed to redirect to sign transaction')) {
          // Increase time to redirect to wallet before recording an error
          await new Promise(resolve => setTimeout(resolve, 10000))
        }
        if (typeof window !== 'undefined') urlParams.clear('minting')
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
    case null: return await checkLock(transfer)
    case LOCK: return await checkSync(transfer)
    case SYNC: return await checkMint(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Find all lock transactions sending ETH to NEAR.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.options Optional arguments.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.etherCustodianAddress Rainbow bridge ether custodian address.
 * @param params.options.etherCustodianAbi Rainbow bridge ether custodian abi.
 * @returns Array of Ethereum transaction hashes.
 */
export async function findAllTransactions (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: {
      provider?: ethers.providers.Provider
      etherCustodianAddress?: string
      etherCustodianAbi?: string
      etherCustodianProxyAddress?: string
      etherCustodianProxyAbi?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const etherCustodians: Array<[string, string]> = [
    [options.etherCustodianProxyAddress ?? bridgeParams.etherCustodianProxyAddress,
      options.etherCustodianProxyAbi ?? bridgeParams.etherCustodianProxyAbi],
    [options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
      options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi]
  ]

  const promises = etherCustodians.map(async ([ethCustodianAddress, ethCustodianAbi]) => {
    const ethTokenLocker = new ethers.Contract(
      ethCustodianAddress,
      ethCustodianAbi,
      provider
    )
    const filter = ethTokenLocker.filters.Deposited!(sender)
    const events = await ethTokenLocker.queryFilter(filter, fromBlock, toBlock)
    return events.filter(event => !event.args!.recipient.startsWith('aurora:')).map(event => event.transactionHash)
  })

  const transactions = await Promise.all(promises)
  return transactions.flat()
}

/**
 * Recover all transfers sending ETH to Near.
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
 * Recover transfer from a lock tx hash
 * @param lockTxHash Ethereum transaction hash which initiated the transfer.
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  lockTxHash: string,
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const receipt = await provider.getTransactionReceipt(lockTxHash)
  const ethTokenLocker = new ethers.Contract(
    options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
    options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi,
    provider
  )
  const events = receipt.logs.map(log => ethTokenLocker.interface.parseLog(log))
  const lockedEvent = last(events.filter(event => event?.name === 'Deposited'))
  if (!lockedEvent) {
    throw new Error('Unable to process lock transaction event.')
  }
  const sender = lockedEvent.args!.sender
  const recipient = lockedEvent.args!.recipient
  const amount = lockedEvent.args!.amount.toString()
  const symbol = 'ETH'
  const sourceTokenName = symbol
  const sourceToken = symbol
  const destinationTokenName = 'n' + symbol
  const decimals = 18

  const txBlock = await provider.getBlock(receipt.blockNumber)

  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    sourceToken,
    symbol,
    decimals,
    status: status.IN_PROGRESS,
    lockHashes: [lockTxHash],
    lockReceipts: [receipt]
  }
  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Ethereum to NEAR by locking tokens.
 * Broadcasts the lock transaction and creates a transfer object.
 * The receipt will be fetched by checkStatus.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient NEAR address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol ERC-20 symbol (ETH if not provided).
 * @param params.options.decimals ERC-20 decimals (18 if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.ethChainId Ethereum chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.etherCustodianProxyAddress Rainbow bridge ether custodian proxy address.
 * @param params.options.etherCustodianProxyAbi Rainbow bridge ether custodian proxy abi.
 * @param params.options.signer Ethers signer to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      etherCustodianProxyAddress?: string
      etherCustodianProxyAbi?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  const symbol = options.symbol ?? 'ETH'
  const sourceTokenName = symbol
  const sourceToken = symbol
  const destinationTokenName = 'n' + symbol
  const decimals = options.decimals ?? 18
  const signer = options.signer ?? provider.getSigner()
  const sender = options.sender ?? (await signer.getAddress()).toLowerCase()

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    symbol,
    sourceToken,
    decimals
  }

  transfer = await lock(transfer, options)

  if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer

  return transfer
}

/**
 * Initiate "lock" transaction.
 * Only wait for transaction to have dependable transactionHash created. Avoid
 * blocking to wait for transaction to be mined. Status of transactionHash
 * being mined is then checked in checkStatus.
 */
export async function lock (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    ethChainId?: number
    etherCustodianProxyAddress?: string
    etherCustodianProxyAbi?: string
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
      `Wrong eth network for lock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const ethTokenLocker = new ethers.Contract(
    options.etherCustodianProxyAddress ?? bridgeParams.etherCustodianProxyAddress,
    options.etherCustodianProxyAbi ?? bridgeParams.etherCustodianProxyAbi,
    options.signer ?? provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingLockTx = await ethTokenLocker.depositToNear(
    transfer.recipient, 0, { value: transfer.amount }
  )

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingLockTx.from,
      to: pendingLockTx.to,
      nonce: pendingLockTx.nonce,
      data: pendingLockTx.data,
      value: pendingLockTx.value.toString(),
      safeReorgHeight
    },
    lockHashes: [...transfer.lockHashes, pendingLockTx.hash]
  }
}

export async function checkLock (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    ethChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const lockHash = last(transfer.lockHashes)
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkLock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  let lockReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(lockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!lockReceipt) {
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        data: transfer.ethCache.data,
        value: transfer.ethCache.value
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      lockReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!lockReceipt) return transfer

  if (!lockReceipt.status) {
    const error = `Transaction failed: ${lockReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      lockReceipts: [...transfer.lockReceipts, lockReceipt]
    }
  }
  if (lockReceipt.transactionHash !== lockHash) {
    // Record the replacement tx lockHash
    transfer = {
      ...transfer,
      lockHashes: [...transfer.lockHashes, lockReceipt.transactionHash]
    }
  }

  const txBlock = await provider.getBlock(lockReceipt.blockHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    lockReceipts: [...transfer.lockReceipts, lockReceipt]
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
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()

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
  const lockReceipt = last(transfer.lockReceipts)
  const eventEmittedAt = lockReceipt.blockNumber
  const syncedTo = await ethOnNearSyncHeight(
    options.nearClientAccount ?? bridgeParams.nearClientAccount,
    nearProvider
  )
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)
  let proof

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'Deposited',
      lockReceipt.transactionHash,
      options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
      options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi,
      provider
    )
    const isProxyTransfer = lockReceipt.logs.find(
      (log: { address: string }) => log.address.toLowerCase() === bridgeParams.etherCustodianProxyAddress.toLowerCase()
    )
    let proofAlreadyUsed = false
    if (isProxyTransfer) {
      const result = await nearProvider.query<CodeResult>({
        request_type: 'call_function',
        account_id: options.etherNep141Factory ?? bridgeParams.etherNep141Factory,
        method_name: 'is_used_proof',
        args_base64: Buffer.from(proof).toString('base64'),
        finality: 'optimistic'
      })
      proofAlreadyUsed = Boolean(result.result[0])
    } else {
      // Transfers prior to ether custodian proxy migration were all finalized.
      proofAlreadyUsed = true
    }
    if (proofAlreadyUsed) {
      if (options.callIndexer) {
        try {
          const { transactions, timestamps } = await findFinalizationTxOnNear({
            proof: Buffer.from(proof).toString('base64'),
            connectorAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
            eventRelayerAccount: options.eventRelayerAccount ?? bridgeParams.eventRelayerAccount,
            finalizationMethod: 'deposit',
            ethTxHash: lockReceipt.transactionHash,
            callIndexer: options.callIndexer
          })
          let finishTime: string | undefined
          if (timestamps.length > 0) {
            finishTime = new Date(timestamps[0]! / 10 ** 6).toISOString()
          }
          transfer = {
            ...transfer,
            finishTime,
            mintHashes: [...transfer.mintHashes, ...transactions]
          }
        } catch (error) {
          // Not finding the finalization tx should not prevent processing/recovering the transfer.
          console.error(error)
        }
      }
      return {
        ...transfer,
        completedStep: MINT,
        completedConfirmations,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Transfer already finalized.']
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
 * Mint ETH tokens to transfer.recipient. Causes a redirect to NEAR Wallet,
 * currently dealt with using URL params.
 */
export async function mint (
  transfer: Transfer | string,
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearWallet = options.nearAccount ?? getNearWallet()
  const isNajAccount = nearWallet instanceof Account
  const browserRedirect = typeof window !== 'undefined' && (isNajAccount || nearWallet.type === 'browser')

  // Check if the transfer is finalized and get the proof if not
  transfer = await checkSync(transfer, options)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (browserRedirect) urlParams.set({ minting: transfer.id })
  if (browserRedirect) transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  let tx
  if (isNajAccount) {
    tx = await nearWallet.functionCall({
      contractId: options.etherNep141Factory ?? bridgeParams.etherNep141Factory,
      methodName: 'deposit',
      args: proof!,
      // 200Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      gas: new BN('200' + '0'.repeat(12)),
      // We need to attach tokens because minting increases the contract state, by <600 bytes, which
      // requires an additional 0.06 NEAR to be deposited to the account for state staking.
      // Note technically 0.0537 NEAR should be enough, but we round it up to stay on the safe side.
      attachedDeposit: new BN('6' + '0'.repeat(22))
    })
  } else {
    tx = await nearWallet.signAndSendTransaction({
      receiverId: options.etherNep141Factory ?? bridgeParams.etherNep141Factory,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'deposit',
            args: proof!,
            gas: '200' + '0'.repeat(12),
            deposit: '6' + '0'.repeat(22)
          }
        }
      ]
    })
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    mintHashes: [...transfer.mintHashes, tx.transaction.hash]
  }
}

/**
 * Process a broadcasted mint transaction
 * checkMint is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkMint can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 */
export async function checkMint (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    nearProvider?: najProviders.Provider
  }
): Promise<Transfer> {
  options = options ?? {}
  let txHash: string
  let clearParams
  if (transfer.mintHashes.length === 0) {
    const id = urlParams.get('minting') as string | null
    // NOTE: when a single tx is executed, transactionHashes is equal to that hash
    const transactionHashes = urlParams.get('transactionHashes') as string | null
    const errorCode = urlParams.get('errorCode') as string | null
    clearParams = ['minting', 'transactionHashes', 'errorCode', 'errorMessage']
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
      // Another minting transaction cannot be in progress, ie if checkMint is called on
      // an in progess mint then the transfer ids must be equal or the url callback is invalid.
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
    if (!transactionHashes) {
      // If checkMint is called before mint sig wallet redirect,
      // log the error but don't mark as FAILED and don't clear url params
      // as the wallet redirect has not happened yet
      const newError = 'Tx hash not received: pending redirect or wallet error'
      console.log(newError)
      return transfer
    }
    if (transactionHashes.includes(',')) {
      urlParams.clear(...clearParams)
      const newError = 'Error from wallet: expected single txHash, got: ' + transactionHashes
      console.error(newError)
      return {
        ...transfer,
        status: status.FAILED,
        errors: [...transfer.errors, newError]
      }
    }
    txHash = transactionHashes
  } else {
    txHash = last(transfer.mintHashes)
  }

  const decodedTxHash = utils.serialize.base_decode(txHash)
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  const mintTx = await nearProvider.txStatus(
    decodedTxHash, options?.nearAccount?.accountId ?? 'todo'
  )

  // @ts-expect-error : wallet returns errorCode
  if (mintTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error : wallet returns errorCode
  if (mintTx.status.Failure) {
    if (clearParams) urlParams.clear(...clearParams)
    const error = `NEAR transaction failed: ${txHash}`
    console.error(error)
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED,
      mintHashes: [...transfer.mintHashes, txHash]
    }
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  if (clearParams) urlParams.clear(...clearParams)

  return {
    ...transfer,
    completedStep: MINT,
    status: status.COMPLETE,
    mintHashes: [...transfer.mintHashes, txHash]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
