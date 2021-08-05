import { getNearAccount } from '@near-eth/client/dist/utils'
import { Account } from 'near-api-js'
import getNep141Address from './getAddress'

/**
 * Given an erc20 contract address, get the balance of user's equivalent NEP141.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address Contract address of an ERC20 token on Ethereum
 * @param params.owner NEAR account address
 * @param params.options Optional arguments.
 * @param params.options.nearAccount Connected NEAR wallet account to use.
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
    }
  }
): Promise<string | null> {
  options = options ?? {}
  const nep141Address = getNep141Address({ erc20Address })

  const nearAccount = options.nearAccount ?? await getNearAccount()

  try {
    const balanceAsString = await nearAccount.viewFunction(
      nep141Address,
      'ft_balance_of',
      { account_id: owner }
    )
    return balanceAsString
  } catch (e) {
    console.warn(e)
    if (e.message.includes('does not exist while viewing')) {
      return null
    }
    throw e
  }
}
