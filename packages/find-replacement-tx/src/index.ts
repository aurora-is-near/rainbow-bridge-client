import Web3 from 'web3'
import { Transaction } from 'web3-core'
import { PastEventOptions } from 'web3-eth-contract'

/**
 * Binary search a trasaction with `nonce` and `from`
 * @param provider Web3 provider
 * @param startSearch Block height of lower bound search limit
 * @param from Signer of the transaction searched
 * @param nonce Nonce of the transaction searched
 */
export async function getTransactionByNonce (
  provider: any,
  startSearch: number,
  from: string,
  nonce: number
): Promise<Transaction | null> {
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const currentNonce = await web3.eth.getTransactionCount(from, 'latest')

  // Transaction still pending
  if (currentNonce <= nonce) return null

  // Binary search the block containing the transaction between startSearch and latest.
  let txBlock
  let maxBlock = await web3.eth.getBlockNumber() // latest: chain head
  let minBlock = startSearch
  while (minBlock <= maxBlock) {
    const middleBlock = Math.floor((minBlock + maxBlock) / 2)
    const middleNonce = await web3.eth.getTransactionCount(from, middleBlock) - 1
    if (middleNonce < nonce) {
      // middleBlock was mined before the tx with broadcasted nonce, so take next block as lower bound
      minBlock = middleBlock + 1
    } else if (middleNonce >= nonce) {
      // The middleBlock was mined after the tx with tx.nonce, so check if the account has a
      // lower nonce at previous block which would mean that tx.nonce was mined in this middleBlock.
      if (await web3.eth.getTransactionCount(from, middleBlock - 1) - 1 < nonce) {
        // Confirm the nonce changed by checking the previous block:
        // use previous block nonce `>=` broadcasted nonce in case there are multiple user tx
        // in the previous block. If only 1 user tx, then `===` would work
        txBlock = middleBlock
        break
      }
      // Otherwise take the previous block as the higher bound
      maxBlock = middleBlock - 1
    }
  }
  if (!txBlock) {
    const error = 'Could not find replacement transaction. It may be due to a chain reorg.'
    throw new Error(error)
  }
  const block = await web3.eth.getBlock(txBlock, true)
  const transaction = block.transactions.find(
    blockTx => blockTx.from.toLowerCase() === from.toLowerCase() && blockTx.nonce === nonce
  )
  if (!transaction) {
    throw new Error('Error finding transaction in block.')
  }
  return transaction
}

/**
 * Search and validate a replaced transaction (speed up)
 * @param provider Web3 provider
 * @param safeHeightBeforeEthTx Lower search bound
 * @param tx.from Signer of the transaction searched
 * @param tx.to Recipient: multisig, erc20...
 * @param tx.nonce Nonce of the transaction searched
 * @param event.name Name of event expected if tx was speed up
 * @param event.abi Abi of contract emitting event
 * @param event.address Address of contract emitting the event
 * @param event.validate Function to validate the content of event
 */
export async function findReplacementTx (
  provider: any,
  safeHeightBeforeEthTx: number,
  tx: { from: string, to: string, nonce: number },
  event: {
    name: string
    abi: string
    address: string
    validate: ({ returnValues }: { returnValues: any }) => boolean
  }
): Promise<Transaction | null> {
  const transaction = await getTransactionByNonce(provider, safeHeightBeforeEthTx, tx.from, tx.nonce)
  // Transaction still pending
  if (!transaction) return null

  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  if (transaction.to!.toLowerCase() !== tx.to.toLowerCase()) {
    const error = `Transaction was dropped and replaced by '${transaction.hash}'`
    throw new Error(error)
  }

  const tokenContract = new web3.eth.Contract(
    JSON.parse(event.abi),
    event.address
  )
  const eventOptions: PastEventOptions = {
    fromBlock: transaction.blockNumber!,
    toBlock: transaction.blockNumber!
  }
  const events = await tokenContract.getPastEvents(event.name, eventOptions)
  const foundEvent = events.find(e => e.transactionHash === transaction.hash)
  if (!foundEvent || !event.validate(foundEvent)) {
    const error = `Transaction was dropped and replaced by '${transaction.hash}'
      with unexpected event: '${JSON.stringify(event)}'`
    throw new Error(error)
  }
  return transaction
}
