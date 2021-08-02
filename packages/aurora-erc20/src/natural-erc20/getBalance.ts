import { ethers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { erc20 } from '@near-eth/utils'

export default async function getBalance (
  { erc20Address, owner, options }: {
    erc20Address: string
    owner: string
    options?: {
      provider?: ethers.providers.JsonRpcProvider
      erc20Abi?: string
    }
  }
): Promise<string> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const erc20Abi = options.erc20Abi ?? bridgeParams.erc20Abi

  const balance = await erc20.getBalance({ erc20Address, owner, provider, erc20Abi })
  return balance
}
