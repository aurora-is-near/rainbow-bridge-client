import { ConnectedWalletAccount, WalletConnection } from 'near-api-js'
import { Decimal } from 'decimal.js'
import { ethers } from 'ethers'

let ethProvider: ethers.providers.JsonRpcProvider
let nearConnection: WalletConnection
let auroraProvider: ethers.providers.JsonRpcProvider
let signerProvider: ethers.providers.JsonRpcProvider | ethers.providers.Web3Provider
let bridgeParams: any

/**
 * Set ethProvider
 *
 * This must be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/nep141-erc20.
 *
 * Example:
 *
 *     import { ethers } from 'ethers'
 *     import { setEthProvider } from '@near-eth/client'
 *     setEthProvider(new ethers.providers.JsonRpcProvider(url))
 *
 * @param provider Ethereum Provider
 *
 * @returns `provider`
 */
export function setEthProvider (provider: ethers.providers.JsonRpcProvider): any {
  ethProvider = provider
  // TODO: verify provider meets expectations
  return ethProvider
}

/**
 * Set auroraProvider
 *
 * This must be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/nep141-erc20.
 *
 * Example:
 *
 *     import { ethers } from 'ethers'
 *     import { setAuroraProvider } from '@near-eth/client'
 *     setAuroraProvider(new ethers.providers.JsonRpcProvider(url))
 *
 * @param provider Aurora Provider
 *
 * @returns `provider`
 */
export function setAuroraProvider (provider: ethers.providers.JsonRpcProvider): any {
  auroraProvider = provider
  // TODO: verify provider meets expectations
  return auroraProvider
}

/**
 * Set signerProvider
 *
 * This must be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/nep141-erc20.
 *
 * Example:
 *
 *     import { ethers } from 'ethers'
 *     import { setSignerProvider } from '@near-eth/client'
 *     setSignerProvider(new ethers.providers.Web3Provider(window.ethereum, 'any'))
 *     // use 'any' to allow switching networks
 *
 * @param provider Signer Provider
 *
 * @returns `provider`
 */
export function setSignerProvider (provider: ethers.providers.JsonRpcProvider | ethers.providers.Web3Provider): any {
  signerProvider = provider
  // TODO: verify provider meets expectations
  return signerProvider
}

/**
 * Set nearConnection
 *
 * This must be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/nep141-erc20.
 *
 * Example:
 *
 *     import { Near, WalletConnection } from 'near-api-js'
 *     import { config, setNearConnection } from '@near-eth/client'
 *
 *     setNearConnection(new WalletConnection(
 *       new Near(config.ropsten.near)
 *     ))
 *
 * @param connection WalletConnection instance from near-api-js
 *
 * @returns `connection`
 */
export function setNearConnection (connection: WalletConnection): WalletConnection {
  nearConnection = connection
  // TODO: verify connection meets expectations
  return nearConnection
}

/**
 * Get ethProvider
 *
 * Internal function, only expected to be used by @near-eth/nep141-erc20 and
 * other connector libraries that interoperate with @near-eth/client. If you
 * are an app developer, you can ignore this function.
 *
 * @returns an Ethereum Provider for use with ethers.js
 */
export function getEthProvider (): ethers.providers.JsonRpcProvider {
  return ethProvider
}

export function getAuroraProvider (): ethers.providers.JsonRpcProvider {
  return auroraProvider
}

export function getSignerProvider (): ethers.providers.JsonRpcProvider {
  return signerProvider
}

/**
 * Get NEAR Account for the nearConnection set by `setNearConnection`
 *
 * Internal function, only expected to be used by @near-eth/nep141-erc20 and
 * other connector libraries that interoperate with @near-eth/client. If you
 * are an app developer, you can ignore this function.
 *
 * Ensures that app called `setNearConnection`
 *
 * If `authAgainst` supplied and user is not signed in, will redirect user to
 * NEAR Wallet to sign in against `authAgainst` contract.
 *
 * If provided `strict: true`, will ENSURE that user is signed in against
 * `authAgainst` contract, and not just any contract address.
 *
 * @param params Object with named arguments
 * @param params.authAgainst [undefined] string (optional) The address of a NEAR contract
 *   to authenticate against. If provided, will trigger a page redirect to NEAR
 *   Wallet if the user is not authenticated against ANY contract, whether this
 *   contract or not.
 * @param params.strict [false] boolean (optional) Will trigger a page redirect to NEAR
 *   Wallet if the user is not authenticated against the specific contract
 *   provided in `authAgainst`.
 *
 * @returns WalletAccount a NEAR account object, when it doesn't trigger a page redirect.
 */
export async function getNearAccount (
  { authAgainst, strict = false }: { authAgainst?: string, strict?: boolean } =
  { authAgainst: undefined, strict: false }
): Promise<ConnectedWalletAccount> {
  if (!nearConnection) {
    throw new Error(
      'Must `setNearConnection(new WalletConnection(near))` prior to calling anything from `@near-eth/client` or connector libraries'
    )
  }

  if (!authAgainst) return nearConnection.account()

  if (!nearConnection.getAccountId()) {
    await nearConnection.requestSignIn(authAgainst)
  }
  if (strict && !(await nearAuthedAgainst(authAgainst))) {
    nearConnection.signOut()
    await nearConnection.requestSignIn(authAgainst)
  }

  return nearConnection.account()
}

/**
 * Check that user is authenticated against the given `contract`.
 *
 * Put another way, make sure that current browser session has a FunctionCall
 * Access Key that allows it to call the given `contract` on behalf of the
 * current user.
 *
 * @param contract The address of a NEAR contract
 * @returns boolean True if the user is authenticated against this contract.
 */
export async function nearAuthedAgainst (contract: string): Promise<boolean> {
  if (!contract) {
    throw new Error(
      `nearAuthedAgainst expects a valid NEAR contract address.
      Got: \`${contract}\``
    )
  }

  if (!nearConnection.getAccountId()) return false

  const { accessKey } = await nearConnection.account().findAccessKey(contract, []) as any

  // TODO: this logic may break with FullAccess keys
  const authedAgainst = accessKey?.accessKey.permission.FunctionCall.receiver_id
  return authedAgainst === contract
}

export function formatLargeNum (n: string, decimals = 18): Decimal {
  // decimals defaults to 18 for old transfers in state that didn't record transfer.decimals
  if (!n) {
    return new Decimal(0)
  }
  return new Decimal(n).dividedBy(10 ** decimals)
}

/**
 * Get bridgeParams
 *
 * Internal function, only expected to be used by @near-eth/nep141-erc20 and
 * other connector libraries that interoperate with @near-eth/client. If you
 * are an app developer, you can ignore this function.
 *
 * @returns Bridge parameters
 */
export function getBridgeParams (): any {
  return bridgeParams
}

/**
 * Set bridge parameters (contract addresses, abi...)
 *
 * This should be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/nep141-erc20.
 * Otherwise connector libraries can also be used without bridgeParams by specifying the required
 * arguments in `options`.
 *
 * Example: bridge parameters for @near-eth/nep141-erc20
 *
 *  setBridgeParams({
 *    nearEventRelayerMargin: 10, // 10 blocks margin for the Event relayer to finalize the transfer
 *    sendToNearSyncInterval: 20000, // check light client sync every 20sec
 *    sendToEthereumSyncInterval: 60000, // check light client sync every 60sec
 *    ethChainId: 1, // mainnet
 *    erc20Abi: process.env.ethErc20AbiText, // Standard ERC-20 ABI
 *    erc20LockerAddress: '0x23ddd3e3692d1861ed57ede224608875809e127f',
 *    erc20LockerAbi: process.env.ethLockerAbiText,
 *    nep141Factory: 'factory.bridge.near',
 *    ethClientAddress: '0x0151568af92125fb289f1dd81d9d8f7484efc362',
 *    ethClientAbi: process.env.ethNearOnEthClientAbiText,
 *    nearClientAccount: 'client.bridge.near'
 *  })
 *
 * @param params Object containing bridge parameters
 * @returns `params`
 */
export function setBridgeParams (params: any): any {
  bridgeParams = params
  return bridgeParams
}
