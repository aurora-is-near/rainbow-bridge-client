import { ethers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { erc20 } from '@near-eth/utils'

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
