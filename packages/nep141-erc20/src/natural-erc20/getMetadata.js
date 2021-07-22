import { ethers } from 'ethers'
import getName from './getName'
import { getEthProvider } from '@near-eth/client/dist/utils'

const erc20Symbols = {}
export async function getSymbol (address) {
  if (erc20Symbols[address]) return erc20Symbols[address]

  const provider = getEthProvider()
  const contract = new ethers.Contract(
    address,
    process.env.ethErc20AbiText,
    provider
  )

  erc20Symbols[address] = await contract.symbol()
    .catch(() => address.slice(0, 5) + '…')

  return erc20Symbols[address]
}

const erc20Decimals = {}
export async function getDecimals (address) {
  if (erc20Decimals[address] !== undefined) return erc20Decimals[address]

  const provider = getEthProvider()

  const contract = new ethers.Contract(
    address,
    process.env.ethErc20AbiText,
    provider
  )

  try {
    erc20Decimals[address] = Number(await contract.decimals())
  } catch {
    console.log(`Failed to read token decimals for: ${address}`)
    erc20Decimals[address] = 0
  }

  return erc20Decimals[address]
}

const erc20Icons = {}
async function getIcon (address) {
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

/**
 * Fetch name, icon, and decimals (precision) of ERC20 token with given `address`.
 * @param address ERC20 token contract address
 * @returns {Promise<{ address: string, decimals: number, icon: string|null, name: string }>}
 */
export default async function getMetadata (address) {
  const [decimals, icon, name, symbol] = await Promise.all([
    getDecimals(address),
    getIcon(address),
    getName(address),
    getSymbol(address)
  ])
  return {
    decimals,
    icon,
    name,
    symbol
  }
}
