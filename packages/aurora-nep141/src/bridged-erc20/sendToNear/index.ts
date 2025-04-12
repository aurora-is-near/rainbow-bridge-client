import BN from 'bn.js'
import { getNearWallet, getNearAccountId } from '@near-eth/client/dist/utils'
import { ethers } from 'ethers'
import { Account, providers as najProviders } from 'near-api-js'
import { getAuroraCloudProvider, getSignerProvider, getBridgeParams, track } from '@near-eth/client'
import { TransactionInfo, TransferStatus } from '@near-eth/client/dist/types'
import * as status from '@near-eth/client/dist/statuses'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getAuroraErc20Address, getNep141Address } from '../getAddress'
import { getMetadata } from '../../natural-nep141'
import { EXIT_TO_NEAR_SIGNATURE, BURN_SIGNATURE } from '@near-eth/utils/dist/aurora'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/aurora-nep141/bridged-erc20/sendToNear'

const BURN = 'burn-bridged-erc20-to-near'

export interface TransferDraft extends TransferStatus {
  type: string
  burnHashes: string[]
  burnReceipts: ethers.providers.TransactionReceipt[]
}

export interface Transfer extends TransactionInfo, TransferDraft {
  id: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  sourceTokenName: string
  symbol: string
  startTime?: string
  auroraEvmAccount?: string
  auroraChainId?: number
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
  status: status.IN_PROGRESS,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  burnHashes: [],
  burnReceipts: []
}

export interface TransferOptions {
  provider?: ethers.providers.JsonRpcProvider
  auroraChainId?: number
  auroraErc20Abi?: string
  signer?: ethers.Signer
  unwrapWNear?: boolean
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (_transfer: Transfer) => [],
    statusMessage: (transfer: Transfer) => {
      switch (transfer.status) {
        case 'in-progress': return 'Confirming transaction'
        case 'failed': return 'Failed: check transaction status from Wallet'
        default: return 'Completed'
      }
    },
    callToAction: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Retry'
      return null
    }
  }
}
/* eslint-enable @typescript-eslint/restrict-template-expressions */

/**
 * Called when status is FAILED
 * @param transfer Transfer object to act on.
 */
export async function act (transfer: Transfer, options?: TransferOptions): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await burn(transfer, options)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

export async function checkStatus (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await checkBurn(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

export async function findAllTransfers (
  { fromBlock, toBlock, sender, nep141Address, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    nep141Address: string
    options?: {
      provider?: ethers.providers.Provider
      auroraErc20Address?: string
      auroraErc20Abi?: string
      auroraEvmAccount?: string
      nearAccount?: Account
      nearProvider?: najProviders.Provider
      decimals?: number
      symbol?: string
    }
  }
): Promise<Transfer[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraCloudProvider({ auroraEvmAccount: options?.auroraEvmAccount })
  const auroraErc20Address = options.auroraErc20Address ?? await getAuroraErc20Address(
    { nep141Address, options }
  ) as string
  const auroraErc20 = new ethers.Contract(
    auroraErc20Address,
    options.auroraErc20Abi ?? bridgeParams.auroraErc20Abi,
    provider
  )
  const filterBurns = auroraErc20.filters.Transfer!(sender, '0x0000000000000000000000000000000000000000')
  const events = await auroraErc20.queryFilter(filterBurns, fromBlock, toBlock)
  const receipts = await Promise.all(events.map(async (event) => {
    const receipt = await provider.getTransactionReceipt(event.transactionHash)
    return receipt
  }))
  // Keep only transfers from Aurora to NEAR.
  const transferReceipts = receipts.filter((receipt) => receipt.logs.find(
    log => log.topics[0] === EXIT_TO_NEAR_SIGNATURE
  ))
  let metadata = { symbol: '', decimals: 0 }
  if (!options.symbol || !options.decimals) {
    metadata = await getMetadata({ nep141Address, options })
  }
  const symbol = options.symbol ?? metadata.symbol
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = options.decimals ?? metadata.decimals

  const transfers = await Promise.all(transferReceipts.map(async (r) => {
    const txBlock = await provider.getBlock(r.blockHash)
    const exitLog = r.logs.find(log => log.topics[0] === EXIT_TO_NEAR_SIGNATURE)!
    const recipientHash: string = exitLog.topics[3]!
    const amount = ethers.BigNumber.from(exitLog.data).toString()

    const transfer = {
      id: Math.random().toString().slice(2),
      startTime: new Date(txBlock.timestamp * 1000).toISOString(),
      type: TRANSFER_TYPE,
      status: status.COMPLETE,
      completedStep: BURN,
      errors: [],
      amount,
      decimals,
      symbol,
      auroraEvmAccount: options?.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
      sourceToken: auroraErc20Address,
      sourceTokenName,
      destinationTokenName,
      sender,
      recipient: `NEAR account hash: ${recipientHash}`,
      burnHashes: [r.transactionHash],
      burnReceipts: []
    }
    return transfer
  }))
  return transfers
}

export async function recover (
  burnTxHash: string,
  options?: {
    provider?: ethers.providers.Provider
    nep141Address?: string
    auroraEvmAccount?: string
    nearAccount?: Account
    nearProvider?: najProviders.Provider
    decimals?: number
    symbol?: string
    auroraChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getAuroraCloudProvider({ auroraEvmAccount: options?.auroraEvmAccount })
  const receipt = await provider.getTransactionReceipt(burnTxHash)

  const exitLog: ethers.providers.Log = receipt.logs.find(log => log.topics[0] === EXIT_TO_NEAR_SIGNATURE)!
  const burnLog: ethers.providers.Log = receipt.logs.find(log => log.topics[0] === BURN_SIGNATURE)!
  const recipientHash: string = exitLog.topics[3]!
  const amount = ethers.BigNumber.from(exitLog.data).toString()
  const auroraErc20Address = '0x' + exitLog.topics[1]!.slice(26)
  const sender = '0x' + burnLog.topics[1]!.slice(26)

  let metadata = { symbol: '', decimals: 0 }
  if (!options.symbol || !options.decimals) {
    const nep141Address = options.nep141Address ?? await getNep141Address({ auroraErc20Address, options })
    metadata = await getMetadata({ nep141Address: nep141Address!, options })
  }
  const symbol = options.symbol ?? metadata.symbol
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = options.decimals ?? metadata.decimals
  const txBlock = await provider.getBlock(receipt.blockHash)
  const bridgeParams = getBridgeParams()

  const transfer = {
    id: Math.random().toString().slice(2),
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    type: TRANSFER_TYPE,
    status: status.COMPLETE,
    completedStep: BURN,
    errors: [],
    amount,
    decimals,
    symbol,
    auroraEvmAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
    auroraChainId: options.auroraChainId ?? bridgeParams.auroraChainId,
    sourceToken: auroraErc20Address,
    sourceTokenName,
    destinationTokenName,
    sender,
    recipient: `NEAR account hash: ${recipientHash}`,
    burnHashes: [receipt.transactionHash],
    burnReceipts: []
  }
  return transfer
}

export async function checkBurn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    auroraChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraCloudProvider({ auroraEvmAccount: transfer.auroraEvmAccount })
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.auroraChainId ?? transfer.auroraChainId ?? bridgeParams.auroraChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong aurora network for checkBurn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  const burnHash = last(transfer.burnHashes)
  let receipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(burnHash)
  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!receipt) {
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
      receipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!receipt) return transfer

  if (!receipt.status) {
    return {
      ...transfer,
      status: status.FAILED,
      burnReceipts: [...transfer.burnReceipts, receipt],
      errors: [...transfer.errors, 'Transaction failed']
    }
  }
  if (receipt.transactionHash !== burnHash) {
    // Record the replacement tx burnHash
    transfer = {
      ...transfer,
      burnHashes: [...transfer.burnHashes, receipt.transactionHash]
    }
  }
  const txBlock = await provider.getBlock(receipt.blockHash)
  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: BURN,
    startTime: new Date(txBlock.timestamp * 1000).toISOString(),
    burnReceipts: [...transfer.burnReceipts, receipt]
  }
}

export async function payNep141Storage (
  { nep141Address, storageDeposit, storageAccount, options }: {
    nep141Address: string
    storageDeposit: string
    storageAccount: string
    options?: {
      nearAccount?: Account
    }
  }
): Promise<najProviders.FinalExecutionOutcome> {
  options = options ?? {}
  const nearWallet = options.nearAccount ?? getNearWallet()
  const isNajAccount = nearWallet instanceof Account
  const accountId = storageAccount ?? await getNearAccountId()
  let tx
  if (isNajAccount) {
    tx = await nearWallet.functionCall({
      contractId: nep141Address,
      methodName: 'storage_deposit',
      args: {
        account_id: accountId,
        registration_only: true
      },
      gas: new BN('100' + '0'.repeat(12)),
      attachedDeposit: new BN(storageDeposit)
    })
  } else {
    tx = await nearWallet.signAndSendTransaction({
      receiverId: nep141Address,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'storage_deposit',
            args: {
              account_id: accountId,
              registration_only: true
            },
            gas: '100' + '0'.repeat(12),
            deposit: storageDeposit
          }
        }
      ]
    })
  }
  return tx
}

export async function sendToNear (
  { nep141Address, amount, recipient, options }: {
    nep141Address: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      auroraChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      auroraErc20Abi?: string
      auroraErc20Address?: string
      signer?: ethers.Signer
      nearAccount?: Account
      nearProvider?: najProviders.Provider
      auroraEvmAccount?: string
      unwrapWNear?: boolean
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  let metadata = { symbol: '', decimals: 0 }
  if (!options.symbol || !options.decimals) {
    metadata = await getMetadata({ nep141Address, options })
  }
  const symbol: string = options.symbol ?? metadata.symbol
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = options.decimals ?? metadata.decimals
  const signer = options.signer ?? provider.getSigner()
  const sender = options.sender ?? (await signer.getAddress()).toLowerCase()
  const auroraErc20Address = options.auroraErc20Address ?? await getAuroraErc20Address({ nep141Address, options })
  if (!auroraErc20Address) throw new Error(`Token not bridged: ${nep141Address}`)
  const bridgeParams = getBridgeParams()

  let transfer: Transfer = {
    ...transferDraft,
    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    decimals,
    symbol,
    auroraEvmAccount: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
    auroraChainId: options.auroraChainId ?? bridgeParams.auroraChainId,
    sourceToken: auroraErc20Address,
    sourceTokenName,
    destinationTokenName,
    sender,
    recipient
  }

  transfer = await burn(transfer, options)

  if (typeof window !== 'undefined') transfer = await track(transfer) as Transfer
  return transfer
}

export async function burn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    auroraChainId?: number
    auroraErc20Abi?: string
    signer?: ethers.Signer
    unwrapWNear?: boolean
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.auroraChainId ?? bridgeParams.auroraChainId
  if (ethChainId !== expectedChainId) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong eth network for burn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const erc20Contract = new ethers.Contract(
    transfer.sourceToken,
    options.auroraErc20Abi ?? bridgeParams.auroraErc20Abi,
    options.signer ?? provider.getSigner()
  )
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const tx = await erc20Contract.withdrawToNear(
    Buffer.from(options.unwrapWNear ? transfer.recipient + ':unwrap' : transfer.recipient),
    transfer.amount,
    { gasLimit: 100000 }
  )
  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
      data: tx.data,
      safeReorgHeight
    },
    burnHashes: [...transfer.burnHashes, tx.hash]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
