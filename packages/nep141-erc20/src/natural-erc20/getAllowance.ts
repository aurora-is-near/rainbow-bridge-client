import { ethers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'

/**
 * Returns the amount of erc20Address tokens which spender is allowed to withdraw from owner.
 * @param {*} param.erc20Address
 * @param {*} param.owner
 * @param {*} param.spender
 */
export default async function getAllowance (
  { erc20Address, owner, spender, options }: {
    erc20Address: string
    owner: string
    spender: string
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

  return (await erc20Contract.allowance(owner, spender)).toString()
}
