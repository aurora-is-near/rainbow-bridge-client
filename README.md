Rainbow Bridge Client Libraries
===============================

Monorepo containing NEAR-maintained libraries for using the Rainbow Bridge from an app (or, someday, CLI)

![Install and Build](https://github.com/aurora-is-near/rainbow-bridge-client/actions/workflows/build.yaml/badge.svg)
![Lint](https://github.com/aurora-is-near/rainbow-bridge-client/actions/workflows/lint.yaml/badge.svg)


| Packages | Version |
| :------- | :------ |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/client">@near-eth/client</a> | <a href="https://www.npmjs.com/package/@near-eth/client"><img alt="@near-eth/client Version" src="https://img.shields.io/npm/v/@near-eth/client"></a> |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/nep141-erc20">@near-eth/nep141-erc20</a> | <a href="https://www.npmjs.com/package/@near-eth/nep141-erc20"><img alt="@near-eth/nep141-erc20 Version" src="https://img.shields.io/npm/v/@near-eth/nep141-erc20"></a> |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/near-ether">@near-eth/near-ether</a> | <a href="https://www.npmjs.com/package/@near-eth/near-ether"><img alt="@near-eth/near-ether Version" src="https://img.shields.io/npm/v/@near-eth/near-ether"></a> |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/aurora-erc20">@near-eth/aurora-erc20</a> | <a href="https://www.npmjs.com/package/@near-eth/aurora-erc20"><img alt="@near-eth/aurora-erc20 Version" src="https://img.shields.io/npm/v/@near-eth/aurora-erc20"></a> |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/aurora-ether">@near-eth/aurora-ether</a> | <a href="https://www.npmjs.com/package/@near-eth/aurora-ether"><img alt="@near-eth/aurora-ether Version" src="https://img.shields.io/npm/v/@near-eth/aurora-ether"></a> |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/utils">@near-eth/utils</a> | <a href="https://www.npmjs.com/package/@near-eth/utils"><img alt="@near-eth/utils Version" src="https://img.shields.io/npm/v/@near-eth/utils"></a> |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/lite-merkle-patricia-tree">lite-merkle-patricia-tree</a> | <a href="https://www.npmjs.com/package/lite-merkle-patricia-tree"><img alt="lite-merkle-patricia-tree Version" src="https://img.shields.io/npm/v/lite-merkle-patricia-tree"></a> |
| <a href="https://github.com/aurora-is-near/rainbow-bridge-client/tree/main/packages/find-replacement-tx">find-replacement-tx</a> | <a href="https://www.npmjs.com/package/find-replacement-tx"><img alt="find-replacement-tx Version" src="https://img.shields.io/npm/v/find-replacement-tx"></a> |



Contributing
============

Want to help improve any of these libraries? Thank you! Here are some steps to get started with running this repository on your own machine:

* Make sure you have [Node.js] and the latest [yarn] installed
* Clone the code
* `cd` into the repo

This project uses [Yarn 2](https://yarnpkg.com/getting-started/migration) in [Zero-Install mode](https://yarnpkg.com/features/zero-installs) so you shouldn't have to run `yarn install` when you first clone this repository.

If you use an editor other than VS Code or vim to work on this codebase, you may want to add Yarn 2 editor support to your local project [using `yarn dlx @yarnpkg/pnpify --sdk`](https://yarnpkg.com/getting-started/editor-sdks). Settings for VS Code & vim are checked into the repo.

Now you should be able to run project scripts:

* `yarn lint`
* `yarn workspaces foreach run build`

You should also see eslint & TypeScript support in your editor.

  [Node.js]: https://nodejs.org/en/download/package-manager/
  [yarn]: https://yarnpkg.com/

Releases
=========
Pull requests
-------------


This project follows the [Yarn2 release workflow](https://yarnpkg.com/features/release-workflow) with deffered versioning.

Before a branch is merged run:
```
yarn version check -i
```
And select the appropriate release which should be applied for each package changed by the PR: patch(fix), minor(feature) or major(breaking change).

Commit `.yarn/version`.

Release the repository
----------------------
Maintainers can run the following to apply deferred releases:
```
yarn version apply --all
```

Update the repository CHANGELOG:
```
yarn changelog
```

Commit and push master (also commit .yarn/version):
```
git commit -m "chore: release v2.0.0"
git tag v2.0.0
```

NPM release a package
---------------------
```
yarn build
cd packages/package-name
yarn npm publish --access public
```
