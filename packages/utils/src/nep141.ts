import { Account } from 'near-api-js'

export async function getMetadata (
  { nep141Address, nearAccount }: {
    nep141Address: string
    nearAccount: Account
  }
): Promise<{symbol: string, decimals: number, icon: string}> {
  const metadata = await nearAccount.viewFunction(
    nep141Address,
    'ft_metadata'
  )
  return metadata
}

export async function getBalance (
  { nep141Address, owner, nearAccount }: {
    nep141Address: string
    owner: string
    nearAccount: Account
  }
): Promise<string> {
  const balanceAsString = await nearAccount.viewFunction(
    nep141Address,
    'ft_balance_of',
    { account_id: owner }
  )
  return balanceAsString
}
