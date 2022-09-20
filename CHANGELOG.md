# [2.5.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v2.4.0...v2.5.0) (2022-09-20)


### Bug Fixes

* Remove $NEAR deposit to deploy to Aurora. ([a006872](https://github.com/aurora-is-near/rainbow-bridge-client/commit/a0068726d199db3e30c9f5dac57aa99f74acb5ad))
* Use args_base64 from indexer (replace json). ([378b1e0](https://github.com/aurora-is-near/rainbow-bridge-client/commit/378b1e0d4fd6e6721742a4f40561db2c750b04af))


### Features

* Add @near-eth/rainbow package. ([578b01c](https://github.com/aurora-is-near/rainbow-bridge-client/commit/578b01c1b24680b2fc22105a9ab3c686403f5b84))
* Add payNep141Storage, getBalance returns AccountBalance. ([a9b5031](https://github.com/aurora-is-near/rainbow-bridge-client/commit/a9b50311f58a4281b3d14010e5fa3fd9d4ae1a78))
* Add storage lock for multi tab conflict with near tx. ([228cff2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/228cff25ef2c4a5ef7a3a4556a1039f8dc4e3a88))
* Support injected NEAR wallet (Sender). ([0e5dd64](https://github.com/aurora-is-near/rainbow-bridge-client/commit/0e5dd648e98155c08793e7d17230e338b767f356))
* Support near-wallet-selector, backward compatible. ([746b297](https://github.com/aurora-is-near/rainbow-bridge-client/commit/746b297ab29d20284608432fb585c9f3780668ed))



# [2.4.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v2.3.0...v2.4.0) (2021-12-21)


### Bug Fixes

* Add getTransactionByNonce start bound check. ([d0b77e5](https://github.com/aurora-is-near/rainbow-bridge-client/commit/d0b77e5e96c27546e9cc3f67b76ec17a6fe8d04b))
* Simplify getTransactionByNonce. ([a30c076](https://github.com/aurora-is-near/rainbow-bridge-client/commit/a30c07642526996b36b5fb033d0a867d0cb432e3))


### Features

* Add findFinalizationTxOnEthereum. ([c548c61](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c548c6156728854b2b01eaa9c26e88ce54f814e1))
* Add findFinalizationTxOnNear and finishTime. ([269ba6a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/269ba6af3daf4b4a59a86b0b7cb546d6c2b2d6ad))
* Add finishTime in transfers to Ethereum. ([b5dbf2a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/b5dbf2ad2ff5b3b116965124b21e632310503377))
* Allow 0x in aurora recipient format. ([9e1f6dd](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9e1f6dd0cab29e6d885cadd161d3cd6944a3da55))



# [2.3.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v2.2.0...v2.3.0) (2021-10-29)


### Bug Fixes

* NEAR proof sharding fix. ([555c3c4](https://github.com/aurora-is-near/rainbow-bridge-client/commit/555c3c4ee471e6593f29b1b05edb69ed6ea8ccbf))


### Features

* Add aurora-nep141 recover. ([934adc6](https://github.com/aurora-is-near/rainbow-bridge-client/commit/934adc684dd5546ee1c7c4be6014c63f4fb4ae37))
* Restore Aurora -> Eth transfer from NEAR relayer tx. ([9beb6f9](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9beb6f9c2dca6fad0a5f618d9811d27ec2411ab3))



# [2.2.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v2.1.0...v2.2.0) (2021-10-20)


### Bug Fixes

* Query icon from nep141, update naj release. ([51f54c2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/51f54c20eb4741df2cca95f4f5728e4276029430))
* Remove unnecessary conflictingTransfer check. ([144bf35](https://github.com/aurora-is-near/rainbow-bridge-client/commit/144bf35bf4b16b1f73868a9ddb39673be0fcd63d))
* Replace eth_getStorageAt. ([1d41f5f](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1d41f5f4f3319f031a0543352344a104c9b93ea3))
* Throw on invalid eth/aurora chain id. ([f5a5f75](https://github.com/aurora-is-near/rainbow-bridge-client/commit/f5a5f7563c34cd6df5b94d95db8cb687a0d61c20))


### Features

* Add findAllTransfers to/from Aurora. ([4b3de53](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4b3de539091f8622711e709ab7ea2ee1cede1699), [47318fc](https://github.com/aurora-is-near/rainbow-bridge-client/commit/47318fc2dd3deacc676fef7f2a3a66364bf6562a))
* Add optional metadata to recover. ([e9672c1](https://github.com/aurora-is-near/rainbow-bridge-client/commit/e9672c1f3cac6742a8fc62e62c49ee0df8ffd3cb))
* Give a random `id` to transfers. ([2575d04](https://github.com/aurora-is-near/rainbow-bridge-client/commit/2575d0419d19577213c98cb3b07b8692f4b73d5a))
* Refactor aurora-nep141/bridged-ether. ([c373bd2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c373bd2d480a2d81782322d7f7468936eed9bf91))



# [2.1.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v2.0.0...v2.1.0) (2021-09-23)


### Bug Fixes

* Add symbol to Ethereum<>NEAR transfers. ([1ea4231](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1ea4231239f0a14dd5b3a5b05ca20175f328ede2))
* Clear only necessary urlParams in checkStatus. ([42ffe61](https://github.com/aurora-is-near/rainbow-bridge-client/commit/42ffe61fa64c882cb675411b7e449219de87c6f9))
* Fix temp geth issue to build goerli proofs. ([a558793](https://github.com/aurora-is-near/rainbow-bridge-client/commit/a558793ae3deb04e4079307b69a60b58169eac5d))
* Improve aurora-nep141 checkStatus. ([b6afe63](https://github.com/aurora-is-near/rainbow-bridge-client/commit/b6afe6388dfc0792d1f885030214984cadd2afcd))
* Query getMetadata in Near -> Aurora transfer. ([fa607a6](https://github.com/aurora-is-near/rainbow-bridge-client/commit/fa607a60c5edec33ffec4cc993f0e27ea096ccd7))
* Rename etherExitToNearPrecompile. ([3ada12a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/3ada12a50592ccf4f568881b02f529749d08a1f6))
* Simplify and improve NEAR wallet error handling. ([7d0be36](https://github.com/aurora-is-near/rainbow-bridge-client/commit/7d0be36dc4933bab6b6e2546c890a99047d1696a))
* Update ethers to fix find-replacement-tx. ([2686ce7](https://github.com/aurora-is-near/rainbow-bridge-client/commit/2686ce784a56c31f199eb625928a696828abf79d))
* Update naj broken upstream github commit. ([1aeb898](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1aeb8987a335a440c4a045cb46905447157b4705))
* Use find-replacement-tx for aurora tx also. ([57986bf](https://github.com/aurora-is-near/rainbow-bridge-client/commit/57986bfbb1faa8635ecdfe368dc5fbc6519dedb8))


### Features

* Add aurora-nep141. ([f8ec94e](https://github.com/aurora-is-near/rainbow-bridge-client/commit/f8ec94e606d7fb2db4a3b0f9ca3e601ffde8b598))
* Add findAllTransfers for NEAR -> Aurora. ([db282fd](https://github.com/aurora-is-near/rainbow-bridge-client/commit/db282fdcd1378ad93f156c38f871a7a7aa8d5a6b))



# [2.0.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.6.0...v2.0.0) (2021-08-27)


### Bug Fixes

* Backwards compatibility ongoing transfers. ([58dbb3a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/58dbb3a4d7aeaeba030e58ff545cd66d6cafeef5))
* Catch possibly slow NEAR Wallet redirect. ([270642b](https://github.com/aurora-is-near/rainbow-bridge-client/commit/270642b984a700d066666ae33b06825016165946))
* Fix get_erc20_from_nep141 with new api. ([9d77085](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9d77085c99bfc558502c52af7af359f0aa989cb2))
* Fix recover transfer from aurora. ([cf7ef5c](https://github.com/aurora-is-near/rainbow-bridge-client/commit/cf7ef5c17978d541b2fab5e2c5f4425f20d9762c))
* Improve initiate options for flexibility. ([0186c42](https://github.com/aurora-is-near/rainbow-bridge-client/commit/0186c42f906d692e574d49c56b239bc1fed4ff8a))
* Improve recover/finalize options. ([64a33c3](https://github.com/aurora-is-near/rainbow-bridge-client/commit/64a33c373f3414cc74b2d2a5a210aee40d565e25))
* Record recovered tx hash. ([166bc08](https://github.com/aurora-is-near/rainbow-bridge-client/commit/166bc08cabb29ccd414b70b4005033f198f448b2))
* Track right before near functionCall. ([21ef48e](https://github.com/aurora-is-near/rainbow-bridge-client/commit/21ef48e78edc3a76085ed14a60091ce2e010dcf8))


### Features

* Add bridgeParams to client. ([c30637a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c30637a379454a5bfd9547ad5bf51b70ba69dab2))
* Add findAllTransfers in near-ether. ([b9f9ecb](https://github.com/aurora-is-near/rainbow-bridge-client/commit/b9f9ecb618bc6cd44396c46d54ff6676fb349dcb))
* Add findAllTransfers in nep141-erc20. ([393ead6](https://github.com/aurora-is-near/rainbow-bridge-client/commit/393ead6d90bf820f16031bfb2beeb4dd3c9c17ce))
* Add node.js support. ([ed1c3ea](https://github.com/aurora-is-near/rainbow-bridge-client/commit/ed1c3ea2183f38a775166314224c9af8ccb60f2b))
* FindAllTransfers browser support. ([aca833f](https://github.com/aurora-is-near/rainbow-bridge-client/commit/aca833f8fa798572385ff24e323673b249ad9de9))
* New aurora-ether, aurora-erc20 api. ([c3153c1](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c3153c139a834eb447b79593e1e03a6dfd585c0b))
* New near-ether api. ([1de52f3](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1de52f32813b4e5a2a8114c26c690855afcf0604))
* New nep141-erc20/bridged-nep141 api. ([4e28ff3](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4e28ff318903a60dd9a6b90debbebff8d3636700))
* New nep141-erc20/natural-erc20 api. ([cd288ce](https://github.com/aurora-is-near/rainbow-bridge-client/commit/cd288ce6befc984851924b42333b974e5a6b337a))
* Optional `sender` in transfer from NEAR. ([b2ad5a4](https://github.com/aurora-is-near/rainbow-bridge-client/commit/b2ad5a4d5a8db7ea812ca1fa1a13d1b69dec3f21))
* Record `startTime` of transfer. ([8e11962](https://github.com/aurora-is-near/rainbow-bridge-client/commit/8e1196207f218aa1ad6c80946d00e5ad5183fb4a))
* Refactor `buildIndexerTxQuery` to `utils`. ([4054d57](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4054d57cab92b3cb1a7669124bb92a7dd07114dc))
* Remove APPROVE from transfer steps. ([d7f834e](https://github.com/aurora-is-near/rainbow-bridge-client/commit/d7f834ef32bebc096dd53f4cf20d55b74339c74a))



# [1.6.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.5.1...v1.6.0) (2021-07-23)


### Bug Fixes

* `findEthProof` support eip1559. ([01dc4a0](https://github.com/aurora-is-near/rainbow-bridge-client/commit/01dc4a035b0e8b7ef937bd4de246ba8c9f9d44d0))
* Add id to recovered Erc20 -> Aurora. ([6b352ff](https://github.com/aurora-is-near/rainbow-bridge-client/commit/6b352ff3375ba35dcdbdfe4d1cfc341044f7e7ea))
* Fix checkSync in NEAR to Ethereum. ([a167342](https://github.com/aurora-is-near/rainbow-bridge-client/commit/a167342e3c21c3271416ea1557b1fe92004e2082))
* Fix network checks. ([d395066](https://github.com/aurora-is-near/rainbow-bridge-client/commit/d395066fb94f7497c27374dece67ea90742c0aca))
* Improve handling of chain reorgs. ([daff226](https://github.com/aurora-is-near/rainbow-bridge-client/commit/daff2264d6d60e5281883b37a3e5cbefb3bc9352))
* Use getEthProvider in checkSync. ([97f4143](https://github.com/aurora-is-near/rainbow-bridge-client/commit/97f41431bdeef1d41395218b105198fa83e941f6))


### Features

* Add ETH connector to `@near-eth/near-ether`. ([a30c6b2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/a30c6b2acf6773a9fd529803b2d0ec30556cff5d))
* Reduce checkSync data queries. ([4b4947d](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4b4947d6e3b7dab9b8a741739a98463630b6391c))
* Support custom transfer types in `client`. ([3c8069a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/3c8069a674fb27b0e6b3dc5dcc8a84540154e3fe))



## [1.5.1](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.5.0...v1.5.1) (2021-07-08)


### Bug Fixes

* Update `eth-object` for pre-eip1559 compatibility. ([8c8f5b1](https://github.com/aurora-is-near/rainbow-bridge-client/commit/8c8f5b1c3038ea94af9d6eef820712199f97e8b2))



# [1.5.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.4.0...v1.5.0) (2021-07-02)


### Bug Fixes

* Doc in getAddress ([311510f](https://github.com/aurora-is-near/rainbow-bridge-client/commit/311510fc524f2e241a91937b81bb8c882ea2a94b))
* Update find-replacement-tx error handling. ([24bf5f2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/24bf5f29f25bfdfc9d21fbbc13214358b7f7e368))


### Features

* Add aurora-erc20 sendToEthereum and recover. ([ab27ade](https://github.com/aurora-is-near/rainbow-bridge-client/commit/ab27ade0f6fa3759df270221f346cc5d415b5b29))
* Add aurora-ether sendToEthereum and recover. ([1ff8fa0](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1ff8fa0a7897d66ea9810862117ca10f533aeaea))
* Check event relayer finalization (aurora). ([9da3fc0](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9da3fc0ddc6724c0952710a0fe82de98034aeb22))
* Export checkApprove. ([d9a5f91](https://github.com/aurora-is-near/rainbow-bridge-client/commit/d9a5f91b3be4b57dce9b4881445ff75b964de41d))
* Handle finalization by event relayer (erc20). ([f1039b4](https://github.com/aurora-is-near/rainbow-bridge-client/commit/f1039b490da07915b94b84056b22c00ff3aef01b))
* Recover Eth -> Aurora transfers. ([21c5c23](https://github.com/aurora-is-near/rainbow-bridge-client/commit/21c5c23c748ccb1fd1af1badcb98593e974bd1e8))
* **frtx:** Add validation with data and value. ([2c05f44](https://github.com/aurora-is-near/rainbow-bridge-client/commit/2c05f44265350ce7e14a8e6b2fa5ca8dcae63e5c))
* Handle finalization by event relayer (NEAR). ([c45e5d9](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c45e5d947587427bebde78ac26cfd6f0ff8357df))



# [1.4.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.3.1...v1.4.0) (2021-05-27)


### Bug Fixes

* Build proof before unlock. ([7a87f94](https://github.com/aurora-is-near/rainbow-bridge-client/commit/7a87f949297cd2acd95a71c34914233542b9c1ae))
* Fix failed transfer from NEAR at initiate. ([0bd4fe7](https://github.com/aurora-is-near/rainbow-bridge-client/commit/0bd4fe7c48ab60b7ccf4b4f54556a7a5c676b780))
* Fix findReplacementTx for multisig (Argent), refactor. ([327b975](https://github.com/aurora-is-near/rainbow-bridge-client/commit/327b975182940cdf529002dbb9276736285b1ee3))
* Handle network errors for findReplacementTx. ([33f4c5b](https://github.com/aurora-is-near/rainbow-bridge-client/commit/33f4c5b4adf6e15277d9a7ee30793d52a3ad8290))
* Succeed to mint eNEAR and recover ([ef311ce](https://github.com/aurora-is-near/rainbow-bridge-client/commit/ef311ce8322dcb621f5d14e7d255358fc7a7e709))
* Succeed to unlock $NEAR and recover ([717d629](https://github.com/aurora-is-near/rainbow-bridge-client/commit/717d6297ac629437abd30f63c10ac20867c9c483))


### Features

* add options for findProof() ([958578e](https://github.com/aurora-is-near/rainbow-bridge-client/commit/958578e606816be463c91d87b9b6990b34166ceb))
* Check if unlock proof was already used. ([1d76727](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1d76727a983e75521304915f1bc061c11257e27c))
* draft eNear package skeleton ([afe54bd](https://github.com/aurora-is-near/rainbow-bridge-client/commit/afe54bd7be305f961d570612a7e74f5f38eec34d))
* export findProof() ([9c40619](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9c40619b9e6b4d277c147aa1022cb7346ce3a9ba))
* Improve mint proofs ([417ecb5](https://github.com/aurora-is-near/rainbow-bridge-client/commit/417ecb599237492a99059f0e859fcf7239fac34b))
* Record speedup replacement tx hashes. ([9a62568](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9a62568581937654d3e70e35eb65812240d11c3a))



## [1.3.1](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.3.0...v1.3.1) (2021-04-28)


### Bug Fixes

* broken links in README ([01240d2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/01240d295b3dc7f5a7d26d20b1808a9fdbcf6dc6))
* checksum address needed for trustwallet icon fetch ([4f8dfeb](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4f8dfeb9ed3bfd4645b888d5252f106ac0fd42c6))
* update eth-object for Berlin hard fork fix ([9896978](https://github.com/aurora-is-near/rainbow-bridge-client/commit/98969787dc9047d31f272a904365c8f761af24de))
* use bridging urlParam to handle redirect ([227c50b](https://github.com/aurora-is-near/rainbow-bridge-client/commit/227c50ba6506f4f81e6105a0bbb1873a3adee754))



# [1.3.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.2.1...v1.3.0) (2021-04-13)


### Bug Fixes

* add light patricia trie for browser support ([7c273d7](https://github.com/aurora-is-near/rainbow-bridge-client/commit/7c273d7da9dea2e28aef3c9867b1f4c0f0a10011))
* don't use WalletConnectProvider for receipt queries ([e66c724](https://github.com/aurora-is-near/rainbow-bridge-client/commit/e66c72474200768878347a57bfd281bf389a6aef))
* find approval replacement tx shouldn't check value ([8f886d6](https://github.com/aurora-is-near/rainbow-bridge-client/commit/8f886d6f7884615bf23c07d57141471aa7ed2481))



## [1.2.1](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.2.0...v1.2.1) (2021-04-02)


### Bug Fixes

* set url param before updating status.IN_PROGRESS ([8a92734](https://github.com/aurora-is-near/rainbow-bridge-client/commit/8a927345ec8d99fd0dcd0c80249b8786a41cb65e))
* upgrade web3, handle possible invalid receipt.status ([2c64118](https://github.com/aurora-is-near/rainbow-bridge-client/commit/2c641186f25e6a5afb13fb4075380e28af3d8636))


### Reverts

* Revert "fix: reduce mint deposit 10x" ([9eaed46](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9eaed466969c617e9477f2d003fc4f3f9096a474))



# [1.2.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.1.0...v1.2.0) (2021-03-31)


### Bug Fixes

* fix lock event search ([bb6a873](https://github.com/aurora-is-near/rainbow-bridge-client/commit/bb6a873214b3376ce110c6d23f0f86d08056ede4))
* handle interrupted near tx (tab closed, go back...) ([c38e0df](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c38e0dfd3843f11dc7b33ad4969cc821364e8b62))
* improve error message ([c549cae](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c549cae1bda65e5c9ed24b23fa29e47e1f4f5f33))
* reduce mint deposit 10x ([4c5a736](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4c5a7362df18d3ecf2de84fc4b43be311792b462))
* update naj, remove authAgainst ([9425b43](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9425b434dfa583222df27e3ef3d00573462863ca))


### Features

* add transfer version ([74474f2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/74474f23ce86d0352326f9422c57bbb8a1578029))
* handle speedup/cancel tx ([c080911](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c0809118d2cf082661f4a20d873e120eb010b15c))
* skip approval if enough allowance ([ab3bb72](https://github.com/aurora-is-near/rainbow-bridge-client/commit/ab3bb726c35c5b91b154eec5499861ba5f957a81))



# [1.1.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v1.0.0...v1.1.0) (2021-03-19)


### Bug Fixes

* recover returns transfer to enable confirmation ([643f2d5](https://github.com/aurora-is-near/rainbow-bridge-client/commit/643f2d50be6d0173b23ff4c66c778326743567ce))
* rename bridged token ([ac19a56](https://github.com/aurora-is-near/rainbow-bridge-client/commit/ac19a56f0f3e32d7e4bc814b737ccd8c132060ed))
* update bridge new token deposit ([0538c97](https://github.com/aurora-is-near/rainbow-bridge-client/commit/0538c976199148261a8d3f8add57b9755a3a16e9))
* use successValue to get withdraw information ([15b1f96](https://github.com/aurora-is-near/rainbow-bridge-client/commit/15b1f964aa0bd725a64f714eac76f2d4ed0f9380))


### Features

* add eth->near transfer recovery from lock hash ([7c300b9](https://github.com/aurora-is-near/rainbow-bridge-client/commit/7c300b972bcc0d951d94b5cd45ea49b54cdfc190))
* add near->eth transfer recovery from withdraw hash ([d3ae9a5](https://github.com/aurora-is-near/rainbow-bridge-client/commit/d3ae9a510bfc77b33dc723495e7f6dc2aef62d2b))
* add transfer removal during status check ([4a852f0](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4a852f006d2b2f8e17abbcb289c32f626f497755))



# [1.0.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v0.1.3...v1.0.0) (2021-03-18)


### Bug Fixes

* allow retry of approve tx ([856d4b4](https://github.com/aurora-is-near/rainbow-bridge-client/commit/856d4b4f7c51197f60a71445ff12b9ce07e98b6a))
* block sync recovery to eth ([b8166ec](https://github.com/aurora-is-near/rainbow-bridge-client/commit/b8166ecc747a347930fc62f1c6b8a4e8a1c6579d))
* check nearTx.status.Unknown, record mintHashes ([3e312b9](https://github.com/aurora-is-near/rainbow-bridge-client/commit/3e312b9ad255c88f5557a6bf58a25cd6687080fa))
* don't checkStatus if wrong eth network ([40323cb](https://github.com/aurora-is-near/rainbow-bridge-client/commit/40323cb8e863c31022fa335bd5eefd5a70c21e03))
* improve don't checkStatus if wrong eth network ([db38330](https://github.com/aurora-is-near/rainbow-bridge-client/commit/db38330fc74c4c5495aa5ca5d574080aee0b4006))
* improve error handling. ([cd01452](https://github.com/aurora-is-near/rainbow-bridge-client/commit/cd01452daa36274bb97fea689e0c1113e1a67d41))
* near.txStatus should use sender account id for sharding support ([1fcc321](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1fcc32125f6c5e4fa9a2039d0fae6733740e5898))
* prevent fail when no tx hash before redirect ([1c34696](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1c3469615bca6312a4fb926965f8db8922d8fa47))
* prevent failed transfer before near wallet redirect ([3b54b50](https://github.com/aurora-is-near/rainbow-bridge-client/commit/3b54b503ce512ecd428dc5850602bef34b3b1fbe))
* update eth confirmations to 20 ([4576a7e](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4576a7e86765bffa37c5673cc327d497ad5ccd8c))
* update for ft-141 ([859e673](https://github.com/aurora-is-near/rainbow-bridge-client/commit/859e6733d18c57ad9b19fdc4a96f0ed66f69fde5))


### Features

* remove access keys and check txHash from wallet redirect ([5a05b24](https://github.com/aurora-is-near/rainbow-bridge-client/commit/5a05b2433e22ca34361ebf3e923c140ff17181ce))
* support withdraw proof from 2fa confirm tx ([095466b](https://github.com/aurora-is-near/rainbow-bridge-client/commit/095466b2c54798394973fcde9f6c59ebd3c8de43))



## [0.1.3](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v0.1.2...v0.1.3) (2021-03-04)


### Bug Fixes

* prevent 2nd eth approval if another lock already pending ([93ac442](https://github.com/aurora-is-near/rainbow-bridge-client/commit/93ac442b5fd3c7039ec946aa7db96901facb16cf))



## [0.1.2](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v0.1.1...v0.1.2) (2021-02-25)


### Bug Fixes

* prevent scientific notation in amount ([28570e1](https://github.com/aurora-is-near/rainbow-bridge-client/commit/28570e130d3e65361e2067c4e56d3b68ced60377))



## [0.1.1](https://github.com/aurora-is-near/rainbow-bridge-client/compare/v0.1.0...v0.1.1) (2021-02-24)



# [0.1.0](https://github.com/aurora-is-near/rainbow-bridge-client/compare/bb479773d9fe769d8b686add37dd6725f9a6351d...v0.1.0) (2021-02-24)


### Bug Fixes

* add release setup ([2ba8bb3](https://github.com/aurora-is-near/rainbow-bridge-client/commit/2ba8bb38b9a7bbb77c997df67f5985029cacba65))
* lint errors; undefined 'web3' bug ([c0438db](https://github.com/aurora-is-near/rainbow-bridge-client/commit/c0438dbbaad32154b1536c0d2f6d3ec9f6f28a49))
* TRANSFER_TYPE to match package, fix import ([8eaba0a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/8eaba0afdacc34dbad18e8417d744a2338529ae8))
* update to frontend master (PR[#99](https://github.com/aurora-is-near/rainbow-bridge-client/issues/99)) ([81ce0c5](https://github.com/aurora-is-near/rainbow-bridge-client/commit/81ce0c5fcb1701171ee2a8775072ba9b30021c33))
* use Zero-Install mode; update Contributing ([b73039a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/b73039a649e2f34c5a9864023e11551157173e1a))


### Features

* extract from rainbow-bridge-frontend ([bb47977](https://github.com/aurora-is-near/rainbow-bridge-client/commit/bb479773d9fe769d8b686add37dd6725f9a6351d))



