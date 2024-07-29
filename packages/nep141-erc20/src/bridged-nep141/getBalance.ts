import { getNearProvider } from '@near-eth/client/dist/utils'
import { Account, providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'
import getNep141Address from './getAddress'

/**
 * Given an erc20 contract address, get the balance of user's equivalent NEP141.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address Contract address of an ERC20 token on Ethereum
 * @param params.owner NEAR account address
 * @param params.options Optional arguments.
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 * @param params.options.nearProvider NEAR provider.
 *
 * @returns If BridgeToken has been deployed, returns balance for `params.user`.
 *   Otherwise, returns `null`.
 */
export default async function getBalance (
  { erc20Address, owner, options }: {
    erc20Address: string
    owner: string
    options?: {
      nearAccount?: Account
      nearProvider?: najProviders.Provider
    }
  }
): Promise<string | null> {
  options = options ?? {}
  const nep141Address = getNep141Address({ erc20Address })

  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()

  try {
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      account_id: nep141Address,
      method_name: 'ft_balance_of',
      args_base64: Buffer.from(JSON.stringify({ account_id: owner })).toString('base64'),
      finality: 'optimistic'
    })
    return JSON.parse(Buffer.from(result.result).toString())
  } catch (e) {
    console.warn(e)
    if (e.message?.includes('does not exist while viewing')) {
      return null
    }
    throw e
  }
}
