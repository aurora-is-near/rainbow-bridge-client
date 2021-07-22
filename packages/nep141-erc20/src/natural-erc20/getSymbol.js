import { ethers } from 'ethers'
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
