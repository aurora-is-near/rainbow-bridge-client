import { borshifyOutcomeProof, nearOnEthSyncHeight, findNearProof } from '@near-eth/utils'
import { ethers } from 'ethers'
import bs58 from 'bs58'
import { utils, Account } from 'near-api-js'
import BN from 'bn.js'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import { FinalExecutionOutcome } from 'near-api-js/lib/providers'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { TransferStatus, TransactionInfo } from '@near-eth/client/dist/types'
import {
  getSignerProvider,
  getAuroraProvider,
  getEthProvider,
  getNearAccount,
  formatLargeNum,
  getBridgeParams
} from '@near-eth/client/dist/utils'
import { EXIT_TO_ETHEREUM_SIGNATURE } from '@near-eth/utils/dist/aurora'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/aurora-ether/bridged-ether/sendToEthereum'

const BURN = 'burn-bridged-ether-to-ethereum'
const AWAIT_FINALITY = 'await-finality-bridged-ether-to-ethereum'
const SYNC = 'sync-bridged-ether-to-ethereum'
const UNLOCK = 'unlock-bridged-ether-to-ethereum'

const steps = [
  BURN,
  AWAIT_FINALITY,
  SYNC,
  UNLOCK
]

class TransferError extends Error {}

export interface TransferDraft extends TransferStatus {
  type: string
  finalityBlockHeights: number[]
  nearOnEthClientBlockHeight: null | number
  unlockHashes: string[]
  unlockReceipts: ethers.providers.TransactionReceipt[]
  burnHashes: string[]
  burnReceipts: string[]
  nearBurnHashes: string[]
  nearBurnReceiptIds: string[]
  nearBurnReceiptBlockHeights: number[]
}

export interface Transfer extends TransferDraft, TransactionInfo {
  id: string
  startTime: string
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
  provider?: ethers.providers.Provider
  etherCustodianAddress?: string
  etherCustodianAbi?: string
  sendToEthereumSyncInterval?: number
  ethChainId?: number
  nearAccount?: Account
  ethClientAddress?: string
  ethClientAbi?: string
  auroraProvider?: ethers.providers.JsonRpcProvider
  auroraEvmAccount?: string
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
  // symbol,
  // decimals,
  status: status.ACTION_NEEDED,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  //   data                     // tx.data of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  finalityBlockHeights: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  burnHashes: [],
  burnReceipts: [],
  nearBurnHashes: [],
  nearBurnReceiptIds: [],
  nearBurnReceiptBlockHeights: [],
  unlockHashes: [],
  unlockReceipts: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (transfer: Transfer) => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.sourceTokenName} from Aurora`,
      [AWAIT_FINALITY]: 'Confirming in Aurora',
      [SYNC]: 'Confirming in Aurora. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals).toString()} ${transfer.destinationTokenName} in Ethereum`
    }),
    statusMessage: (transfer: Transfer) => {
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
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await unlock(transfer)
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
    case BURN: return await checkFinality(transfer)
    case AWAIT_FINALITY: return await checkSync(transfer)
    case SYNC: return await checkUnlock(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Parse the burn receipt id and block height needed to complete
 * the step BURN
 */
export async function parseBurnReceipt (
  nearBurnTx: FinalExecutionOutcome,
  nearAccount: Account
): Promise<{id: string, blockHeight: number }> {
  const receiptIds = nearBurnTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Burn expects only one receipt, got ${receiptIds.length}.
      Full withdrawal transaction: ${JSON.stringify(nearBurnTx)}`
    )
  }

  // Get receipt information for recording and building burn proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = nearBurnTx.receipts_outcome
    .find(r => r.id === txReceiptId)!
    .outcome
  const burnReceiptId = successReceiptOutcome.receipt_ids[0]!

  const txReceiptBlockHash = nearBurnTx.receipts_outcome
    .find(r => r.id === burnReceiptId)!
    // @ts-expect-error TODO
    .block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: burnReceiptId, blockHeight: receiptBlockHeight }
}

export async function findAllTransactions (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: {
      provider?: ethers.providers.Provider
      etherExitToEthereumPrecompile?: string
    }
  }
): Promise<string[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()

  const filter = {
    address: options.etherExitToEthereumPrecompile ?? bridgeParams.etherExitToEthereumPrecompile,
    fromBlock,
    toBlock,
    topics: [
      EXIT_TO_ETHEREUM_SIGNATURE,
      ethers.utils.hexZeroPad(sender, 32)
    ]
  }
  const logs = await provider.getLogs(filter)
  return logs.map(l => l.transactionHash)
}

export async function findAllTransfers (
  { fromBlock, toBlock, sender, options }: {
    fromBlock: number | string
    toBlock: number | string
    sender: string
    options?: TransferOptions
  }
): Promise<Transfer[]> {
  const burnTransactions = await findAllTransactions({ fromBlock, toBlock, sender, options })
  const transfers = await Promise.all(burnTransactions.map(async (tx) => await recover(tx, sender, options)))
  return transfers
}

/**
 * Recover transfer from a burn tx hash
 * @param burnTxHash Aurora or NEAR relayer tx hash containing the token withdrawal
 * @param sender Near account sender of burnTxHash (aurora relayer)
 * @param options TransferOptions optional arguments.
 * @returns The recovered transfer object
 */
export async function recover (
  burnTxHash: string,
  sender: string = 'todo',
  options?: TransferOptions
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()

  let nearBurnTxHash
  let decodedTxHash
  let auroraTxHash
  let auroraSender = 'NA'
  if (/^0x[A-Fa-f0-9]{64}$/.test(burnTxHash)) {
    const auroraProvider = options.auroraProvider ?? getAuroraProvider()
    // Ethers formats the receipts and removes nearTransactionHash
    const auroraBurnReceipt = await auroraProvider.send('eth_getTransactionReceipt', [burnTxHash])
    decodedTxHash = Buffer.from(auroraBurnReceipt.nearTransactionHash.slice(2), 'hex')
    nearBurnTxHash = bs58.encode(decodedTxHash)
    const exitLog: ethers.providers.Log = auroraBurnReceipt.logs.find(
      (log: ethers.providers.Log) => log.topics[0] === EXIT_TO_ETHEREUM_SIGNATURE
    )
    auroraSender = '0x' + exitLog.topics[1]!.slice(26)
    auroraTxHash = burnTxHash
  } else {
    nearBurnTxHash = burnTxHash
    decodedTxHash = utils.serialize.base_decode(nearBurnTxHash)
  }

  const burnTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, sender
  )

  if (!auroraTxHash) {
    auroraTxHash = ethers.utils.keccak256(
      Buffer.from(burnTx.transaction.actions[0].FunctionCall.args, 'base64')
    )
  }

  // @ts-expect-error TODO
  if (burnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Withdraw transaction pending: ${nearBurnTxHash}`)
  }

  // Check status of tx broadcasted by relayer
  // @ts-expect-error TODO
  if (burnTx.status.Failure) {
    throw new Error(`Withdraw transaction failed: ${nearBurnTxHash}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class BurnEvent {
    constructor (args: any) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [BurnEvent, {
      kind: 'struct',
      fields: [
        ['amount', 'u128'],
        ['recipient_id', [20]],
        ['eth_custodian_address', [20]]
      ]
    }]
  ])
  // @ts-expect-error TODO
  const withdrawResult = burnTx.receipts_outcome[1].outcome.status.SuccessValue
  const burnEvent = deserializeBorsh(
    SCHEMA, BurnEvent, Buffer.from(withdrawResult, 'base64')
  ) as { amount: BN, recipient_id: Uint8Array, eth_custodian_address: Uint8Array}

  const amount = burnEvent.amount.toString()
  const recipient = '0x' + Buffer.from(burnEvent.recipient_id).toString('hex')
  const etherCustodian = Buffer.from(burnEvent.eth_custodian_address).toString('hex')

  const etherCustodianAddress: string = options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress
  if (etherCustodian !== etherCustodianAddress.slice(2).toLowerCase()) {
    throw new Error(
      `Unexpected ether custodian: got${etherCustodian},
      expected ${etherCustodianAddress}`
    )
  }

  const symbol = 'ETH'
  const destinationTokenName = symbol
  const decimals = 18
  const sourceTokenName = 'a' + symbol
  const sourceToken = symbol

  const nearBurnReceipt = await parseBurnReceipt(burnTx, nearAccount)

  // @ts-expect-error TODO
  const txBlock = await nearAccount.connection.provider.block({ blockId: burnTx.transaction_outcome.block_hash })

  // various attributes stored as arrays, to keep history of retries
  const transfer = {
    ...transferDraft,

    id: Math.random().toString().slice(2),
    startTime: new Date(txBlock.header.timestamp / 10 ** 6).toISOString(),
    amount,
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender: auroraSender,
    sourceToken,
    sourceTokenName,
    symbol,
    decimals,
    burnHashes: [auroraTxHash],
    nearBurnHashes: [nearBurnTxHash],
    nearBurnReceiptIds: [nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [nearBurnReceipt.blockHeight]
  }

  // Check transfer status
  return await checkSync(transfer, options)
}

/**
 * Initiate a transfer from Aurora to Ethereum by burning tokens.
 * Broadcasts the lock transaction and creates a transfer object.
 * The receipt will be fetched by checkStatus.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.amount Number of tokens to transfer.
 * @param params.recipient Ethereum address to receive tokens on the other side of the bridge.
 * @param params.options Optional arguments.
 * @param params.options.symbol Ether symbol (ETH if not provided).
 * @param params.options.decimals Ether decimals (18 if not provided).
 * @param params.options.sender Sender of tokens (defaults to the connected wallet address).
 * @param params.options.auroraChainId Aurora chain id of the bridge.
 * @param params.options.provider Ethereum provider to use.
 * @param params.options.etherExitToEthereumPrecompile Aurora ether exit to Ethereum precompile address.
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
      auroraChainId?: number
      provider?: ethers.providers.JsonRpcProvider
      etherExitToEthereumPrecompile?: string
      signer?: ethers.Signer
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const symbol = options.symbol ?? 'ETH'
  const destinationTokenName = symbol
  const sourceTokenName = 'a' + symbol
  const sourceToken = symbol
  const decimals = options.decimals ?? 18

  const provider = options.provider ?? getSignerProvider()
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
    sourceToken,
    sourceTokenName,
    symbol,
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
    auroraChainId?: number
    etherExitToEthereumPrecompile?: string
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
      `Wrong aurora network for burn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const safeReorgHeight = await provider.getBlockNumber() - 20
  const exitToEthereumData = '0x00' + transfer.recipient.slice(2)
  let txHash
  if (typeof window !== 'undefined') {
    // MetaMask
    txHash = await provider.send('eth_sendTransaction', [{
      from: transfer.sender,
      to: options.etherExitToEthereumPrecompile ?? bridgeParams.etherExitToEthereumPrecompile,
      value: ethers.BigNumber.from(transfer.amount).toHexString(),
      data: exitToEthereumData,
      gas: ethers.BigNumber.from(121000).toHexString()
    }])
  } else {
    // Ethers signer
    const transaction = await options.signer?.sendTransaction({
      from: transfer.sender,
      to: options.etherExitToEthereumPrecompile ?? bridgeParams.etherExitToEthereumPrecompile,
      value: ethers.BigNumber.from(transfer.amount),
      data: exitToEthereumData,
      gasLimit: ethers.BigNumber.from(121000)
    })
    txHash = transaction!.hash
  }
  const pendingBurnTx = await provider.getTransaction(txHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to!,
      data: pendingBurnTx.data,
      nonce: pendingBurnTx.nonce,
      value: pendingBurnTx.value.toString(),
      safeReorgHeight
    },
    burnHashes: [...transfer.burnHashes, txHash]
  }
}

export async function checkBurn (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.JsonRpcProvider
    auroraChainId?: number
    auroraRelayerAccount?: string
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()

  const burnHash = last(transfer.burnHashes)

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.auroraChainId ?? bridgeParams.auroraChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong aurora network for checkBurn, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  // Ethers formats the receipts and removes nearTransactionHash
  let burnReceipt = await provider.send('eth_getTransactionReceipt', [burnHash])

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        value: transfer.ethCache.value
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      // Ethers formats the receipts and removes nearTransactionHash
      burnReceipt = await provider.send('eth_getTransactionReceipt', [foundTx.hash])
    } catch (error) {
      console.error(error)
      if (error instanceof TxValidationError) {
        return {
          ...transfer,
          errors: [...transfer.errors, error.message],
          status: status.FAILED
        }
      }
    }
  }

  if (!burnReceipt) return transfer

  if (burnReceipt.status !== '0x1') {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    const error = `Aurora transaction failed: ${burnReceipt.transactionHash}`
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
      burnHashes: [...transfer.burnHashes, burnReceipt.transactionHash],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }

  // Parse NEAR tx burn receipt
  const decodedTxHash = Buffer.from(burnReceipt.nearTransactionHash.slice(2), 'hex')
  const nearBurnHash = bs58.encode(decodedTxHash)

  const nearAccount = options.nearAccount ?? await getNearAccount()
  const nearBurnTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, options.auroraRelayerAccount ?? bridgeParams.auroraRelayerAccount
  )

  // @ts-expect-error
  if (nearBurnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  // @ts-expect-error
  if (nearBurnTx.status.Failure) {
    const error = 'NEAR relay.aurora transaction failed.'
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED
    }
  }

  let nearBurnReceipt
  try {
    nearBurnReceipt = await parseBurnReceipt(nearBurnTx, nearAccount)
  } catch (e) {
    if (e instanceof TransferError) {
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkWithdraw will be called again.
    throw e
  }

  // @ts-expect-error TODO
  const txBlock = await nearAccount.connection.provider.block({ blockId: nearBurnTx.transaction_outcome.block_hash })

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    startTime: new Date(txBlock.header.timestamp / 10 ** 6).toISOString(),
    burnReceipts: [...transfer.burnReceipts, burnReceipt],
    nearBurnHashes: [...transfer.nearBurnHashes, nearBurnHash],
    nearBurnReceiptIds: [...transfer.nearBurnReceiptIds, nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [...transfer.nearBurnReceiptBlockHeights, nearBurnReceipt.blockHeight]
  }
}

/**
 * Wait for a final block with a strictly greater height than nearBurnTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 */
export async function checkFinality (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()

  const burnReceiptBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearAccount.connection.provider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= burnReceiptBlockHeight) {
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
 */
export async function checkSync (
  transfer: Transfer | string,
  options?: TransferOptions
): Promise<Transfer> {
  if (typeof transfer === 'string') {
    return await recover(transfer, 'todo', options)
  }
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  if (!transfer.checkSyncInterval) {
    // checkSync every 60s: reasonable value to detect transfer is ready to be finalized
    transfer = {
      ...transfer,
      checkSyncInterval: options.sendToEthereumSyncInterval ?? bridgeParams.sendToEthereumSyncInterval
    }
  }
  if (transfer.nextCheckSyncTimestamp && new Date() < new Date(transfer.nextCheckSyncTimestamp)) {
    return transfer
  }
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkSync, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const burnBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(
    provider,
    options.ethClientAddress ?? bridgeParams.ethClientAddress,
    options.ethClientAbi ?? bridgeParams.ethClientAbi
  )
  let proof

  const nearAccount = options.nearAccount ?? await getNearAccount()
  if (nearOnEthClientBlockHeight > burnBlockHeight) {
    proof = await findNearProof(
      last(transfer.nearBurnReceiptIds),
      options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
      nearOnEthClientBlockHeight,
      nearAccount,
      provider,
      options.ethClientAddress ?? bridgeParams.ethClientAddress,
      options.ethClientAbi ?? bridgeParams.ethClientAbi
    )
    if (await proofAlreadyUsed(
      provider,
      proof,
      options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
      options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi
    )) {
      // TODO find the unlockTxHash
      return {
        ...transfer,
        completedStep: UNLOCK,
        nearOnEthClientBlockHeight,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Unlock proof already used.']
      }
    }
  } else {
    return {
      ...transfer,
      nextCheckSyncTimestamp: new Date(Date.now() + transfer.checkSyncInterval!),
      nearOnEthClientBlockHeight,
      status: status.IN_PROGRESS
    }
  }

  return {
    ...transfer,
    completedStep: SYNC,
    nearOnEthClientBlockHeight,
    status: status.ACTION_NEEDED,
    proof // used when checkSync() is called by unlock()
  }
}

/**
 * Check if a NEAR outcome receipt_id has already been used to finalize a transfer to Ethereum.
 */
export async function proofAlreadyUsed (provider: ethers.providers.Provider, proof: any, etherCustodianAddress: string, etherCustodianAbi: string): Promise<boolean> {
  const ethTokenLocker = new ethers.Contract(
    etherCustodianAddress,
    etherCustodianAbi,
    provider
  )
  const proofIsUsed = await ethTokenLocker.usedEvents_('0x' + bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex'))
  return proofIsUsed
}

/**
 * Unlock tokens stored in the contract at process.env.etherCustodianAddress,
 * passing the proof that the tokens were withdrawn/burned in the corresponding
 * NEAR BridgeToken contract.
 */
export async function unlock (
  transfer: Transfer | string,
  options?: Omit<TransferOptions, 'provider'> & {
    provider?: ethers.providers.JsonRpcProvider
    signer?: ethers.Signer
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getSignerProvider()

  // Build burn proof
  transfer = await checkSync(transfer, { ...options, provider })
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  // Unlock
  const borshProof = borshifyOutcomeProof(proof)

  const ethTokenLocker = new ethers.Contract(
    options.etherCustodianAddress ?? bridgeParams.etherCustodianAddress,
    options.etherCustodianAbi ?? bridgeParams.etherCustodianAbi,
    options.signer ?? provider.getSigner()
  )
  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingUnlockTx = await ethTokenLocker.withdraw(borshProof, transfer.nearOnEthClientBlockHeight)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingUnlockTx.from,
      to: pendingUnlockTx.to,
      nonce: pendingUnlockTx.nonce,
      data: pendingUnlockTx.data,
      safeReorgHeight
    },
    unlockHashes: [...transfer.unlockHashes, pendingUnlockTx.hash]
  }
}

export async function checkUnlock (
  transfer: Transfer,
  options?: {
    provider?: ethers.providers.Provider
    ethChainId?: number
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong eth network for checkUnlock, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }

  const unlockHash = last(transfer.unlockHashes)
  let unlockReceipt: ethers.providers.TransactionReceipt = await provider.getTransactionReceipt(unlockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!unlockReceipt) {
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
      unlockReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!unlockReceipt) return transfer

  if (!unlockReceipt.status) {
    const error = `Transaction failed: ${unlockReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
    }
  }

  if (unlockReceipt.transactionHash !== unlockHash) {
    // Record the replacement tx unlockHash
    transfer = {
      ...transfer,
      unlockHashes: [...transfer.unlockHashes, unlockReceipt.transactionHash]
    }
  }

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: UNLOCK,
    unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
