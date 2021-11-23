import { ethers } from 'ethers'

export class SearchError extends Error {}
export class TxValidationError extends Error {}

/**
 * Binary search a trasaction with `nonce` and `from`
 * @param provider Web3 provider
 * @param startSearch Block height of lower bound search limit
 * @param from Signer of the transaction searched
 * @param nonce Nonce of the transaction searched
 */
export async function getTransactionByNonce (
  provider: ethers.providers.Provider,
  startSearch: number,
  from: string,
  nonce: number
): Promise<ethers.providers.TransactionResponse | null> {
  const currentNonce = await provider.getTransactionCount(from, 'latest') - 1

  // Transaction still pending
  if (currentNonce < nonce) return null

  const startSearchNonce = await provider.getTransactionCount(from, startSearch - 1) - 1
  // Check nonce was used inside ]startSearch - 1, 'latest'].
  if (nonce <= startSearchNonce) {
    const error = `Nonce ${nonce} from ${from} is used before block ${startSearch}`
    throw new SearchError(error)
  }

  // Binary search the block containing the transaction between startSearch and latest.
  let maxBlock: number = await provider.getBlockNumber() // latest: chain head
  let minBlock = startSearch
  while (minBlock < maxBlock) {
    const middleBlock = Math.floor((minBlock + maxBlock) / 2)
    const middleNonce = await provider.getTransactionCount(from, middleBlock) - 1
    if (middleNonce < nonce) {
      // middleBlock was mined before the tx with broadcasted nonce, so take next block as lower bound
      minBlock = middleBlock + 1
    } else {
      maxBlock = middleBlock
    }
  }
  const block = await provider.getBlockWithTransactions(minBlock)
  const transaction = block.transactions.find(
    blockTx => blockTx.from.toLowerCase() === from.toLowerCase() && blockTx.nonce === nonce
  )
  if (!transaction) {
    throw new SearchError('Error finding transaction in block.')
  }
  return transaction
}

/**
 * Search and validate a replaced transaction (speed up)
 * @param provider Web3 provider
 * @param startSearch Lower search bound
 * @param tx.from Signer of the transaction searched
 * @param tx.to Recipient: multisig, erc20...
 * @param tx.nonce Nonce of the transaction searched
 * @param tx.data Input data of the transaction searched
 * @param tx.value Wei value transfered of the transaction searched
 * @param event.name Name of event expected if tx was speed up
 * @param event.abi Abi of contract emitting event
 * @param event.address Address of contract emitting the event
 * @param event.validate Function to validate the content of event
 */
export async function findReplacementTx (
  provider: any,
  startSearch: number,
  tx: { from: string, to: string, nonce: number, data?: string, value?: string },
  event?: {
    name: string
    abi: string
    address: string
    validate: ({ returnValues }: { returnValues: any }) => boolean
  }
): Promise<ethers.providers.TransactionResponse | null> {
  const transaction = await getTransactionByNonce(provider, startSearch, tx.from, tx.nonce)
  // Transaction still pending
  if (!transaction) return null

  if (transaction.data === '0x' && transaction.from === transaction.to && transaction.value.isZero()) {
    const error = 'Transaction canceled.'
    throw new TxValidationError(error)
  }

  if (transaction.to!.toLowerCase() !== tx.to.toLowerCase()) {
    const error = `Failed to validate transaction recipient.
      Expected ${tx.to}, got ${transaction.to!}.
      Transaction was dropped and replaced by '${transaction.hash}'`
    throw new TxValidationError(error)
  }

  if (tx.data) {
    if (transaction.data !== tx.data) {
      const error = `Failed to validate transaction data.
        Expected ${tx.data}, got ${transaction.data}.
        Transaction was dropped and replaced by '${transaction.hash}'`
      throw new TxValidationError(error)
    }
  }

  if (tx.value) {
    if (transaction.value.toString() !== tx.value) {
      const error = `Failed to validate transaction value.
        Expected ${tx.value}, got ${transaction.value.toString()}.
        Transaction was dropped and replaced by '${transaction.hash}'`
      throw new TxValidationError(error)
    }
  }

  if (event) {
    const tokenContract = new ethers.Contract(
      event.address,
      event.abi,
      provider
    )
    const filter = tokenContract.filters[event.name]!()
    const events = await tokenContract.queryFilter(filter, transaction.blockNumber, transaction.blockNumber)
    const foundEvent = events.find(e => e.transactionHash === transaction.hash)
    if (!foundEvent || !event.validate({ returnValues: foundEvent.args })) {
      const error = `Failed to validate event.
        Transaction was dropped and replaced by '${transaction.hash}'`
      throw new TxValidationError(error)
    }
  }
  return transaction
}
