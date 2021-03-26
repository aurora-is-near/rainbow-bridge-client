import Web3 from 'web3'
import { getEthProvider } from '@near-eth/client/dist/utils'

/**
 * Search for a dropped and replaced transaction (speed up or cancel)
 * @param {Number} safeHeightBeforeEthTx Lower search bound
 * @param {*} txInfo Transaction information to find the replacement
 * @param {*} tx.nonce Nonce of the transaction searched
 * @param {*} tx.from Signer of the transaction searched
 * @param {*} tx.to Address called by the transaction searched
 * @param {*} event.name Name of event expected if tx was speed up
 * @param {*} event.abi tx.to contract abi needed to find event
 * @param {*} event.validate Function to validate the content of event
 */
export async function findReplacementTx (safeHeightBeforeEthTx, tx, event) {
  const web3 = new Web3(getEthProvider())

  const currentNonce = await web3.eth.getTransactionCount(tx.from, 'latest')

  // Transaction still pending
  if (currentNonce <= tx.nonce) return null

  // Binary search the block of replacement (canceled or speedup) transaction
  // between safeHeightBeforeEthTx and latest.
  let replacementTxBlock
  let maxBlock = await web3.eth.getBlockNumber() // latest: chain head
  let minBlock = safeHeightBeforeEthTx
  while (minBlock <= maxBlock) {
    const middleBlock = Math.floor((minBlock + maxBlock) / 2)
    const middleNonce = await web3.eth.getTransactionCount(tx.from, middleBlock) - 1
    if (middleNonce < tx.nonce) {
      // middleBlock was mined before the tx with broadcasted nonce, so take next block as lower bound
      minBlock = middleBlock + 1
    } else if (middleNonce >= tx.nonce) {
      // The middleBlock was mined after the tx with tx.nonce, so check if the account has a
      // lower nonce at previous block which would mean that tx.nonce was mined in this middleBlock.
      if (await web3.eth.getTransactionCount(tx.from, middleBlock - 1) - 1 < tx.nonce) {
        // Confirm the nonce changed by checking the previous block:
        // use previous block nonce `>=` broadcasted nonce in case there are multiple user tx
        // in the previous block. If only 1 user tx, then `===` would work
        replacementTxBlock = middleBlock
        break
      }
      // Otherwise take the previous block as the higher bound
      maxBlock = middleBlock - 1
    }
  }
  if (!replacementTxBlock) {
    const error = 'Could not find replacement transaction. It may be due to a chain reorg.'
    throw new Error(error)
  }
  const block = await web3.eth.getBlock(replacementTxBlock, true)
  const replacementTx = block.transactions.find(
    blockTx => blockTx.from.toLowerCase() === tx.from.toLowerCase() && blockTx.nonce === tx.nonce
  )
  if (!replacementTx) {
    const error = 'Error happened while searching replacement transaction.'
    throw new Error(error)
  }
  if (replacementTx.to.toLowerCase() !== tx.to.toLowerCase()) {
    const error = `Transaction was dropped and replaced by '${replacementTx.hash}'`
    throw new Error(error)
  }
  const receipt = await web3.eth.getTransactionReceipt(replacementTx.hash)
  if (!receipt.status) {
    const error = `Transaction was dropped and replaced by a failing transaction: '${replacementTx.hash}'`
    throw new Error(error)
  }
  const tokenContract = new web3.eth.Contract(
    JSON.parse(event.abi),
    tx.to
  )
  const events = await tokenContract.getPastEvents(event.name, {
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber
  })
  const foundEvent = events.find(e => e.transactionHash === replacementTx.hash)
  if (!foundEvent || !event.validate(foundEvent)) {
    const error = `Transaction was dropped and replaced by '${replacementTx.hash}'
      with unexpected event: '${JSON.stringify(event)}'`
    throw new Error(error)
  }
  return receipt
}
