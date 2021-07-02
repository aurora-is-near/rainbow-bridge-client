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



