import { Trie } from 'lite-merkle-patricia-tree'
// import Tree from 'merkle-patricia-tree'
// import { promisfy } from 'promisfy'
// @ts-expect-error
import { Header, Proof, Receipt, Log } from 'eth-object'
import { rlp, toBuffer } from 'ethereumjs-util'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'
import { IdType } from 'near-api-js/lib/providers/provider'
import { Account } from 'near-api-js'
import { ethers } from 'ethers'
import bs58 from 'bs58'

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class BorshProof {
  constructor (proof: any) {
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
export async function findEthProof (
  eventName: string,
  txHash: string,
  address: string,
  abi: any,
  provider: ethers.providers.JsonRpcProvider
): Promise<Uint8Array> {
  const contract = new ethers.Contract(address, abi, provider)

  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt.status) {
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
    block,
    tree,
    receipt.transactionIndex
  )

  const filter = contract.filters[eventName]!()
  const events = await contract.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const event = events.find(event => event.transactionHash === txHash)!
  // `log.logIndex` does not necessarily match the log's order in the array of logs
  const logIndexInArray = receipt.logs.findIndex(
    l => l.logIndex === event.logIndex
  )
  const log = receipt.logs[logIndexInArray]

  // @ts-expect-error
  receipt.cumulativeGasUsed = receipt.cumulativeGasUsed.toNumber()

  const formattedProof = new BorshProof({
    log_index: logIndexInArray,
    log_entry_data: Array.from(Log.fromObject(log).serialize()),
    receipt_index: proof.txIndex,
    receipt_data: Array.from(Receipt.fromObject(receipt).serialize()),
    header_data: Array.from(proof.header_rlp),
    proof: Array.from(proof.receiptProof).map(rlp.encode).map(b => Array.from(b))
  })

  return serializeBorsh(proofBorshSchema, formattedProof)
}

async function buildTree (
  provider: ethers.providers.Provider,
  block: { transactions: ethers.providers.TransactionResponse[], receiptsRoot: string}
): Promise<Trie> {
  const blockReceipts = await Promise.all(
    block.transactions.map(async (t) => await provider.getTransactionReceipt(t.hash))
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
    // @ts-expect-error
    receipt.cumulativeGasUsed = receipt.cumulativeGasUsed.toNumber()
    const serializedReceipt = Receipt.fromObject(receipt).serialize()
    trie.put(path, serializedReceipt)
  })
  if (trie.root.toString('hex') !== block.receiptsRoot.slice(2)) {
    throw new Error('Failed to build receipts trie root.')
  }

  return trie
}

async function extractProof (
  block: any,
  tree: Trie,
  transactionIndex: number
): Promise<{header_rlp: Buffer, receiptProof: Proof, txIndex: number}> {
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
  const header = Header.fromRpc(block)
  return {
    header_rlp: header.serialize(),
    receiptProof: Proof.fromStack(stack),
    txIndex: transactionIndex
  }
}

export async function findNearProof (
  nearReceiptId: string,
  nearReceiverId: string,
  nearBlockHeight: number,
  nearAccount: Account,
  provider: ethers.providers.Provider,
  ethClientAddress: string,
  ethClientAbi: string
): Promise<any> {
  const nearOnEthClient = new ethers.Contract(
    ethClientAddress,
    ethClientAbi,
    provider
  )
  const clientBlockHashB58 = bs58.encode(toBuffer(
    await nearOnEthClient.blockHashes(nearBlockHeight)
  ))
  const proof = await nearAccount.connection.provider.lightClientProof(
    {
      type: IdType.Receipt,
      receipt_id: nearReceiptId,
      receiver_id: nearReceiverId,
      light_client_head: clientBlockHashB58
    }
  )
  return proof
}
