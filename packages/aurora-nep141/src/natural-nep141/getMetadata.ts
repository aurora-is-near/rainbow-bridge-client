import { Account, providers as najProviders } from 'near-api-js'
import { nep141 } from '@near-eth/utils'
import { getNearProvider } from '@near-eth/client/dist/utils'

const tokenMetadata: {[key: string]: {symbol: string, decimals: number, name: string, icon: string}} = {}

export default async function getMetadata (
  { nep141Address, options }: {
    nep141Address: string
    options?: {
      nearAccount?: Account
      nearProvider?: najProviders.Provider
    }
  }
): Promise<{symbol: string, decimals: number, name: string, icon: string}> {
  options = options ?? {}
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()
  if (tokenMetadata[nep141Address]) return tokenMetadata[nep141Address]!

  const metadata = await nep141.getMetadata({ nep141Address, nearProvider })
  tokenMetadata[nep141Address] = metadata
  return metadata
}
