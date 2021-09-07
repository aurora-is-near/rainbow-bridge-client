`@near-eth/client` – the Rainbow Bridge client library 🌈🌉
======================================================

<a href="https://www.npmjs.com/package/@near-eth/client"><img alt="@near-eth/client Version" src="https://img.shields.io/npm/v/@near-eth/client"></a>

Do you want to allow your users to send assets between [Ethereum] & [NEAR] over
the [Rainbow Bridge]?

Do you want to easily send assets between the two blockchains using your
command line?

Did you build a custom Rainbow Bridge [Connector] and now you want to figure
out how to build a client library for it, so other people can actually use it?

If you answered "Yes" to any of the above questions, this is the library for you! (Ok, ok, the CLI interface is not yet supported!)

  [Ethereum]: https://ethereum.org/
  [NEAR]: https://near.org/
  [Rainbow Bridge]: https://near.org/blog/eth-near-rainbow-bridge/
  [Connector]: https://github.com/aurora-is-near/rainbow-token-connector

Read on to find out how to:

- [Add it to your browser app](#add-it-to-your-browser-app)
- [Author a custom connector library](#author-a-custom-connector-library)

To contribute to this library, see [github.com/aurora-is-near/rainbow-bridge-client](https://github.com/aurora-is-near/rainbow-bridge-client).


Add it to your browser app
==========================

Let's say you want to allow users to send ERC20 tokens from Ethereum to NEAR,
where they'll become NEP141 tokens.

Step 0: Add Dependencies
------------------------

You'll need to add two dependencies to your app:

    npm install --save @near-eth/client @near-eth/nep141-erc20

Or, if using yarn:

    yarn add @near-eth/client @near-eth/nep141-erc20

### What is `@near-eth/nep141-erc20`?

The Rainbow Bridge between Ethereum and NEAR has [many pieces][Rainbow Bridge]. One piece is **Connector** contracts. The connector code for converting ERC20 tokens in Ethereum to NEP141 tokens in NEAR lives at [github.com/aurora-is-near/rainbow-token-connector][Connector].

The code for using a given connector from an app has its own library. The one for the connector above is [`@near-eth/nep141-erc20`](https://www.npmjs.com/package/@near-eth/nep141-erc20).

Anyone can make connector contracts, and anyone can make client libraries for these contracts. If they follow the format of `@near-eth/nep141-erc20`, these client libraries will work automatically with the core Rainbow Bridge transfer library at `@near-eth/client`.

Generally, each connector client library, like `@near-eth/nep141-erc20`, will export four main interfaces, which can be used to:

1. Go from a "natural" Ethereum token to a "bridged" NEAR equivalent
2. Go from a "bridged" NEAR token, meaning a token that started its life in Ethereum but which now lives in NEAR, back to Ethereum
3. Go from a natural NEAR token to a bridged Ethereum equivalent
4. Go from a bridged Ethereum token back to NEAR

For `@near-eth/nep141-erc20`, these main exports are:

1. `naturalErc20` – example: go from DAI (a popular ERC20 token) to nDAI
2. `bridgedNep141` – example: convert nDAI back to DAI
3. `naturalNep141` – example: go from a natural NEAR token, such as BNNA Tokens in berryclub.io, to eBNNA in Ethereum
4. `bridgedErc20` – example: convert eBNNA back to BNNA

You can have multiple connector libraries in your app, some which may be maintained by NEAR and are in the `@near-eth` organization, and some which are not. An example `package.json` might end up looking something like:

```js
"dependencies": {
  "@near-eth/client": "*",
  "@near-eth/nep141-erc20": "*",
  "@near-eth/nep4-erc721": "*",
  "rainbow-bridge-erc20-with-rebase-and-nep21": "*",
}
```

(Note: `@near-eth/nep4-erc721` and `rainbow-bridge-erc20-with-rebase-and-nep21` do NOT currently exist, and are only shown to illustrate how this could work. As an aside, the current ERC20 connector does NOT support [tokens which use the `rebase` feature](https://etherscan.io/tokens/label/rebase-token) like [AMPL](https://etherscan.io/token/0xd46ba6d942050d489dbd938a2c909a5d5039a161) & [BASE](https://etherscan.io/token/0x07150e919b4de5fd6a63de1f9384828396f25fdc), which is why a hypothetical community-contributed "erc20-with-rebase" connector library is shown.)

Step 0: Set the bridge parameters
---------------------------------

These parameters are specific to the bridge being used.
```js
import { setBridgeParams } from '@near-eth/client'
  setBridgeParams({
    nearEventRelayerMargin: 10, // 10 blocks margin for the Event relayer to finalize the transfer
    sendToNearSyncInterval: 20000, // check light client sync every 20sec
    sendToEthereumSyncInterval: 60000, // check light client sync every 60sec
    ethChainId: 1, // mainnet
    erc20Abi: process.env.ethErc20AbiText, // Standard ERC-20 ABI
    erc20LockerAddress: '0x23ddd3e3692d1861ed57ede224608875809e127f',
    erc20LockerAbi: process.env.ethLockerAbiText,
    nep141Factory: 'factory.bridge.near',
    ethClientAddress: '0x0151568af92125fb289f1dd81d9d8f7484efc362',
    ethClientAbi: process.env.ethNearOnEthClientAbiText,
    nearClientAccount: 'client.bridge.near'
})
```

Step 1: Authenticate user with both NEAR & Ethereum
---------------------------------------------------

A full transfer will make multiple calls to both the NEAR & Ethereum blockchains, and you'll need to make sure the user has an account/wallet on both chains.

### NEAR Authentication

#### `setNearConnection`

Your app needs to call `setNearConnection` and pass it a `WalletConnection` instance from `near-api-js`. Example:

```js
import { keyStores, Near, WalletConnection } from 'near-api-js'
import { setNearConnection } from '@near-eth/client'

window.nearConnection = new WalletConnection(
  new Near({
    keyStore: new keyStores.BrowserLocalStorageKeyStore(),
    networkId: process.env.nearNetworkId,
    nodeUrl: process.env.nearNodeUrl,
    helperUrl: process.env.nearHelperUrl,
    walletUrl: process.env.nearWalletUrl
  })
)

setNearConnection(window.nearConnection)
```

If you don't know what to put for the settings passed to `new Near`, check out the [cheat sheet](https://docs.near.org/docs/api/naj-quick-reference).

#### `requestSignIn()`

Additionally, you'll probably want to verify that a user has a NEAR account before they get started. Given a "Sign in with NEAR" button:

```html
<button id="authNear">Sign in with NEAR</button>
```

You can add this handler:

```js
document.querySelector('#authNear').onclick = () => {
  window.nearConnection.requestSignIn()
}
```

### Ethereum Authentication

Your app needs to call `setEthProvider`. Given a "Connect to Ethereum" button:

```html
<button id="authEthereum">Connect to Ethereum</button>
```

You can use [web3modal](https://github.com/web3modal/web3modal) to add this handler:

```js
import Web3Modal from 'web3modal'
import { setEthProvider, setSignerProvider } from '@near-eth/client'
import { ethers } from 'ethers'

// Provider used for querying Ethereum data (transaction status, sync status ...)
setEthProvider(new ethers.providers.InfuraProvider('mainnet', INFURA_ID))

const web3Modal = new Web3Modal({ cacheProvider: true })

async function loadWeb3Modal () {
  window.ethProvider = await web3Modal.connect()
  // Provider used for signing transactions (MetaMask, WalletConnect...)
  setSignerProvider(new ethers.providers.Web3Provider(window.ethProvider, 'any'))
}

document.querySelector('#authEthereum').onclick = loadWeb3Modal

// on page load, check if user has already connected
if (web3Modal.cachedProvider) loadWeb3Modal()
```


Step 2: Initiate a transfer
---------------------------

Great, now your user is authenticated with both NEAR & Ethereum. Now let's say you have a form.

```html
<form id="sendErc20ToNear">
  <input id="erc20Address" />
  <input id="amount" />
</form>
```

Here's some JavaScript to make this work:

```js
import { naturalErc20 } from '@near-eth/nep141-erc20'

document.querySelector('#sendErc20ToNear').onsubmit = async e => {
  e.preventDefault()

  const [sender] = await window.ethProvider.request({method: 'eth_requestAccounts'})

  const recipient = window.nearConnection.getAccountId()

  const { erc20Address, amount } = e.target.elements

  // The ERC-20 should be approved before tokens can be transfered to the bridge.
  // naturalErc20.approve() and naturalErc20.checkApprove() are available,
  // but developpers is free to set approval any way they like depending on UX.
  naturalErc20.sendToNear({
    erc20Address: erc20Address.value,
    amount: amount.value
    recipient,
  })
}
```


Step 3: List in-progress transfers
----------------------------------

For the rest of the lifetime of the transfer you just initiated, you will use
exports from `@near-eth/client`, rather than the connector-specific library.

Let's say you want to list in-progress transfers in this `ol`:

```html
<ol id="transfers-go-here"></ol>
```

Here's code to render the list of transfers:

```js
import { get, onChange } from '@near-eth/client'

function renderTransfers () {
  const transfers = get({ filter: t => t.status === 'in-progress' })
  document.querySelector('#transfers-go-here').innerHTML =
    transfers.map(renderTransfer).join('')
}

onChange(renderTransfers)

renderTransfers()
```

If using React, you'd want something like:

```jsx
import React, { useState, useEffect } from 'react';
import { get, onChange } from '@near-eth/client'

// See below for an example Transfer component
import Transfer from './Transfer'

// You can write a simple custom hook to suit your needs;
// see https://reactjs.org/docs/hooks-custom.html
function useTransfers(filter) {
  const [transfers, setTransfers] = useState([])

  useEffect(() => {
    get({ filter }).then(setTransfers)

    onChange(() => get({ filter }).then(setTransfers))
  }, [])

  return transfers
}

export function Transfers () {
  const transfers = useTransfers(t => t.status === 'in-progress')
  return (
    <ol>
      {transfers.map(transfer =>
        <Transfer key={transfer.id} transfer={transfer} />
      )}
    </ol>
  )
}
```

And here's what `renderTransfer` might look like, using vanilla JS:

```js
import { act, decorate } from '@near-eth/client'

function renderTransfer (transfer) {
  // "decorate" transfer with realtime info & other data that would bloat localStorage
  transfer = decorate(transfer, { locale: 'en_US' })
  return `
    <li class="transfer" id="${transfer.id}">
      ${transfer.amount}
      ${transfer.sourceTokenName} from
      ${transfer.sender} to
      ${transfer.recipient}
      ${!transfer.callToAction ? '' : `
        <button class="act-on-transfer">
          ${transfer.callToAction}
        </button>
      `}
    </li>
  `
}

// Vanilla JS shenanigans: add a click handler to `body`, because transfers are
// rendered with JS and therefore unavailable for adding click handlers at
// initial page load.
// This will be easier if you use React or something 😄
document.querySelector('body').addEventListener('click', event => {
  const callToAction = event.target.closest('.act-on-transfer')
  if (callToAction) {
    const transferId = callToAction.closest('.transfer').id
    act(transferId)
  }
})
```

And an equivalent `Transfer` component, if using React:

```jsx
import { act, decorate } from '@near-eth/client'

export function Transfer (transfer) {
  // "decorate" transfer with realtime info & other data that would bloat localStorage
  transfer = decorate(transfer, { locale: 'en_US' })
  return (
    <li>
      {transfer.amount}
      {transfer.sourceTokenName} from
      {transfer.sender} to
      {transfer.recipient}
      {transfer.callToAction &&
        <button onClick={() => act(transfer.id)}>
          {transfer.callToAction}
        </button>
      }
    </li>
  )
}
```

Here's some [docs about act][act], and [two][act2] [example][act3] connector-specific behaviors.
Here's some [docs about decorate][decorate].
Here's the attributes for [two][initiate-natural] [kinds][initiate-bridged] of raw transfers, prior to being decorated.

  [act]: https://github.com/aurora-is-near/rainbow-bridge-client/blob/227c50ba6506f4f81e6105a0bbb1873a3adee754/packages/client/src/index.ts#L194
  [act2]: https://github.com/aurora-is-near/rainbow-bridge-client/blob/227c50ba6506f4f81e6105a0bbb1873a3adee754/packages/nep141-erc20/src/natural-erc20/sendToNear/index.js#L107
  [act3]: https://github.com/aurora-is-near/rainbow-bridge-client/blob/227c50ba6506f4f81e6105a0bbb1873a3adee754/packages/nep141-erc20/src/bridged-nep141/sendToEthereum/index.js#L114
  [decorate]: https://github.com/aurora-is-near/rainbow-bridge-client/blob/227c50ba6506f4f81e6105a0bbb1873a3adee754/packages/client/src/index.ts#L78
  [initiate-natural]: https://github.com/aurora-is-near/rainbow-bridge-client/blob/227c50ba6506f4f81e6105a0bbb1873a3adee754/packages/nep141-erc20/src/natural-erc20/sendToNear/index.js#L186
  [initiate-bridged]: https://github.com/aurora-is-near/rainbow-bridge-client/blob/227c50ba6506f4f81e6105a0bbb1873a3adee754/packages/nep141-erc20/src/bridged-nep141/sendToEthereum/index.js#L288


Step 4: check & update status of in-progress transfers
------------------------------------------------------

Wait for the Ethereum & NEAR authentications described in Step 1 to complete, then call this:

```js
import { checkStatusAll } from '@near-eth/client'

checkStatusAll({ loop: 15000 })
```

What's it do?

This library is designed to be non-blocking, which means a user can start
multiple transfers at once, and the library won't pause to wait for blocks to
be mined in Ethereum, finalized in NEAR, or synced between the two.

This means that with only the code from Steps 1-3, nothing else will happen. A
user will have sent an initial transaction to the Ethereum or NEAR blockchain,
but neither your app nor any other service will ever check to see if that
transaction completes successfully. Nor will any app or service prompt the user
to complete the next transaction in the process (any transfer requires multiple
steps & multiple on-chain transactions to complete).

`checkStatusAll` will loop as frequently as you tell it to. It will check to
see if transactions have been mined, synced, or finalized, and update transfers
in localStorage accordingly. When transfers are updated, the `onChange`
function in Step 3 will trigger a UI update.

  [authEthereum]: https://github.com/aurora-is-near/rainbow-bridge-frontend/blob/master/src/js/authEthereum.js
  [authNear]: https://github.com/aurora-is-near/rainbow-bridge-frontend/blob/master/src/js/authNear.js


Step 5: there is no step 5!
---------------------------

That's it! You successfully integrated cross-chain transfers into your app in
just four steps. 🌈🌉🎉

To make it more beautiful, check out [the API docs](#TODO🙃) and [example
code][example] (implemented in vanilla/no-framework JavaScript).

  [example]: https://github.com/aurora-is-near/rainbow-bridge-frontend/blob/30d2bca74e6c6c3128504c025b44e55b2fb4dac6/src/html/transfers.html#L452


Transfer history
================

Transfer statuses are recorded in the browser local storage so the information will be lost when users change browser or delete storage.
It is possible to find an account's transfer history using `findAllTransfers` or a combination of `findAllTransactions` and `recover` for more flexibility.

Ethereum -> NEAR transfers are found using bridge token lock/burn events queried at an Ethereum archive node.

NEAR -> Ethereum transfers are found using the NEAR indexer.

```js
import { findAllTransactions, recover } from '@near-eth/nep141-erc20/dist/bridged-nep141/sendToEthereum'
const transactions = await findAllTransactions({
  fromBlock: process.env.nearAutoSyncFromBlock,
  toBlock: 'latest',
  sender: userAccountId,
  erc20Address,
  callIndexer: async (query) => await wampSession.call(`com.nearprotocol.mainnet.explorer.select:INDEXER_BACKEND`, [query])
})
// Using `findAllTransactions` enables filtering transfers already completed to optimise the number of queries.
// `findAllTransfers` will query and build proofs for all transfers from scratch.
const transfers = await Promise.all(transactions.map(async tx => await recover(tx)))
```

The user of this library should specify the `callIndexer` callback with the preferred way of connecting to NEAR Indexer.
Browsers should connect to a backend providing Indexer data or can use a WAMP session to query the indexer via NEAR Explorer backend. Node.js applications can connect directly to the Indexer with Sequelize.


Author a custom connector library
=================================

1. Copy the code in the [`@near-eth/nep141-erc20`](../../packages/nep141-erc20) library
2. Adjust for your needs
3. Send a Pull Request to add your client to [the `getTransferType` lookup logic](https://github.com/aurora-is-near/rainbow-bridge-client/blob/227c50ba6506f4f81e6105a0bbb1873a3adee754/packages/client/src/index.ts#L14) in `@near-eth/client`
