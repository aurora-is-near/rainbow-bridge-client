import { Account } from 'near-api-js'
import { nep141 } from '@near-eth/utils'
import { getNearAccount } from '@near-eth/client/dist/utils'

const tokenMetadata: {[key: string]: {symbol: string, decimals: number}} = {}

export default async function getMetadata (
  { nep141Address, options }: {
    nep141Address: string
    options?: {
      nearAccount?: Account
    }
  }
): Promise<{symbol: string, decimals: number}> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  if (tokenMetadata[nep141Address]) return tokenMetadata[nep141Address]!

  const metadata = await nep141.getMetadata({ nep141Address, nearAccount })
  tokenMetadata[nep141Address] = metadata
  return metadata
}
