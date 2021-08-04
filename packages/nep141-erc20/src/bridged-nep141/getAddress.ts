import { getBridgeParams } from '@near-eth/client/dist/utils'

/**
 * Given an erc20 contract address, get the NEAR contract address of the
 * corresponding BridgeToken contract.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address Contract address of an ERC20 token on Ethereum
 * @param params.options Optional arguments.
 * @param params.options.nep141Factory Bridge token factory account on NEAR.
 * @returns string Contract address of NEP141 BridgeToken on NEAR
 */
export default function getNep141Address (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      nep141Factory?: string
    }
  }
): string {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nep141Factory: string = options.nep141Factory ?? bridgeParams.nep141Factory
  return erc20Address.replace('0x', '').toLowerCase() + '.' + nep141Factory
}
