## <small>1.3.1 (2021-04-28)</small>

* fix: broken links in README ([01240d2](https://github.com/aurora-is-near/rainbow-bridge-client/commit/01240d2))
* fix: checksum address needed for trustwallet icon fetch ([4f8dfeb](https://github.com/aurora-is-near/rainbow-bridge-client/commit/4f8dfeb))
* fix: update eth-object for Berlin hard fork fix ([9896978](https://github.com/aurora-is-near/rainbow-bridge-client/commit/9896978))
* fix: use bridging urlParam to handle redirect ([227c50b](https://github.com/aurora-is-near/rainbow-bridge-client/commit/227c50b))
* chore: add CODEOWNERS ([0b3907b](https://github.com/aurora-is-near/rainbow-bridge-client/commit/0b3907b))
* chore: release nep141-erc20 v1.3.1 ([482fbeb](https://github.com/aurora-is-near/rainbow-bridge-client/commit/482fbeb))
* chore: release nep141-erc20 v1.3.2 ([1c75a6e](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1c75a6e))
* chore: update aurora-is-near url ([cc553ba](https://github.com/aurora-is-near/rainbow-bridge-client/commit/cc553ba))
* docs: eBNNA, not BNNAᵉ ([5f7e50b](https://github.com/aurora-is-near/rainbow-bridge-client/commit/5f7e50b))
* docs: README updates ([0c6768a](https://github.com/aurora-is-near/rainbow-bridge-client/commit/0c6768a))
* README link improvements ([1a88f52](https://github.com/aurora-is-near/rainbow-bridge-client/commit/1a88f52))
* build: remove eth-util-lite ([2e09f18](https://github.com/aurora-is-near/rainbow-bridge-client/commit/2e09f18))



## 1.3.0 (2021-04-13)

* fix: add light patricia trie for browser support ([7c273d7](https://github.com/near/rainbow-bridge-client/commit/7c273d7))
* fix: don't use WalletConnectProvider for receipt queries ([e66c724](https://github.com/near/rainbow-bridge-client/commit/e66c724))
* fix: find approval replacement tx shouldn't check value ([8f886d6](https://github.com/near/rainbow-bridge-client/commit/8f886d6))
* chore: release nep141-erc20 v1.2.5 ([72f4ec9](https://github.com/near/rainbow-bridge-client/commit/72f4ec9))



## <small>1.2.1 (2021-04-02)</small>

* fix: set url param before updating status.IN_PROGRESS ([8a92734](https://github.com/near/rainbow-bridge-client/commit/8a92734))
* fix: upgrade web3, handle possible invalid receipt.status ([2c64118](https://github.com/near/rainbow-bridge-client/commit/2c64118))
* chore: release nep141-erc20 v1.2.1 ([80baae6](https://github.com/near/rainbow-bridge-client/commit/80baae6))
* chore: release nep141-erc20 v1.2.3 ([3486ab9](https://github.com/near/rainbow-bridge-client/commit/3486ab9))
* bump nep141-erc20 version to 1.2.2 ([a7e2f74](https://github.com/near/rainbow-bridge-client/commit/a7e2f74))
* Revert "fix: reduce mint deposit 10x" ([9eaed46](https://github.com/near/rainbow-bridge-client/commit/9eaed46))
* style: rename transfer steps ([a9fe8af](https://github.com/near/rainbow-bridge-client/commit/a9fe8af))



## 1.2.0 (2021-03-31)

* fix: fix lock event search ([bb6a873](https://github.com/near/rainbow-bridge-client/commit/bb6a873))
* fix: handle interrupted near tx (tab closed, go back...) ([c38e0df](https://github.com/near/rainbow-bridge-client/commit/c38e0df))
* fix: improve error message ([c549cae](https://github.com/near/rainbow-bridge-client/commit/c549cae))
* fix: reduce mint deposit 10x ([4c5a736](https://github.com/near/rainbow-bridge-client/commit/4c5a736))
* fix: update naj, remove authAgainst ([9425b43](https://github.com/near/rainbow-bridge-client/commit/9425b43))
* refactor: refactor, fix eslint ([1615155](https://github.com/near/rainbow-bridge-client/commit/1615155))
* refactor: rename with ethCache object ([74233eb](https://github.com/near/rainbow-bridge-client/commit/74233eb))
* docs: improve remove transfer ([952248c](https://github.com/near/rainbow-bridge-client/commit/952248c))
* feat: add transfer version ([74474f2](https://github.com/near/rainbow-bridge-client/commit/74474f2))
* feat: handle speedup/cancel tx ([c080911](https://github.com/near/rainbow-bridge-client/commit/c080911))
* feat: skip approval if enough allowance ([ab3bb72](https://github.com/near/rainbow-bridge-client/commit/ab3bb72))



## 1.1.0 (2021-03-19)

* fix: recover returns transfer to enable confirmation ([643f2d5](https://github.com/near/rainbow-bridge-client/commit/643f2d5))
* fix: rename bridged token ([ac19a56](https://github.com/near/rainbow-bridge-client/commit/ac19a56))
* fix: update bridge new token deposit ([0538c97](https://github.com/near/rainbow-bridge-client/commit/0538c97))
* fix: use successValue to get withdraw information ([15b1f96](https://github.com/near/rainbow-bridge-client/commit/15b1f96))
* refactor: refactor parseWithdrawReceipt() ([cb6c5ca](https://github.com/near/rainbow-bridge-client/commit/cb6c5ca))
* feat: add eth->near transfer recovery from lock hash ([7c300b9](https://github.com/near/rainbow-bridge-client/commit/7c300b9))
* feat: add near->eth transfer recovery from withdraw hash ([d3ae9a5](https://github.com/near/rainbow-bridge-client/commit/d3ae9a5))
* feat: add transfer removal during status check ([4a852f0](https://github.com/near/rainbow-bridge-client/commit/4a852f0))
* style: rename transfer steps ([201b6b6](https://github.com/near/rainbow-bridge-client/commit/201b6b6))



## 1.0.0 (2021-03-18)

* fix: allow retry of approve tx ([856d4b4](https://github.com/near/rainbow-bridge-client/commit/856d4b4))
* fix: block sync recovery to eth ([b8166ec](https://github.com/near/rainbow-bridge-client/commit/b8166ec))
* fix: check nearTx.status.Unknown, record mintHashes ([3e312b9](https://github.com/near/rainbow-bridge-client/commit/3e312b9))
* fix: don't checkStatus if wrong eth network ([40323cb](https://github.com/near/rainbow-bridge-client/commit/40323cb))
* fix: improve don't checkStatus if wrong eth network ([db38330](https://github.com/near/rainbow-bridge-client/commit/db38330))
* fix: improve error handling. ([cd01452](https://github.com/near/rainbow-bridge-client/commit/cd01452))
* fix: near.txStatus should use sender account id for sharding support ([1fcc321](https://github.com/near/rainbow-bridge-client/commit/1fcc321))
* fix: prevent fail when no tx hash before redirect ([1c34696](https://github.com/near/rainbow-bridge-client/commit/1c34696))
* fix: prevent failed transfer before near wallet redirect ([3b54b50](https://github.com/near/rainbow-bridge-client/commit/3b54b50))
* fix: update eth confirmations to 20 ([4576a7e](https://github.com/near/rainbow-bridge-client/commit/4576a7e))
* fix: update for ft-141 ([859e673](https://github.com/near/rainbow-bridge-client/commit/859e673))
* feat: remove access keys and check txHash from wallet redirect ([5a05b24](https://github.com/near/rainbow-bridge-client/commit/5a05b24))
* feat: support withdraw proof from 2fa confirm tx ([095466b](https://github.com/near/rainbow-bridge-client/commit/095466b))



## <small>0.1.3 (2021-03-04)</small>

* fix: prevent 2nd eth approval if another lock already pending ([93ac442](https://github.com/near/rainbow-bridge-client/commit/93ac442))



## <small>0.1.2 (2021-02-25)</small>

* fix: prevent scientific notation in amount ([28570e1](https://github.com/near/rainbow-bridge-client/commit/28570e1))



## <small>0.1.1 (2021-02-24)</small>

* build: rename @near-eth and fix typescript 4.1.5 ([f95a5f3](https://github.com/near/rainbow-bridge-client/commit/f95a5f3))



## 0.1.0 (2021-02-24)

* chore: add @types/node and changelog generator ([837cde8](https://github.com/near/rainbow-bridge-lib/commit/837cde8))
* chore: add yarn version ([be297ce](https://github.com/near/rainbow-bridge-lib/commit/be297ce))
* fix: TRANSFER_TYPE to match package, fix import ([8eaba0a](https://github.com/near/rainbow-bridge-lib/commit/8eaba0a))
* fix: update to frontend master (PR#99) ([81ce0c5](https://github.com/near/rainbow-bridge-lib/commit/81ce0c5)), closes [PR#99](https://github.com/PR/issues/99)



## <small>1.1.1 (2021-02-19)</small>

* add .vscode/settings.json ([51f1315](https://github.com/near/rainbow-bridge-lib/commit/51f1315))
* add stricter better TS linting; fix client ([e305d32](https://github.com/near/rainbow-bridge-lib/commit/e305d32))
* add yarn version plugin, bump client version ([bb8bf70](https://github.com/near/rainbow-bridge-lib/commit/bb8bf70))
* Convert to monorepo using Yarn 2 workspaces ([cea4327](https://github.com/near/rainbow-bridge-lib/commit/cea4327))
* fix package.json links to GitHub ([cd4c3d0](https://github.com/near/rainbow-bridge-lib/commit/cd4c3d0))
* get nep141~erc20 building ([41e8473](https://github.com/near/rainbow-bridge-lib/commit/41e8473))
* mv tsconfig outDir to each project ([c85d343](https://github.com/near/rainbow-bridge-lib/commit/c85d343))
* remove machine-specific resolutions ([cd35c65](https://github.com/near/rainbow-bridge-lib/commit/cd35c65))
* remove tilde from package name ([8b13385](https://github.com/near/rainbow-bridge-lib/commit/8b13385))
* remove tsconfig.json duplication ([bad8698](https://github.com/near/rainbow-bridge-lib/commit/bad8698))
* update packages to 0.1.2 ([ada54f8](https://github.com/near/rainbow-bridge-lib/commit/ada54f8))
* update ts target to es2019 ([736ed1d](https://github.com/near/rainbow-bridge-lib/commit/736ed1d))
* yarn set version berry ([af41fbe](https://github.com/near/rainbow-bridge-lib/commit/af41fbe))
* fix: add release setup ([2ba8bb3](https://github.com/near/rainbow-bridge-lib/commit/2ba8bb3))
* fix: lint errors; undefined 'web3' bug ([c0438db](https://github.com/near/rainbow-bridge-lib/commit/c0438db))
* fix: use Zero-Install mode; update Contributing ([b73039a](https://github.com/near/rainbow-bridge-lib/commit/b73039a))
* build: add @yarnpkg/plugin-typescript ([fc0edee](https://github.com/near/rainbow-bridge-lib/commit/fc0edee))
* build: rm commitlint & semantic-release (for now) ([ae0ceea](https://github.com/near/rainbow-bridge-lib/commit/ae0ceea))
* feat: extract from rainbow-bridge-frontend ([bb47977](https://github.com/near/rainbow-bridge-lib/commit/bb47977))



