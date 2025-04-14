import BN from 'bn.js'
import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { utils, Account, providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import {
  getEthProvider,
  getNearWallet,
  getNearProvider,
  formatLargeNum,
  getSignerProvider,
  getBridgeParams
} from '@near-eth/client/dist/utils'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import {
  urlParams,
  ethOnNearSyncHeight,
  findEthProof,
  findFinalizationTxOnNear,
  ExplorerIndexerResult,
  nep141
} from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getDecimals, getSymbol } from '../getMetadata'
import getNep141Address from '../getAddress'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/nep141-erc20/bridged-erc20/sendToNear'

const BURN = 'burn-bridged-erc20-to-nep141'
const SYNC = 'sync-bridged-erc20-to-nep141'
const UNLOCK = 'unlock-bridged-erc20-to-nep141'

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
  startTime: string
  finishTime?: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  symbol: string
  sourceTokenName: string
  checkSyncInterval?: number
  nextCheckSyncTimestamp?: Date
  proof?: Uint8Array
}

export interface TransferOptions {
  provider?: ethers.providers.JsonRpcProvider
  erc20FactoryAddress?: string
  erc20FactoryAbi?: string
  erc20Abi?: string
  sendToNearSyncInterval?: number
  nep141LockerAccount?: string
  nearEventRelayerMargin?: number
  nearAccount?: Account
  nearProvider?: najProviders.Provider
  nearClientAccount?: string
  callIndexer?: (query: string) => Promise<ExplorerIndexerResult[] | string>
  eventRelayerAccount?: string
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
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} to NEAR`,
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
        case null: return 'Transferring to NEAR'
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
export async function act (transfer: Transfer, options?: TransferOptions): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await burn(transfer, options)
    case BURN: return await checkSync(transfer, options)
    case SYNC:
      try {
        return await unlock(transfer, options)
      } catch (error) {
        console.error(error)
        if (error.message?.includes('Failed to redirect to sign transaction')) {
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
 * Find all burn transactions sending `erc20Address` tokens to NEAR.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.erc20Address Token address.
 * @param params.options Optional arguments.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.erc20FactoryAddress Rainbow bridge ERC-20 token factory address.
 * @param params.options.erc20FactoryAbi Rainbow bridge ERC-20 token factory abi.
 * @returns Array of Ethereum transaction hashes.
 */
export async function findAllTransactions (
  { fromBlock, toBlock, sender, erc20Address, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    erc20Address: string
    options?: {
      provider?: ethers.providers.Provider
      erc20FactoryAddress?: string
      erc20FactoryAbi?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const erc20Factory = new ethers.Contract(
    options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
    options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
    provider
  )
  const filter = erc20Factory.filters.Withdraw!(null, sender, null, null, erc20Address)
  const events = await erc20Factory.queryFilter(filter, fromBlock, toBlock)
  return events.filter(event => !event.args!.recipient.startsWith('aurora:')).map(event => event.transactionHash)
}

/**
 * Recover all transfers sending `erc20Address` tokens to Near.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock Ethereum block number.
 * @param params.toBlock 'latest' | Ethereum block number.
 * @param params.sender Ethereum address.
 * @param params.erc20Address Token address.
 * @param params.options TransferOptions.
 * @returns Array of recovered transfers.
 */
export async function findAllTransfers (
  { fromBlock, toBlock, sender, erc20Address, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    erc20Address: string
    options?: TransferOptions & {
      decimals?: number
      symbol?: string
    }
  }
): Promise<Transfer[]> {
  const lockTransactions = await findAllTransactions({ fromBlock, toBlock, sender, erc20Address, options })
  const transfers = await Promise.all(lockTransactions.map(async (tx) => await recover(tx, options)))
  return transfers
}

/**
 * Recover transfer from a burn tx hash.
 * @param burnTxHash Ethereum transaction hash which initiated the transfer.
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  burnTxHash: string,
  options?: TransferOptions & {
    decimals?: number
    symbol?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const receipt = await provider.getTransactionReceipt(burnTxHash)
  const erc20Factory = new ethers.Contract(
    options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
    options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
    provider
  )
  const filter = erc20Factory.filters.Withdraw!()
  const events = await erc20Factory.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const burnEvent = events.find(event => event.transactionHash === burnTxHash)
  if (!burnEvent) {
    throw new Error('Unable to process burn transaction event.')
  }
  const erc20Address = burnEvent.args!.tokenEthAddress
  const amount = burnEvent.args!.amount.toString()
  const recipient = burnEvent.args!.recipient
  const sender = burnEvent.args!.sender
  const symbol: string = options.symbol ?? await getSymbol({ erc20Address, options })
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = options.decimals ?? await getDecimals({ erc20Address, options })

  const txBlock = await burnEvent.getBlock()

  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    amount,
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
 * Initiate a transfer from Ethereum to NEAR by burning tokens.
 * Broadcasts the burn transaction and creates a transfer object.
 * The receipt will be fetched by checkStatus.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address ERC-20 address of token to transfer.
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient NEAR address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol ERC-20 symbol (queried if not provided).
 * @param params.options.decimals ERC-20 decimals (queried if not provided).
 * @param params.options.nep141Address NEP-141 address of token to transfer.
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.ethChainId Ethereum chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.erc20FactoryAddress Rainbow bridge ERC-20 token factory address.
 * @param params.options.erc20FactoryAbi Rainbow bridge ERC-20 token factory abi.
 * @param params.options.erc20Abi ERC-20 token abi.
 * @param params.options.signer Ethers signer to use.
 * @returns The created transfer object.
 */
export async function initiate (
  { erc20Address, amount, recipient, options }: {
    erc20Address: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      nep141Address?: string
      sender?: string
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      erc20FactoryAddress?: string
      erc20FactoryAbi?: string
      erc20Abi?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  const symbol: string = options.symbol ?? await getSymbol({ erc20Address, options })
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = options.decimals ?? await getDecimals({ erc20Address, options })
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
    sourceToken: erc20Address,
    sourceTokenName,
    symbol,
    decimals
  }

  transfer = await burn(transfer, options)

  if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer

  return transfer
}

export async function burn (
  transfer: Transfer,
  options?: {
    nep141Address?: string
    provider?: ethers.providers.JsonRpcProvider
    ethChainId?: number
    erc20FactoryAddress?: string
    erc20FactoryAbi?: string
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

  const erc20Factory = new ethers.Contract(
    options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
    options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
    options.signer ?? provider.getSigner()
  )
  const nep141Address = options.nep141Address ?? await erc20Factory.ethToNearToken(transfer.sourceToken)

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingBurnTx = await erc20Factory.withdraw(nep141Address, transfer.amount, transfer.recipient)

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
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkBurn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  let burnReceipt = await provider.getTransactionReceipt(burnHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
    // don't break old transfers in case they were made before this functionality is released
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
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
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
  const burnReceipt = last(transfer.burnReceipts)
  const eventEmittedAt = burnReceipt.blockNumber
  const syncedTo = await ethOnNearSyncHeight(
    options.nearClientAccount ?? bridgeParams.nearClientAccount,
    nearProvider
  )
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)
  let proof

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'Withdraw',
      burnReceipt.transactionHash,
      options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
      options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
      provider
    )
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      account_id: options.nep141LockerAccount ?? bridgeParams.nep141LockerAccount,
      method_name: 'is_used_proof',
      args_base64: Buffer.from(proof).toString('base64'),
      finality: 'optimistic'
    })
    const proofAlreadyUsed = JSON.parse(Buffer.from(result.result).toString())
    if (proofAlreadyUsed) {
      if (options.callIndexer) {
        try {
          const { transactions, timestamps } = await findFinalizationTxOnNear({
            proof: Buffer.from(proof).toString('base64'),
            connectorAccount: options.nep141LockerAccount ?? bridgeParams.nep141LockerAccount,
            eventRelayerAccount: options.eventRelayerAccount ?? bridgeParams.eventRelayerAccount,
            finalizationMethod: 'withdraw',
            ethTxHash: burnReceipt.transactionHash,
            callIndexer: options.callIndexer
          })
          let finishTime: string | undefined
          if (timestamps.length > 0) {
            finishTime = new Date(timestamps[0]! / 10 ** 6).toISOString()
          }
          transfer = {
            ...transfer,
            finishTime,
            unlockHashes: [...transfer.unlockHashes, ...transactions]
          }
        } catch (error) {
          // Not finding the finalization tx should not prevent processing/recovering the transfer.
          console.error(error)
        }
      }
      return {
        ...transfer,
        completedStep: UNLOCK,
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
    proof // used when checkSync() is called by unlock()
  }
}

export async function unlock (
  transfer: Transfer | string,
  options?: Omit<TransferOptions, 'provider'> & {
    provider?: ethers.providers.JsonRpcProvider
    signer?: ethers.Signer
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearWallet = options.nearAccount ?? getNearWallet()
  const nearProvider = options.nearProvider ?? getNearProvider()
  const isNajAccount = nearWallet instanceof Account
  const browserRedirect = typeof window !== 'undefined' && (isNajAccount || nearWallet.type === 'browser')

  // Check if the transfer is finalized and get the proof if not
  transfer = await checkSync(transfer, options)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  const nep141Address = await getNep141Address({
    erc20Address: transfer.sourceToken,
    options
  })
  const minStorageBalance = await nep141.getMinStorageBalance({
    nep141Address: nep141Address, nearProvider
  })
  const userStorageBalance = await nep141.getStorageBalance({
    nep141Address: nep141Address,
    accountId: transfer.recipient,
    nearProvider
  })
  const transactions = []
  if (!userStorageBalance || new BN(userStorageBalance.total).lt(new BN(minStorageBalance))) {
    transactions.push({
      receiverId: nep141Address,
      actions: [{
        type: 'FunctionCall',
        params: {
          methodName: 'storage_deposit',
          args: {
            account_id: transfer.recipient,
            registration_only: true
          },
          gas: '50' + '0'.repeat(12),
          deposit: minStorageBalance
        }
      }]
    })
  }
  transactions.push({
    receiverId: options.nep141LockerAccount ?? bridgeParams.nep141LockerAccount,
    actions: [{
      type: 'FunctionCall',
      params: {
        methodName: 'withdraw',
        args: Buffer.from(proof!),
        gas: '250' + '0'.repeat(12),
        deposit: '6' + '0'.repeat(22)
      }
    }]
  })

  if (browserRedirect) urlParams.set({ unlocking: transfer.id })
  if (browserRedirect) transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  // @ts-expect-error
  const txs = await nearWallet.signAndSendTransactions({ transactions })
  const tx = last(txs)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    unlockHashes: [...transfer.unlockHashes, tx.transaction.hash]
  }
}

export async function checkUnlock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    nearProvider?: najProviders.Provider
  }
): Promise<Transfer> {
  options = options ?? {}
  let txHash: string
  let clearParams
  if (transfer.unlockHashes.length === 0) {
    const id = urlParams.get('unlocking') as string | null
    // NOTE: when a single tx is executed, transactionHashes is equal to that hash
    const transactionHashes = urlParams.get('transactionHashes') as string | null
    const errorCode = urlParams.get('errorCode') as string | null
    clearParams = ['unlocking', 'transactionHashes', 'errorCode', 'errorMessage']
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
    if (!transactionHashes) {
      // If checkUnlock is called before unlock sig wallet redirect,
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
    txHash = last(transfer.unlockHashes)
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
      unlockHashes: [...transfer.unlockHashes, txHash]
    }
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  if (clearParams) urlParams.clear(...clearParams)

  return {
    ...transfer,
    completedStep: UNLOCK,
    status: status.COMPLETE,
    unlockHashes: [...transfer.unlockHashes, txHash]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
