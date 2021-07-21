import { ethers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'

export default async function getBalance (
  { erc20Address, owner, options }: {
    erc20Address: string
    owner: string
    options?: {
      provider?: ethers.providers.Web3Provider
      erc20Abi?: string
    }
  }
): Promise<string> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const erc20Contract = new ethers.Contract(
    erc20Address,
    options.erc20Abi ?? bridgeParams.erc20Abi,
    provider
  )

  return (await erc20Contract.balanceOf(owner)).toString()
}
