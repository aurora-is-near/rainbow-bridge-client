import Web3 from 'web3'
import { getEthProvider } from '@near-eth/client/dist/utils'


/**
 * Search for a dropped and replaced transaction (speed up or cancel)
 * @param {Number} safeHeightBeforeEthTx Lower search bound
 * @param {*} txInfo Transaction information to find the replacement
 * @param {*} eventVerifier Check event information to verify if it was a speed up
 */
export async function handleEthTxReplaced(
  safeHeightBeforeEthTx,
  {broadcastedNonce, txFrom, txTo},
  {eventName, contractAbiText, validateEvent}
) {
  const web3 = new Web3(getEthProvider())

  const currentNonce = await web3.eth.getTransactionCount(txFrom, 'latest')

  // Transaction still pending
  if (currentNonce <= broadcastedNonce) return null

  // Binary search the block of replacement (canceled or speedup) transaction
  // between safeHeightBeforeEthTx and latest.
  let replacementTxBlock
  let maxBlock = await web3.eth.getBlockNumber() // latest: chain head
  let minBlock = safeHeightBeforeEthTx
  while (minBlock <= maxBlock) {
    const middleBlock = Math.floor((minBlock + maxBlock) / 2)
    const middleNonce = await web3.eth.getTransactionCount(txFrom, middleBlock) - 1
    if (middleNonce < broadcastedNonce) {
      // middleBlock was mined before the tx with broadcasted nonce, so take next block as lower bound
      minBlock = middleBlock + 1
    } else if (middleNonce >= broadcastedNonce) {
      // The middleBlock was mined after the tx with broadcastedNonce, so check if the account has a
      // lower nonce at previous block which would mean that broadcastedNonce was mined in this middleBlock.
      if (await web3.eth.getTransactionCount(txFrom, middleBlock - 1) - 1 < broadcastedNonce) {
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
    const error = `Could not find replacement transaction. It may be due to a chain reorg.`
    throw new Error(error)
  }
  const block = await web3.eth.getBlock(replacementTxBlock, true)
  const replacementTx = block.transactions.find(
    tx => tx.from.toLowerCase() === txFrom.toLowerCase() && tx.nonce === broadcastedNonce
  )
  if (!replacementTx) {
    const error = `Error happened while searching replacement transaction.`
    throw new Error(error)
  }
  if (replacementTx.to.toLowerCase() !== txTo.toLowerCase()) {
    const error = `Transaction was dropped and replaced by '${replacementTx.hash}'`
    throw new Error(error)
  }
  const receipt = await web3.eth.getTransactionReceipt(replacementTx.hash)
  if (!receipt.status) {
    const error = `Transaction was dropped and replaced by a failing transaction: '${replacementTx.hash}'`
    throw new Error(error)
  }
  const tokenContract = new web3.eth.Contract(
    JSON.parse(contractAbiText),
    txTo
  )
  const events = await tokenContract.getPastEvents(eventName, {
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber
  })
  const event = events.find(e => e.transactionHash === replacementTx.hash)
  if (!validateEvent(event)) {
    const error = `Transaction was dropped and replaced by '${replacementTx.hash}'
      with unexpected event`
    throw new Error(error)
  }
  console.log('found replacement')
  return receipt
}
