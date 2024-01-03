import { ethers } from 'ethers'
import bs58 from 'bs58'

export class SearchError extends Error {}

export interface ExplorerIndexerResult {
  originated_from_transaction_hash: string
  included_in_block_timestamp: string
}

export async function findFinalizationTxOnNear ({
  proof,
  connectorAccount,
  eventRelayerAccount,
  finalizationMethod,
  ethTxHash,
  callIndexer
}: {
  proof?: string
  connectorAccount?: string
  eventRelayerAccount?: string
  finalizationMethod?: string
  ethTxHash?: string
  callIndexer: (query: string) => Promise<ExplorerIndexerResult[] | string>
}): Promise<{ transactions: string[], timestamps: number[] }> {
  if (ethTxHash) {
    const nearTxHash = await callIndexer(ethTxHash) as string
    return { transactions: [nearTxHash], timestamps: [] }
  } else if (proof && connectorAccount && eventRelayerAccount && finalizationMethod) {
    const query = `SELECT public.receipts.originated_from_transaction_hash, public.receipts.included_in_block_timestamp
      FROM public.receipts
      JOIN public.action_receipt_actions
      ON public.action_receipt_actions.receipt_id = public.receipts.receipt_id
      WHERE (receipt_predecessor_account_id = '${eventRelayerAccount}'
        AND receipt_receiver_account_id = '${connectorAccount}'
        AND args ->> 'method_name' = '${finalizationMethod}'
        AND args ->> 'args_base64' = '${proof}'
      )`
    // NOTE: Generally only 1 result is returned, but allow multiple in case finalization attempts are made.
    const results = await callIndexer(query) as ExplorerIndexerResult[]
    const transactions = results.map(tx => tx.originated_from_transaction_hash)
    const timestamps = results.map(tx => Number(tx.included_in_block_timestamp))
    return { transactions, timestamps }
  } else {
    throw new Error('Expected ethTxHash or sql query params')
  }
}

async function proofAlreadyUsed (
  proofStorageIndex: string,
  connectorAddress: string,
  blockHeight: number,
  provider: ethers.providers.Provider
): Promise<boolean> {
  const proofIsUsed = await provider.getStorageAt(connectorAddress, proofStorageIndex, blockHeight)
  return Number(proofIsUsed) === 1
}

export async function findFinalizationTxOnEthereum ({
  usedProofPosition,
  proof,
  connectorAddress,
  connectorAbi,
  finalizationEvent,
  recipient,
  amount,
  provider
}: {
  usedProofPosition: string
  proof: { outcome_proof: { outcome: { receipt_ids: string[] } } }
  connectorAddress: string
  connectorAbi: string
  finalizationEvent: string
  recipient: string
  amount: string
  provider: ethers.providers.Provider
}): Promise<{ transactions: string[], block: ethers.providers.Block }> {
  const usedProofsMappingPosition = '0'.repeat(63) + usedProofPosition
  const usedProofsKey: string = bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]!).toString('hex')
  const proofStorageIndex = ethers.utils.keccak256('0x' + usedProofsKey + usedProofsMappingPosition)

  let maxBlock: number = await provider.getBlockNumber()
  let minBlock = 0
  while (minBlock < maxBlock) {
    const middleBlock = Math.floor((minBlock + maxBlock) / 2)
    const finalized = await proofAlreadyUsed(proofStorageIndex, connectorAddress, middleBlock, provider)
    if (!finalized) {
      // middleBlock was mined before the transfer was finalized, so take next block as lower bound
      minBlock = middleBlock + 1
    } else {
      maxBlock = middleBlock
    }
  }
  const connectorContract = new ethers.Contract(
    connectorAddress,
    connectorAbi,
    provider
  )
  // NOTE: Depending on the connector, event args are in different order or not indexed, so query all and filter.
  const filter = connectorContract.filters[finalizationEvent]!()
  const events = await connectorContract.queryFilter(filter, minBlock, minBlock)
  const transactions = events.filter(e =>
    e.args!.recipient.toLowerCase() === recipient.toLowerCase() && e.args!.amount.toString() === amount
  ).map(e => e.transactionHash)
  if (transactions.length === 0) {
    throw new SearchError(`Finalization tx on Ethereum not found for proof: ${JSON.stringify(proof)}`)
  }
  const block = await provider.getBlock(minBlock)
  return { transactions, block }
}
