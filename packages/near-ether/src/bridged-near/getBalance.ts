import { ethers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'

export default async function getBalance (
  user: string,
  options?: {
    provider?: ethers.providers.Provider
    eNEARAddress?: string
    eNEARAbi?: string
  }
): Promise<string> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()

  const erc20Contract = new ethers.Contract(
    options.eNEARAddress ?? bridgeParams.eNEARAddress,
    options.eNEARAbi ?? bridgeParams.eNEARAbi,
    provider
  )

  return (await erc20Contract.balanceOf(user)).toString()
}
