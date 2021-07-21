import getAddress from './getAddress'
import getBalance from './getBalance'
import { getSymbol } from '../natural-erc20/getMetadata'

// TODO: get from NEAR token metadata
async function getName (erc20Address) {
  const erc20Name = await getSymbol({ erc20Address })
  return 'n' + erc20Name
}

/**
 * Fetch address, name, icon, and decimals (precision) of NEP141 token matching
 * given `erc20Address`.
 *
 * Can provide a NEAR account address as second argument, in which case that
 * account's balance will also be returned. If omitted, `balance` is returned
 * as `null`.
 *
 * Values other than `balance` are cached.
 *
 * Returned `decimals` and `icon` will always be `null` until ratification,
 * adoption, & implementation of https://github.com/near/NEPs/discussions/148
 *
 * @param erc20Address ERC20 token contract address
 * @param user (optional) NEAR account address that may hold tokens with given `erc20Address`
 *
 * @returns {Promise<{ address: string, balance: number|null, decimals: null, icon: null, name: string }>}
 */
export default async function getNep141Data (erc20Address, user) {
  const address = getAddress(erc20Address)

  const [balance, name] = await Promise.all([
    // getBalance purposely designed to always require `user`; circumventing here
    // to match `naturalErc20.getMetadata`
    new Promise((resolve, reject) => {
      if (!user) resolve(null)
      else getBalance({ erc20Address, user }).then(resolve).catch(reject)
    }),
    getName(erc20Address)
  ])

  return {
    address,
    balance,
    decimals: null,
    icon: null,
    name
  }
}
