import { Trie } from 'lite-merkle-patricia-tree'
// import Tree from 'merkle-patricia-tree'
// import { promisfy } from 'promisfy'
import { Header, Proof, Receipt, Log } from 'eth-object'
import { rlp } from 'ethereumjs-util'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'
import { ethers } from 'ethers'
import { getEthProvider } from '@near-eth/client/dist/utils'

class BorshProof {
  constructor (proof) {
    Object.assign(this, proof)
  }
}

const proofBorshSchema = new Map([
  [BorshProof, {
    kind: 'struct',
    fields: [
      ['log_index', 'u64'],
      ['log_entry_data', ['u8']],
      ['receipt_index', 'u64'],
      ['receipt_data', ['u8']],
      ['header_data', ['u8']],
      ['proof', [['u8']]]
    ]
  }]
])

// Compute proof that Locked event was fired in Ethereum. This proof can then
// be passed to the FungibleTokenFactory contract, which verifies the proof
// against a Prover contract.
export default async function findProof (lockTxHash, options) {
  options = options || {}
  const provider = options.ethProvider || getEthProvider()

  const ethTokenLocker = new ethers.Contract(
    options.ethLockerAddress || process.env.ethLockerAddress,
    options.ethLockerAbi || process.env.ethLockerAbiText,
    provider
  )

  const receipt = await provider.getTransactionReceipt(lockTxHash)
  if (receipt.status !== 1) {
    // When connecting via walletConnect, a random bug can happen where the receipt.status
    // is false event though we know it should be true.
    // https://github.com/near/rainbow-bridge-client/issues/12
    throw new Error(
      `Invalid Ethereum receipt status received from provider, please try again.
       If retrying doesn't solve this error, connecting a Metamask account may solve the issue`
    )
  }

  // const block = await provider.getBlock(receipt.blockNumber)
  // getBlock() doesn't return all the block fields
  // https://github.com/ethers-io/ethers.js/issues/667
  const block = await provider.send(
    'eth_getBlockByNumber',
    [ethers.utils.hexValue(receipt.blockNumber), true]
  )
  const tree = await buildTree(provider, block)
  const proof = await extractProof(
    provider,
    block,
    tree,
    receipt.transactionIndex
  )

  const filter = ethTokenLocker.filters.Locked()
  const events = await ethTokenLocker.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const lockedEvent = events.find(event => event.transactionHash === lockTxHash)
  // `log.logIndex` does not necessarily match the log's order in the array of logs
  const logIndexInArray = receipt.logs.findIndex(
    l => l.logIndex === lockedEvent.logIndex
  )
  const log = receipt.logs[logIndexInArray]

  const formattedProof = new BorshProof({
    log_index: logIndexInArray,
    log_entry_data: Array.from(Log.fromWeb3(log).serialize()),
    receipt_index: proof.txIndex,
    receipt_data: Array.from(Receipt.fromWeb3(receipt).serialize()),
    header_data: Array.from(proof.header_rlp),
    proof: Array.from(proof.receiptProof).map(rlp.encode).map(b => Array.from(b))
  })

  return serializeBorsh(proofBorshSchema, formattedProof)
}

async function buildTree (provider, block) {
  const blockReceipts = await Promise.all(
    block.transactions.map(t => provider.getTransactionReceipt(t.hash))
  )

  /*
  // Keep this here in case we need testing
  const tree = new Tree()
  await Promise.all(
    blockReceipts.map(receipt => {
      const path = rlp.encode(receipt.transactionIndex)
      const serializedReceipt = Receipt.fromWeb3(receipt).serialize()
      return promisfy(tree.put, tree)(path, serializedReceipt)
    })
  )
  console.log(block)
  if (tree.root.toString('hex') !== block.receiptsRoot.slice(2)) {
    throw new Error('Failed to build receipts trie root: tree')
  }
  */

  // Build a Patricia Merkle Trie
  const trie = new Trie()
  blockReceipts.forEach(receipt => {
    const path = rlp.encode(receipt.transactionIndex)
    const serializedReceipt = Receipt.fromWeb3(receipt).serialize()
    trie.put(path, serializedReceipt)
  })
  if (trie.root.toString('hex') !== block.receiptsRoot.slice(2)) {
    throw new Error('Failed to build receipts trie root.')
  }

  return trie
}

async function extractProof (provider, block, tree, transactionIndex) {
  const stack = tree.findPath(rlp.encode(transactionIndex)).stack.map(
    node => { return { raw: node.raw() } }
  )

  /*
  // Keep this here in case we need testing
  const [, , stack] = await promisfy(
    tree.findPath,
    tree
  )(rlp.encode(transactionIndex))
  */

  // Correctly compose and encode the header.
  const header = Header.fromWeb3(block)
  return {
    header_rlp: header.serialize(),
    receiptProof: Proof.fromStack(stack),
    txIndex: transactionIndex
  }
}
