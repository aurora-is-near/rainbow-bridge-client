`@near-eth/aurora-nep141`
========================
<a href="https://www.npmjs.com/package/@near-eth/aurora-nep141"><img alt="@near-eth/aurora-nep141 Version" src="https://img.shields.io/npm/v/@near-eth/aurora-nep141"></a>

A Connector Library for sending [NEP141] tokens to Aurora.

This is a Connector Library that integrates with [@near-eth/client]. For detailed instructions on how to use it, see the README there.

This package makes it easy for your app (or, someday, CLI) to send *Fungible Tokens* from NEAR to Aurora. It lets you send [NEP141] (NEAR's Fungible Token Standard) Tokens to Aurora where they become [ERC20] (Ethereum's Fungible Token standard), and can then be sent back again.

These transfers between NEAR and Aurora don't happen over the Rainbow Bridge so they are instantaneous and a single Aurora or NEAR transaction is needed.

  [@near-eth/client]: https://www.npmjs.com/package/@near-eth/client
  [ERC20]: https://eips.ethereum.org/EIPS/eip-20
  [NEP141]: https://github.com/near/NEPs/issues/141
