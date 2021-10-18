import { ethers } from 'ethers'
import { Account } from 'near-api-js'
import { getAuroraProvider, getSignerProvider, getBridgeParams, track } from '@near-eth/client'
import { TransactionInfo, TransferStatus } from '@near-eth/client/dist/types'
import * as status from '@near-eth/client/dist/statuses'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getAuroraErc20Address } from '../getAddress'
import { getMetadata } from '../../natural-nep141'

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
export async function act (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await burn(transfer)
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
      decimals?: number
      symbol?: string
    }
  }
): Promise<Transfer[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()
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
  const transferReceipts = receipts.filter(
    (receipt) => receipt.logs.length === 2 && receipt.logs[1]!.topics[0] === '0x5a91b8bc9c1981673db8fb226dbd8fcdd0c23f45cd28abb31403a5392f6dd0c7'
  )
  let metadata = { symbol: 'Symbol N/A', decimals: 0 }
  if (!options.symbol || !options.decimals) {
    metadata = await getMetadata({ nep141Address, options })
  }
  const symbol = options.symbol ?? metadata.symbol
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const decimals = options.decimals ?? metadata.decimals

  const transfers = await Promise.all(transferReceipts.map(async (r) => {
    const txBlock = await provider.getBlock(r.blockHash)
    const recipientHash: string = r.logs[1]!.topics[3]!
    const transfer = {
      id: Math.random().toString().slice(2),
      startTime: new Date(txBlock.timestamp * 1000).toISOString(),
      type: TRANSFER_TYPE,
      status: status.COMPLETE,
      completedStep: BURN,
      errors: [],
      amount: ethers.BigNumber.from(r.logs[1]!.data).toString(),
      decimals,
      symbol,
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

export async function checkBurn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    auroraChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.auroraChainId ?? bridgeParams.auroraChainId
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

export async function sendToNear (
  { nep141Address, amount, recipient, options }: {
    nep141Address: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      auroraErc20Abi?: string
      auroraErc20Address?: string
      signer?: ethers.Signer
      nearAccount?: Account
      auroraEvmAccount?: string
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  let metadata = { symbol: 'Symbol N/A', decimals: 0 }
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

  let transfer: Transfer = {
    ...transferDraft,
    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    decimals,
    symbol,
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
    Buffer.from(transfer.recipient),
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
