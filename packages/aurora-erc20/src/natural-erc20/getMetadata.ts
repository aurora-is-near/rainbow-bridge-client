import { ethers } from 'ethers'
import { Account, providers as najProviders } from 'near-api-js'
import { getEthProvider, getBridgeParams, getNearProvider } from '@near-eth/client/dist/utils'
import { erc20, nep141 } from '@near-eth/utils'

const erc20Decimals: {[key: string]: number} = {}
export async function getDecimals (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      provider?: ethers.providers.Provider
      erc20Abi?: string
    }
  }
): Promise<number> {
  if (erc20Decimals[erc20Address] !== undefined) return erc20Decimals[erc20Address]!

  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const erc20Abi = options.erc20Abi ?? bridgeParams.erc20Abi

  let decimals
  try {
    decimals = await erc20.getDecimals({ erc20Address, provider, erc20Abi })
    // Only record decimals if it was success
    erc20Decimals[erc20Address] = decimals
  } catch {
    console.log(`Failed to read token decimals for: ${erc20Address}`)
    decimals = 0
  }
  return decimals
}

const erc20Icons: {[key: string]: any} = {}
async function getIcon (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      nearAccount?: Account
      nearProvider?: najProviders.Provider
      nep141Address?: string
      nep141Factory?: string
    }
  }
): Promise<any> {
  if (erc20Icons[erc20Address] !== undefined) return erc20Icons[erc20Address]
  options = options ?? {}
  const bridgeParams = getBridgeParams()

  let icon
  try {
    const nearProvider =
      options.nearProvider ??
      options.nearAccount?.connection.provider ??
      getNearProvider()
    const nep141Factory: string = options.nep141Factory ?? bridgeParams.nep141Factory
    const nep141Address = erc20Address.replace('0x', '').toLowerCase() + '.' + nep141Factory
    const metadata = await nep141.getMetadata({ nep141Address, nearProvider })
    icon = metadata.icon
  } catch (error) {
    console.warn(error)
  }
  if (!icon) {
    // Checksum address needed to fetch token icons.
    const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${
      ethers.utils.getAddress(erc20Address)
    }/logo.png`

    icon = await new Promise(resolve => {
      const img = new Image()
      img.onload = () => resolve(url)
      img.onerror = () => resolve(null)
      img.src = url
    })
  }
  erc20Icons[erc20Address] = icon
  return icon
}

const erc20Symbols: {[key: string]: string} = {}
export async function getSymbol (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      provider?: ethers.providers.Provider
      erc20Abi?: string
    }
  }
): Promise<string> {
  if (erc20Symbols[erc20Address]) return erc20Symbols[erc20Address]!
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const erc20Abi = options.erc20Abi ?? bridgeParams.erc20Abi

  let symbol
  try {
    symbol = await erc20.getSymbol({ erc20Address, provider, erc20Abi })
    // Only record symbol if it was success
    erc20Symbols[erc20Address] = symbol
  } catch {
    console.log(`Failed to read token symbol for: ${erc20Address}`)
    if (erc20Address.toLowerCase() === '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2') {
      symbol = 'MKR'
    } else {
      symbol = erc20Address.slice(0, 5) + '…'
    }
  }
  return symbol
}

/**
 * Fetch name, icon, and decimals (precision) of ERC20 token with given `address`.
 * Values are cached.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address ERC20 token contract address
 * @param params.options Optional arguments
 * @param params.options.provider Ethereum provider to use
 * @param params.options.erc20Abi ERC-20 ABI to use
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 * @param params.options.nearProvider NEAR provider.
 * @param params.options.nep141Address Birdged NEP-141 token address on NEAR.
 * @param params.options.nep141Factory Bridge token factory account on NEAR.
 *
 * @returns Metadata information
 */
export default async function getMetadata (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      provider?: ethers.providers.Provider
      erc20Abi?: string
      nearAccount?: Account
      nearProvider?: najProviders.Provider
      nep141Address?: string
      nep141Factory?: string
    }
  }
): Promise<{erc20Address: string, decimals: number, icon: any, symbol: string}> {
  const [decimals, icon, symbol] = await Promise.all([
    getDecimals({ erc20Address, options }),
    getIcon({ erc20Address, options }),
    getSymbol({ erc20Address, options })
  ])
  return {
    erc20Address,
    decimals,
    icon,
    symbol
  }
}
