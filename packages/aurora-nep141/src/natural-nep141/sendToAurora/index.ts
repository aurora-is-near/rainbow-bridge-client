import BN from 'bn.js'
import { ethers } from 'ethers'
import { transactions, Account, utils } from 'near-api-js'
import { getBridgeParams, track, untrack } from '@near-eth/client'
import { TransactionInfo, TransferStatus } from '@near-eth/client/dist/types'
import * as status from '@near-eth/client/dist/statuses'
import { getNearAccount } from '@near-eth/client/dist/utils'
import { urlParams } from '@near-eth/utils'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-nep141/natural-nep141/sendToAurora'

const LOCK = 'lock-natural-nep141-to-aurora'

export interface TransferDraft extends TransferStatus {
  type: string
  lockHashes: string[]
  lockReceiptIds: string[]
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
  // sourceToken,
  // sourceTokenName,
  // decimals,
  status: status.IN_PROGRESS,
  type: TRANSFER_TYPE,

  // Attributes specific to natural-erc20-to-nep141 transfers
  lockHashes: [],
  lockReceiptIds: []
}

export const i18n = {
  en_US: {
    steps: (_transfer: Transfer) => [],
    statusMessage: (transfer: Transfer) => {
      switch (transfer.status) {
        case 'in-progress': return 'Confirming transaction'
        case 'failed': return last(transfer.errors)
        default: return 'Completed'
      }
    },
    callToAction: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Retry'
      return null
    }
  }
}

/**
 * Called when status is FAILED
 * @param transfer Transfer object to act on.
 */
export async function act (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null:
      try {
        if (transfer.sourceToken === 'NEAR') {
          return await lockNear(transfer)
        } else {
          return await lock(transfer)
        }
      } catch (error) {
        console.error(error)
        if (error.message.includes('Failed to redirect to sign transaction')) {
          // Increase time to redirect to wallet before recording an error
          await new Promise(resolve => setTimeout(resolve, 10000))
        }
        if (typeof window !== 'undefined') urlParams.clear('locking')
        throw error
      }
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

export async function checkStatus (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await checkLock(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

export async function checkLock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const id = urlParams.get('locking') as string
  const txHash = urlParams.get('transactionHashes') as string | null
  const errorCode = urlParams.get('errorCode') as string | null
  const clearParams = ['locking', 'transactionHashes', 'errorCode', 'errorMessage']
  if (!id) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect against the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    const newError = 'Failed to process NEAR Wallet transaction.'
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [newError]
    }
  }
  if (id !== transfer.id) {
    const newError = `Couldn't determine transaction outcome.
      Got transfer id '${id} in URL, expected '${transfer.id}`
    console.error(newError)
    return { ...transfer, status: status.FAILED, errors: [`Failed: ${newError}`] }
  }
  if (errorCode) {
    urlParams.clear(...clearParams)
    return { ...transfer, status: status.FAILED, errors: [`Failed: ${errorCode}`] }
  }
  if (!txHash) {
    console.log('Waiting for Near wallet redirect to sign lock')
    return transfer
  }
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const decodedTxHash = utils.serialize.base_decode(txHash)
  const withdrawTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a withdraw
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  // @ts-expect-error TODO
  const txBlock = await nearAccount.connection.provider.block({ blockId: withdrawTx.transaction_outcome.block_hash })
  const startTime = new Date(txBlock.header.timestamp / 10 ** 6).toISOString()

  urlParams.clear(...clearParams)
  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: LOCK,
    startTime,
    lockHashes: [...transfer.lockHashes, txHash]
  }
}

export async function sendToAurora (
  { nep141Address, amount, recipient, options }: {
    nep141Address: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      nearAccount?: Account
      auroraEvmAccount?: string
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const symbol = options.symbol ?? 'TODO' // query nep141 metadata await getSymbol({ erc20Address, options })
  const destinationTokenName = 'a' + symbol
  const sourceTokenName = symbol
  const decimals = options.decimals ?? 18 // query nep141 metadata await getDecimals({ erc20Address, options })
  const sourceToken = nep141Address
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const sender = options.sender ?? nearAccount.accountId

  let transfer = {
    ...transferDraft,
    id: new Date().toISOString(),
    amount: amount.toString(),
    decimals,
    symbol,
    sourceToken,
    sourceTokenName,
    destinationTokenName,
    sender,
    recipient
  }
  try {
    transfer = await lock(transfer, options)
  } catch (error) {
    if (error.message.includes('Failed to redirect to sign transaction')) {
      // Increase time to redirect to wallet before alerting an error
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
    if (typeof window !== 'undefined' && urlParams.get('locking')) {
      // If the urlParam is set then the transfer was tracked so delete it.
      await untrack(urlParams.get('locking') as string)
      urlParams.clear('locking')
    }
    // Throw the error to be handled by frontend
    throw error
  }
  return transfer
}

export async function lock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    auroraEvmAccount?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount

  // nETH (aurora) transfers to Aurora have a different protocol:
  // <relayer_id>:<fee(32 bytes)><eth_address_receiver(20 bytes)>
  const msgPrefix = transfer.sourceToken === auroraEvmAccount ? transfer.sender + ':' + '0'.repeat(64) : ''

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (typeof window !== 'undefined') urlParams.set({ locking: transfer.id })
  if (typeof window !== 'undefined') transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  // If function call error, the transfer will be pending until the transaction id is cleared
  // and the transfer is set to FAILED by checkStatus.
  const tx = await nearAccount.functionCall({
    contractId: transfer.sourceToken,
    methodName: 'ft_transfer_call',
    args: {
      receiver_id: auroraEvmAccount,
      amount: transfer.amount,
      memo: null,
      msg: msgPrefix + transfer.recipient.toLowerCase().slice(2)
    },
    gas: new BN('70' + '0'.repeat(12)),
    attachedDeposit: new BN('1')
  })
  return {
    ...transfer,
    lockHashes: [tx.transaction.hash]
  }
}

export async function wrapAndSendNearToAurora (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      sender?: string
      nearAccount?: Account
      auroraEvmAccount?: string
      wNearNep141?: string
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const symbol = options.symbol ?? 'NEAR'
  const destinationTokenName = 'a' + symbol
  const sourceTokenName = symbol
  const sourceToken = 'NEAR'
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const sender = options.sender ?? nearAccount.accountId

  let transfer: Transfer = {
    ...transferDraft,
    id: new Date().toISOString(),
    amount: amount.toString(),
    decimals: 24,
    symbol,
    sourceToken,
    sourceTokenName,
    destinationTokenName,
    sender,
    recipient
  }
  try {
    transfer = await lockNear(transfer, options)
  } catch (error) {
    if (error.message.includes('Failed to redirect to sign transaction')) {
      // Increase time to redirect to wallet before alerting an error
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
    if (typeof window !== 'undefined' && urlParams.get('locking')) {
      // If the urlParam is set then the transfer was tracked so delete it.
      await untrack(urlParams.get('locking') as string)
      urlParams.clear('locking')
    }
    // Throw the error to be handled by frontend
    throw error
  }

  return transfer
}

export async function lockNear (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    auroraEvmAccount?: string
    wNearNep141?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const wNearNep141 = options.wNearNep141 ?? bridgeParams.wNearNep141
  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount

  const actions = []
  const minStorageBalance = await getMinStorageBalance({
    nep141Address: wNearNep141, nearAccount
  })
  const userStorageBalance = await getStorageBalance({
    nep141Address: wNearNep141,
    accountId: transfer.sender,
    nearAccount
  })
  if (!userStorageBalance || new BN(userStorageBalance.total).lt(new BN(minStorageBalance))) {
    actions.push(transactions.functionCall(
      'storage_deposit',
      Buffer.from(JSON.stringify({
        account_id: transfer.sender,
        registration_only: true
      })),
      new BN('50' + '0'.repeat(12)),
      new BN(minStorageBalance)
    ))
  }

  actions.push(transactions.functionCall(
    'near_deposit',
    Buffer.from(JSON.stringify({})),
    new BN('30' + '0'.repeat(12)),
    new BN(transfer.amount)
  ))
  actions.push(transactions.functionCall(
    'ft_transfer_call',
    Buffer.from(JSON.stringify({
      receiver_id: auroraEvmAccount,
      amount: transfer.amount,
      memo: null,
      msg: transfer.recipient.toLowerCase().slice(2)
    })),
    new BN('70' + '0'.repeat(12)),
    new BN('1')
  ))

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (typeof window !== 'undefined') urlParams.set({ locking: transfer.id })
  if (typeof window !== 'undefined') transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  // If function call error, the transfer will be pending until the transaction id is cleared
  // and the transfer is set to FAILED by checkStatus.
  // @ts-expect-error
  const tx = await nearAccount.signAndSendTransaction(wNearNep141, actions)
  return {
    ...transfer,
    lockHashes: [tx.transaction.hash]
  }
}

export async function getMinStorageBalance (
  { nep141Address, nearAccount }: {
    nep141Address: string
    nearAccount: Account
  }
): Promise<string> {
  try {
    const balance = await nearAccount.viewFunction(
      nep141Address,
      'storage_balance_bounds'
    )
    return balance.min
  } catch (e) {
    const balance = await nearAccount.viewFunction(
      nep141Address,
      'storage_minimum_balance'
    )
    return balance
  }
}

export async function getStorageBalance (
  { nep141Address, accountId, nearAccount }: {
    nep141Address: string
    accountId: string
    nearAccount: Account
  }
): Promise<null | {total: string}> {
  try {
    const balance = await nearAccount.viewFunction(
      nep141Address,
      'storage_balance_of',
      { account_id: accountId }
    )
    return balance
  } catch (e) {
    console.warn(e, nep141Address)
    return null
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
