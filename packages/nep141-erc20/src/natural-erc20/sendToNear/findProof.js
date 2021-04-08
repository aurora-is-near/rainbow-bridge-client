import { Trie } from './merkle-patricia-tree'
// import Tree from 'merkle-patricia-tree'
// import { promisfy } from 'promisfy'
import { encode } from 'eth-util-lite'
import { Header, Proof, Receipt, Log } from 'eth-object'
import utils from 'ethereumjs-util'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'
import Web3 from 'web3'
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
export default async function findProof (lockTxHash) {
  const provider = getEthProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const ethTokenLocker = new web3.eth.Contract(
    JSON.parse(process.env.ethLockerAbiText),
    process.env.ethLockerAddress
  )

  const receipt = await web3.eth.getTransactionReceipt(lockTxHash)
  if (receipt.status !== true) {
    // When connecting via walletConnect, a random bug can happen where the receipt.status
    // is false event though we know it should be true.
    // https://github.com/near/rainbow-bridge-client/issues/12
    throw new Error(
      `Invalid Ethereum receipt status received from provider, please try again.
       If retrying doesn't solve this error, connecting a Metamask account may solve the issue`
    )
  }
  const block = await web3.eth.getBlock(receipt.blockNumber)
  const tree = await buildTree(block)
  const proof = await extractProof(
    block,
    tree,
    receipt.transactionIndex
  )

  const events = await ethTokenLocker.getPastEvents('Locked', {
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber
  })
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
    proof: Array.from(proof.receiptProof).map(utils.rlp.encode).map(b => Array.from(b))
  })

  return serializeBorsh(proofBorshSchema, formattedProof)
}

async function buildTree (block) {
  const provider = getEthProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const blockReceipts = await Promise.all(
    block.transactions.map(t => web3.eth.getTransactionReceipt(t))
  )

  /*
  // Keep this here in case we need testing
  const tree = new Tree()
  await Promise.all(
    blockReceipts.map(receipt => {
      const path = encode(receipt.transactionIndex)
      const serializedReceipt = Receipt.fromWeb3(receipt).serialize()
      return promisfy(tree.put, tree)(path, serializedReceipt)
    })
  )
  */

  // Build a Patricia Merkle Trie
  const trie = new Trie()
  blockReceipts.forEach(receipt => {
    const path = encode(receipt.transactionIndex)
    const serializedReceipt = Receipt.fromWeb3(receipt).serialize()
    trie.put(path, serializedReceipt)
  })
  if (trie.root.toString('hex') !== block.receiptsRoot.slice(2)) {
    throw new Error('Failed to build receipts trie root.')
  }

  return trie
}

async function extractProof (block, tree, transactionIndex) {
  const provider = getEthProvider()
  // If available connect to rpcUrl to avoid issues with WalletConnectProvider receipt.status
  const web3 = new Web3(provider.rpcUrl ? provider.rpcUrl : provider)

  const stack = tree.findPath(encode(transactionIndex)).stack.map(
    node => { return { raw: node.raw() } }
  )

  /*
  // Keep this here in case we need testing
  const [, , stack] = await promisfy(
    tree.findPath,
    tree
  )(encode(transactionIndex))
  */

  const blockData = await web3.eth.getBlock(block.number)
  // Correctly compose and encode the header.
  const header = Header.fromWeb3(blockData)
  return {
    header_rlp: header.serialize(),
    receiptProof: Proof.fromStack(stack),
    txIndex: transactionIndex
  }
}
