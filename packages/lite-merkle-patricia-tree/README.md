lite-merkle-patricia-tree
=========================

A simplified and synchronous implementation of the Ethereum modified Merkle Patricia Tree from [ethereumjs-monorepo](https://github.com/ethereumjs/ethereumjs-monorepo).

This browser friendly implementation is for one-time use cases of data verification.

For example: put serialized BlockReceipts in the Trie and build an inclusion proof with findPath, and that's it, data is not persisted.

It replaces the database and async logic with a simple Map to temporarily store trie nodes.

Installation
------------

```shell
yarn add lite-merkle-patricia-tree
```

```json
"dependencies": {
  "lite-merkle-patricia-tree": "^1.0.0",
}
```

Usage
-----
```js
import { Trie } from 'lite-merkle-patricia-tree'
import { Proof } from 'eth-object'

const block = await web3.eth.getBlock()
const blockReceipts = await Promise.all(
  block.transactions.map(t => web3.eth.getTransactionReceipt(t))
)

// Build the receipts Trie
const trie = new Trie()
blockReceipts.forEach(receipt => {
  const path = rlp.encode(receipt.transactionIndex)
  const serializedReceipt = Receipt.fromWeb3(receipt).serialize()
  trie.put(path, serializedReceipt)
})
if (trie.root.toString('hex') !== block.receiptsRoot.slice(2)) {
  throw new Error('Failed to build receipts trie root.')
}

// Prove a receipt inclusion inside the Trie
const stack = trie.findPath(rlp.encode(transactionIndex)).stack.map(
  node => { return { raw: node.raw() } }
)
const receiptProof = Proof.fromStack(stack),
```