import getAddress from './getAddress'
import { getSymbol } from '../natural-erc20/getMetadata'

// TODO: get from NEAR token metadata
async function getName (erc20Address: string): Promise<string> {
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
export default async function getMetadata (
  { erc20Address }: { erc20Address: string }
): Promise<{address: string, decimals: null, icon: null, name: string}> {
  const address = getAddress({ erc20Address })
  const name = await getName(erc20Address)

  return {
    address,
    decimals: null,
    icon: null,
    name
  }
}
