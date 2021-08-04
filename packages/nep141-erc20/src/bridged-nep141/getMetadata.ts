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
 * Values are cached.
 *
 * Returned `decimals` and `icon` will always be `null` until ratification,
 * adoption, & implementation of https://github.com/near/NEPs/discussions/148
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address ERC20 token contract address
 * @returns Metadata information
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
