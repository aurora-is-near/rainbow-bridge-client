import { getNearAccount } from '@near-eth/client/dist/utils'
import { Account } from 'near-api-js'
import { nep141 } from '@near-eth/utils'

/**
 * Given an NEP-141 contract address, get the owner's balance.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.nep141Address Contract address of an NEP-141 token on NEAR
 * @param params.owner NEAR account address
 * @param params.options Optional arguments.
 * @param params.options.nearAccount Connected NEAR wallet account to use.
 *
 * @returns Balance as string
 */
export default async function getBalance (
  { nep141Address, owner, options }: {
    nep141Address: string
    owner: string
    options?: {
      nearAccount?: Account
    }
  }
): Promise<string> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const balanceAsString = await nep141.getBalance({ nep141Address, owner, nearAccount })
  return balanceAsString
}
