import Web3 from 'web3'
import getName from './getName'
import { getEthProvider } from '@near-eth/client/dist/utils'

export async function getBalance (address, user) {
  if (!user) return null

  const web3 = new Web3(getEthProvider())

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    address
  )

  return await erc20Contract.methods.balanceOf(user).call()
}

const erc20Decimals = {}
export async function getDecimals (address) {
  if (erc20Decimals[address] !== undefined) return erc20Decimals[address]

  const web3 = new Web3(getEthProvider())

  const contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    address
  )

  erc20Decimals[address] = Number(
    await contract.methods.decimals()
      .call()
      .catch(() => 0)
  )

  return erc20Decimals[address]
}

const erc20Icons = {}
async function getIcon (address) {
  if (erc20Icons[address] !== undefined) return erc20Icons[address]

  // Checksum address needed to fetch token icons.
  const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${
    Web3.utils.toChecksumAddress(address)
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
export default async function getErc20Data (address) {
  const [decimals, icon, name] = await Promise.all([
    getDecimals(address),
    getIcon(address),
    getName(address)
  ])
  return {
    address,
    decimals,
    icon,
    name
  }
}
