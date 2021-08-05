import { getBridgeParams, getNearAccount } from '@near-eth/client/dist/utils'
import { ConnectedWalletAccount } from 'near-api-js'

/**
 * Given an erc20 contract address, get the NEAR contract address of the
 * corresponding BridgeToken contract.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address Contract address of an ERC20 token on Ethereum
 * @param params.options Optional arguments.
 * @param params.options.nep141Factory Bridge token factory account on NEAR.
 * @returns string Contract address of ERC-20 BridgeToken on Aurora
 */
export default async function getAuroraErc20Address (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      nep141Factory?: string
      nearAccount?: ConnectedWalletAccount
    }
  }
): Promise<string> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const bridgeParams = getBridgeParams()
  const nep141Factory: string = options.nep141Factory ?? bridgeParams.nep141Factory
  const nep141Address = erc20Address.replace('0x', '').toLowerCase() + '.' + nep141Factory
  const address = await nearAccount.connection.provider.query({
    request_type: 'call_function',
    finality: 'final',
    account_id: 'aurora',
    method_name: 'get_erc20_from_nep141',
    args_base64: Buffer.from(nep141Address).toString('base64')
  })
  // @ts-expect-error TODO
  return Buffer.from(address.result).toString('hex')
}
