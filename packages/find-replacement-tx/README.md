find-replacement-tx
===================

Ethereum wallets have the functionality to `speed up` or `cancel` transactions. This has the effect of replacing a not yet mined transaction with another transaction of same nonce and different hash.

Dapp interfaces need a way to check for these replacement transactions.

This tool searches for replacement transactions of same nonce within a safe reorg height (binary searched).

- A `receipt` is returned if `findReplacementTx` found a transaction with the same nonce and destination which emitted a valid event.
- `findReplacementTx` will `throw` if the event couldn't be validated (transaction failed, different destination, or no replacement transaction found within the search range)
- `null` is returned if the transaction is not yet mined.

Related work: https://eips.ethereum.org/EIPS/eip-2831

Installation
------------

```shell
yarn add find-replacement-tx
```

```json
"dependencies": {
  "find-replacement-tx": "^1.0.0",
}
```

Usage
-----
* findReplacementTx

Find and validate a replacement transaction (Metamask speedup).
```js
import { findReplacementTx } from 'find-replacement-tx'

const erc20Contract = new web3.eth.Contract(
  erc20Abi,
  erc20TokenAddress,
  { from }
)

// If this tx is dropped and replaced, lower the search boundary
// in case there was a reorg.
const safeReorgHeight = await web3.eth.getBlockNumber() - 20

const approvalHash = await new Promise((resolve, reject) => {
  erc20Contract.methods
    .approve(spender, amount).send()
    .on('transactionHash', resolve)
    .catch(reject)
})
const pendingApprovalTx = await web3.eth.getTransaction(approvalHash)

// `tx` and `event` are necessary to validate how the transaction was replaced:
// speed up: same nonce, valid event emitted
// cancel: same nonce, different `tx.to`
const tx = {
  nonce: pendingApprovalTx.nonce,
  from: pendingApprovalTx.from,
  to: pendingApprovalTx.to
}
const event = {
  name: 'Approval',
  abi: erc20Abi,
  address: erc20TokenAddress,
  validate: ({ returnValues: { owner, spender, value } }) => {
    return (
      owner.toLowerCase() === transfer.sender.toLowerCase() &&
      spender.toLowerCase() === process.env.ethLockerAddress.toLowerCase()
      // Don't check value as the user may have increased approval before signing.
      // value === transfer.amount
    )
  }
}

try {
  const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx, event)
  if (!foundTx) {
    // Tx pending
  }
  const approvalReceipt = await web3.eth.getTransactionReceipt(foundTx.hash)
} catch (err) {
}
```

* getTransactionByNonce

Query a transaction by nonce.

Similar to `web3.eth.getTransaction`.

Returns a `Transaction` object or `null` if transaction nonce is pending. Throws if transaction is not found within range.

```js
  import { getTransactionByNonce } from 'find-replacement-tx'

  const startSearch = await web3.eth.getBlockNumber() - 20
  const transaction = await getTransactionByNonce(
    provider, // Web3 provider
    startSearch, // Lower search bound
    from, // Transaction signer
    nonce // Nonce of transaction to get
  )
```
