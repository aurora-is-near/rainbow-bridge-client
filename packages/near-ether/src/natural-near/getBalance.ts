import { getNearAccount } from '@near-eth/client/dist/utils'

export default async function getBalance (): Promise<string> {
  const nearAccount = await getNearAccount()
  const { available: nearBalance } = await nearAccount.getAccountBalance()
  return nearBalance
}
