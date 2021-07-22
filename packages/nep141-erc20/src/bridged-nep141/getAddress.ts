import { getBridgeParams } from '@near-eth/client/dist/utils'

/**
 * Given an erc20 contract address, get the NEAR contract address of the
 * corresponding BridgeToken contract.
 *
 * @param erc20Address Contract address of an ERC20 token on Ethereum
 * @returns string Contract address of NEP141 BridgeToken on Near
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
