Rainbow Bridge Client Libraries
===============================

Monorepo containing NEAR-maintained libraries for using the Rainbow Bridge from an app (or, someday, CLI)


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
