import { Contract, providers } from 'ethers'
import { getEthProvider, getBridgeParams } from '@near-eth/client/dist/utils'

/**
 * Given a bridged ERC-20 contract address, get the NEAR native NEP-141.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address Contract address of an ERC20 token on Ethereum
 * @param params.options Optional arguments.
 * @param params.options.erc20FactoryAddress Bridge token factory account on Ethereum.
 * @param params.options.erc20FactoryAbi Bridge token factory abi on Ethereum.
 * @param params.options.provider Ethereum provider.
 * @returns string Contract address of NEP-141 token bridged from NEAR
 */
export default async function getNep141Address (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      erc20FactoryAddress?: string
      erc20FactoryAbi?: string
      provider?: providers.Provider
    }
  }
): Promise<string> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const erc20Factory = new Contract(
    options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress,
    options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
    options.provider ?? getEthProvider()
  )
  const nep141Address = await erc20Factory.ethToNearToken(erc20Address)
  return nep141Address
}
