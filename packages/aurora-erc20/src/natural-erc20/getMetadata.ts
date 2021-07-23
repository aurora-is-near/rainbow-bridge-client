import { ethers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'

const erc20Decimals: {[key: string]: number} = {}
export async function getDecimals (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      provider?: ethers.providers.Web3Provider
      erc20Abi?: string
    }
  }
): Promise<number> {
  if (erc20Decimals[erc20Address] !== undefined) return erc20Decimals[erc20Address]!

  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const contract = new ethers.Contract(
    erc20Address,
    options.erc20Abi ?? bridgeParams.erc20Abi,
    provider
  )

  try {
    erc20Decimals[erc20Address] = Number(await contract.decimals())
  } catch {
    console.log(`Failed to read token decimals for: ${erc20Address}`)
    erc20Decimals[erc20Address] = 0
  }

  return erc20Decimals[erc20Address]!
}

const erc20Icons: {[key: string]: any} = {}
async function getIcon (address: string): Promise<any> {
  if (erc20Icons[address] !== undefined) return erc20Icons[address]

  // Checksum address needed to fetch token icons.
  const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${
    ethers.utils.getAddress(address)
  }/logo.png`

  erc20Icons[address] = await new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve(url)
    img.onerror = () => resolve(null)
    img.src = url
  })

  return erc20Icons[address]
}

const erc20Symbols: {[key: string]: string} = {}
export async function getSymbol (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      provider?: ethers.providers.Web3Provider
      erc20Abi?: string
    }
  }
): Promise<string> {
  if (erc20Symbols[erc20Address]) return erc20Symbols[erc20Address]!
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const contract = new ethers.Contract(
    erc20Address,
    options.erc20Abi ?? bridgeParams.erc20Abi,
    provider
  )

  try {
    erc20Symbols[erc20Address] = await contract.symbol()
  } catch {
    console.log(`Failed to read token symbol for: ${erc20Address}`)
    erc20Symbols[erc20Address] = erc20Address.slice(0, 5) + '…'
  }

  return erc20Symbols[erc20Address]!
}

/**
 * Fetch name, icon, and decimals (precision) of ERC20 token with given `address`.
 *
 * Can provide an Ethereum wallet address as second argument, in which case that
 * wallet's balance will also be returned. If omitted, `balance` is returned as `null`.
 *
 * Values other than `balance` are cached.
 *
 * @param address ERC20 token contract address
 * @param user (optional) Ethereum wallet address that may hold tokens with given `address`
 *
 * @returns {Promise<{ address: string, balance: number|null, decimals: number, icon: string|null, name: string }>}
 */
export default async function getMetadata (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      provider?: ethers.providers.Web3Provider
      erc20Abi?: string
    }
  }
): Promise<{erc20Address: string, decimals: number, icon: any, symbol: string}> {
  const [decimals, icon, symbol] = await Promise.all([
    getDecimals({ erc20Address, options }),
    getIcon(erc20Address),
    getSymbol({ erc20Address, options })
  ])
  return {
    erc20Address,
    decimals,
    icon,
    symbol
  }
}
