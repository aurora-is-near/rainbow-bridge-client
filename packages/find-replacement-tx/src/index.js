import Web3 from 'web3'

/**
 * Binary search a trasaction with `nonce` and `from`
 * @param {} provider Web3 provider
 * @param {Number} startSearch Block height of lower bound search limit
 * @param {String} from Signer of the transaction searched
 * @param {Number} nonce Nonce of the transaction searched
 */
export async function getTransactionByNonce (provider, startSearch, from, nonce) {
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
  return transaction
}

/**
 * Search and validate a replaced transaction (speed up)
 * @param {} provider Web3 provider
 * @param {Number} safeHeightBeforeEthTx Lower search bound
 * @param {String} tx.from Signer of the transaction searched
 * @param {Number} tx.nonce Nonce of the transaction searched
 * @param {String} event.name Name of event expected if tx was speed up
 * @param {String} event.abi tx.to contract abi needed to find event
 * @param {String} event.address Address of contract emitting the event
 * @param {Function} event.validate Function to validate the content of event
 */
export async function findReplacementTx (provider, safeHeightBeforeEthTx, tx, event) {
  const transaction = await getTransactionByNonce(provider, safeHeightBeforeEthTx, tx.from, tx.nonce)
  // Transaction still pending
  if (!transaction) return null

  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  if (!transaction) {
    const error = 'Error happened while searching replacement transaction.'
    throw new Error(error)
  }
  if (transaction.to.toLowerCase() !== tx.to.toLowerCase()) {
    const error = `Transaction was dropped and replaced by '${transaction.hash}'`
    throw new Error(error)
  }

  const tokenContract = new web3.eth.Contract(
    JSON.parse(event.abi),
    event.address
  )
  const events = await tokenContract.getPastEvents(event.name, {
    fromBlock: transaction.blockNumber,
    toBlock: transaction.blockNumber
  })
  const foundEvent = events.find(e => e.transactionHash === transaction.hash)
  if (!foundEvent || !event.validate(foundEvent)) {
    const error = `Transaction was dropped and replaced by '${transaction.hash}'
      with unexpected event: '${JSON.stringify(event)}'`
    throw new Error(error)
  }
  return transaction
}
