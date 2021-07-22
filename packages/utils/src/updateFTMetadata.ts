import { ethers } from 'ethers'
import { getMetadata } from '@near-eth/nep141-erc20/dist/natural-erc20'
import { getNep141Address } from '@near-eth/nep141-erc20/dist/bridged-nep141'
import { getNearAccount, getAuroraProvider } from '@near-eth/client/dist/utils'

export async function updateFungibleTokenMetadata (address: any): Promise<any> {
  // Read metadata from Eth ERC-20
  const [decimals, name, symbol] = await getMetadata(address)
  // Push metadata to the NEP-141
  const nep141Address = getNep141Address(address)
  const nearAccount = await getNearAccount()
  await nearAccount.functionCall(
    nep141Address,
    'set_metadata',
    {
      name: name,
      symbol: symbol,
      decimals: decimals
    }
  )
  // Push metadata to Aurora ERC-20
  const provider = getAuroraProvider()
  const contract = new ethers.Contract(
    address,
    process.env.ethErc20AbiText,
    provider
  )
  // The full storage layout can be found here https://github.com/aurora-is-near/aurora-engine/pull/178
  await contract.adminSstore(0x7, name, { from: process.env.ADMIN_ACCOUNT })
  await contract.adminSstore(0x8, symbol, { from: process.env.ADMIN_ACCOUNT })
  await contract.adminSstore(0x9, decimals, { from: process.env.ADMIN_ACCOUNT })
}
