`@near-eth/near-ether`
========================

A Connector Library for sending native NEAR and Ether(ETH) over the Rainbow Bridge.

This is a Connector Library that integrates with [@near-eth/client]. For detailed instructions on how to use it, see the README there.

This package makes it easy for your app (or, someday, CLI) to send NEAR and Ether(ETH) over the Rainbow Bridge, using the [Connector contracts](https://github.com/aurora-is-near/near-erc20-connector). It lets you send NEAR Tokens (NEAR's Native Token) over the Rainbow Bridge, where they become eNEAR [ERC20] Tokens (Ethereum's Fungible Token Standard), and can then be sent back again.

  [@near-eth/client]: https://www.npmjs.com/package/@near-eth/client
  [ERC20]: https://eips.ethereum.org/EIPS/eip-20