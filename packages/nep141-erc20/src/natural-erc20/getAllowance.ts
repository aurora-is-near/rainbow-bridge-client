import { ethers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'
import { erc20 } from '@near-eth/utils'

/**
 * Returns the amount of erc20Address tokens which spender is allowed to withdraw from owner.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address ERC-20 token address
 * @param params.owner Owner's address
 * @param params.spender Spender's address
 * @param params.options Optional arguments.
 * @param options.provider Ethereum provider to use.
 * @param params.options.erc20Abi ERC-20 token abi.
 *
 * @returns Allowance of spender
 */
export default async function getAllowance (
  { erc20Address, owner, spender, options }: {
    erc20Address: string
    owner: string
    spender: string
    options?: {
      provider?: ethers.providers.Provider
      erc20Abi?: string
    }
  }
): Promise<string> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const provider = options.provider ?? getEthProvider()
  const erc20Abi = options.erc20Abi ?? bridgeParams.erc20Abi

  const allowance = await erc20.getAllowance({ erc20Address, owner, spender, provider, erc20Abi })
  return allowance
}
