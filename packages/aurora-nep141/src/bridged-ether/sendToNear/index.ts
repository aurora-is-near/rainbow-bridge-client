import { ethers } from 'ethers'
import { getAuroraProvider, getSignerProvider, getBridgeParams, track } from '@near-eth/client'
import { TransactionInfo, TransferStatus } from '@near-eth/client/dist/types'
import * as status from '@near-eth/client/dist/statuses'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/aurora-nep141/bridged-ether/sendToNear'

const BURN = 'burn-bridged-ether-to-near'

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
  // sourceToken: 'ETH,
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
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: {
      provider?: ethers.providers.Provider
      etherExitToNearPrecompile?: string
    }
  }
): Promise<Transfer[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()

  const filter = {
    address: options.etherExitToNearPrecompile ?? bridgeParams.etherExitToNearPrecompile,
    fromBlock,
    toBlock,
    topics: [
      '0x5a91b8bc9c1981673db8fb226dbd8fcdd0c23f45cd28abb31403a5392f6dd0c7',
      ethers.utils.hexZeroPad(sender, 32)
    ]
  }
  const logs = await provider.getLogs(filter)

  const transfers = await Promise.all(logs.map(async (log) => {
    const txBlock = await provider.getBlock(log.blockHash)
    const recipientHash: string = log.topics[3]!
    const transfer = {
      id: Math.random().toString().slice(2),
      startTime: new Date(txBlock.timestamp * 1000).toISOString(),
      type: TRANSFER_TYPE,
      status: status.COMPLETE,
      completedStep: BURN,
      errors: [],
      amount: ethers.BigNumber.from(log.data).toString(),
      decimals: 18,
      symbol: 'ETH',
      sourceToken: 'ETH',
      sourceTokenName: 'ETH',
      destinationTokenName: 'ETH',
      sender,
      recipient: `NEAR account hash: ${recipientHash}`,
      burnHashes: [log.transactionHash],
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
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      ethChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      signer?: ethers.Signer
      etherExitToNearPrecompile?: string
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const provider = options.provider ?? getSignerProvider()
  const symbol = options.symbol ?? 'ETH'
  const sourceTokenName = symbol
  const destinationTokenName = symbol
  const sourceToken = symbol
  const decimals = options.decimals ?? 18
  const signer = options.signer ?? provider.getSigner()
  const sender = options.sender ?? (await signer.getAddress()).toLowerCase()

  let transfer: Transfer = {
    ...transferDraft,
    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    symbol,
    sourceToken,
    sourceTokenName,
    destinationTokenName,
    decimals,
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
    etherExitToNearPrecompile?: string
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

  const etherExitToNearPrecompile = options.etherExitToNearPrecompile ?? bridgeParams.etherExitToNearPrecompile // '0xe9217bc70b7ed1f598ddd3199e80b093fa71124f'
  const exitToNearData = '0x00' + Buffer.from(transfer.recipient).toString('hex')
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const txHash = await provider.send('eth_sendTransaction', [{
    from: transfer.sender,
    to: etherExitToNearPrecompile,
    value: ethers.BigNumber.from(transfer.amount).toHexString(),
    data: exitToNearData,
    gas: ethers.BigNumber.from(121000).toHexString()
  }])
  const tx = await provider.getTransaction(txHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: tx.from,
      to: tx.to!,
      nonce: tx.nonce,
      data: tx.data,
      safeReorgHeight
    },
    burnHashes: [...transfer.burnHashes, tx.hash]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
