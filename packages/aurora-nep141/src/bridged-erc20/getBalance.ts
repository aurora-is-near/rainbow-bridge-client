import { ethers } from 'ethers'
import { getAuroraProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { erc20 } from '@near-eth/utils'

export default async function getBalance (
  { erc20Address, owner, options }: {
    erc20Address: string
    owner: string
    options?: {
      provider?: ethers.providers.Provider
      auroraErc20Abi?: string
    }
  }
): Promise<string> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getAuroraProvider()
  const erc20Abi = options.auroraErc20Abi ?? bridgeParams.auroraErc20Abi

  const balance = await erc20.getBalance({ erc20Address, owner, provider, erc20Abi })
  return balance
}
