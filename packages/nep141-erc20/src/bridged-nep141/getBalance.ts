import { getNearAccount } from '@near-eth/client/dist/utils'
import { ConnectedWalletAccount } from 'near-api-js'
import getNep141Address from './getAddress'

/**
 * Given an erc20 contract address, get the balance of user's equivalent NEP141.
 *
 * @param {object} params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address Contract address of an ERC20 token on Ethereum
 * @param params.user NEAR account address
 *
 * @returns {Promise<number|null>} if BridgeToken has been deployed, returns balance for `params.user`.
 *   Otherwise, returns `null`.
 */
export default async function getBalance (
  { erc20Address, owner, options }: {
    erc20Address: string
    owner: string
    options?: {
      nearAccount?: ConnectedWalletAccount
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
    return null
  }
}
