import { getBridgeParams, getNearAccount } from '@near-eth/client/dist/utils'
import { Account } from 'near-api-js'
import { aurora } from '@near-eth/utils'

const auroraErc20Addresses: {[key: string]: string} = {}
const nep141Addresses: {[key: string]: string} = {}

/**
 * Given an nep141 contract address, get the Aurora erc20 contract address of the
 * corresponding BridgeToken contract.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.nep141Address Contract address of an NEP-141 token on NEAR
 * @param params.options Optional arguments.
 * @returns string Contract address of ERC-20 BridgeToken on Aurora
 */
export async function getAuroraErc20Address (
  { nep141Address, options }: {
    nep141Address: string
    options?: {
      nearAccount?: Account
      auroraEvmAccount?: string
    }
  }
): Promise<string | null> {
  if (auroraErc20Addresses[nep141Address]) return auroraErc20Addresses[nep141Address]!
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const bridgeParams = getBridgeParams()
  const auroraEvmAccount: string = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  try {
    const address = await aurora.getErc20FromNep141({ nep141Address, nearAccount, auroraEvmAccount })
    auroraErc20Addresses[nep141Address] = address
  } catch (error) {
    console.warn(error, nep141Address)
    return null
  }
  return auroraErc20Addresses[nep141Address]!
}

/**
 * Given a bridged ERC-20 contract address, get the original NEP-141 contract address.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.auroraErc20Address Contract address of a bridged ERC-20 token on Aurora
 * @param params.options Optional arguments.
 * @returns string Contract address of NEP-141 token on NEAR
 */
export async function getNep141Address (
  { auroraErc20Address, options }: {
    auroraErc20Address: string
    options?: {
      nearAccount?: Account
      auroraEvmAccount?: string
    }
  }
): Promise<string | null> {
  if (nep141Addresses[auroraErc20Address]) return nep141Addresses[auroraErc20Address]!
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const bridgeParams = getBridgeParams()
  const auroraEvmAccount: string = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  try {
    const address = await aurora.getNep141FromErc20({ auroraErc20Address, nearAccount, auroraEvmAccount })
    nep141Addresses[auroraErc20Address] = address
  } catch (error) {
    console.error(error, auroraErc20Address)
    return null
  }
  return nep141Addresses[auroraErc20Address]!
}
