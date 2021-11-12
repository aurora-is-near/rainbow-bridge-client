import { ethers } from 'ethers'
import bs58 from 'bs58'

export class SearchError extends Error {}

async function proofAlreadyUsed (
  proofStorageIndex: string,
  connectorAddress: string,
  blockHeight: number,
  provider: ethers.providers.Provider
): Promise<boolean> {
  const proofIsUsed = await provider.getStorageAt(connectorAddress, proofStorageIndex, blockHeight)
  return Number(proofIsUsed) === 1
}

export async function findFinalizationTxOnEthereum (
  { usedProofPosition, proof, connectorAddress, connectorAbi, finalizationEvent, recipient, amount, provider }: {
    usedProofPosition: string
    proof: { outcome_proof: { outcome: { receipt_ids: string[] } } }
    connectorAddress: string
    connectorAbi: string
    finalizationEvent: string
    recipient: string
    amount: string
    provider: ethers.providers.Provider
  }
): Promise<string[]> {
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
  const txBlock = minBlock
  if (!txBlock) {
    const error = 'Could not find replacement transaction. It may be due to a chain reorg.'
    throw new SearchError(error)
  }
  const connectorContract = new ethers.Contract(
    connectorAddress,
    connectorAbi,
    provider
  )
  // NOTE: Depending on the connector, event args are in different order or not indexed, so query all and filter.
  const filter = connectorContract.filters[finalizationEvent]!()
  const events = await connectorContract.queryFilter(filter, txBlock, txBlock)
  return events.filter(e =>
    e.args!.recipient.toLowerCase() === recipient.toLowerCase() && e.args!.amount.toString() === amount
  ).map(e => e.transactionHash)
}
