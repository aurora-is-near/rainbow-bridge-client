import {
  ConnectedWalletAccount,
  WalletConnection,
  providers as najProviders
} from 'near-api-js'
import { Decimal } from 'decimal.js'
import { providers as ethersProviders } from 'ethers'

let ethProvider: ethersProviders.JsonRpcProvider
let nearConnection: WalletConnection
let auroraProvider: ethersProviders.JsonRpcProvider
type AuroraEvmAccount = string
interface AuroraCloudProviders { [key: AuroraEvmAccount]: ethersProviders.JsonRpcProvider }
let auroraCloudProviders: AuroraCloudProviders
let signerProvider: ethersProviders.JsonRpcProvider | ethersProviders.Web3Provider
let nearProvider: najProviders.Provider
let nearWallet: NearWalletBehaviour
let bridgeParams: any

interface NearWalletBehaviour {
  type: string
  getAccounts: () => Promise<Array<{ accountId: string }>>
  signAndSendTransaction: ({
    receiverId,
    actions
  }: {
    receiverId: string
    actions: any[]
  }) => Promise<any>
}

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
export function setEthProvider (
  provider: ethersProviders.JsonRpcProvider
): ethersProviders.JsonRpcProvider {
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
export function setAuroraProvider (
  provider: ethersProviders.JsonRpcProvider
): ethersProviders.JsonRpcProvider {
  auroraProvider = provider
  // TODO: verify provider meets expectations
  return auroraProvider
}

/**
 * Set cloudProviders
 *
 * This must be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/aurora-erc20.
 *
 * Example:
 *
 *     import { ethers } from 'ethers'
 *     import { setAuroraCloudProviders } from '@near-eth/client'
 *     setAuroraCloudProviders({ "example-silo.near": new ethers.providers.JsonRpcProvider(url) })
 *
 * @param cloudProviders Object of Aurora evm engine accounts to their respective provider.
 *
 * @returns `auroraCloudProviders`
 */
export function setAuroraCloudProviders (
  cloudProviders: AuroraCloudProviders
): AuroraCloudProviders {
  auroraCloudProviders = cloudProviders
  return auroraCloudProviders
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
export function setSignerProvider (
  provider: ethersProviders.JsonRpcProvider | ethersProviders.Web3Provider
): ethersProviders.JsonRpcProvider | ethersProviders.Web3Provider {
  signerProvider = provider
  // TODO: verify provider meets expectations
  return signerProvider
}

/**
 * Set nearProvider
 *
 * This must be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/nep141-erc20.
 *
 * Example:
 *
 *     import { providers } from 'near-api-js'
 *     import { setNearProvider } from '@near-eth/client'
 *     setNearProvider(new providers.JsonRpcProvider({ url }))
 *
 * @param provider Near Provider
 *
 * @returns `provider`
 */
export function setNearProvider (
  provider: najProviders.Provider
): najProviders.Provider {
  nearProvider = provider
  // TODO: verify provider meets expectations
  return nearProvider
}

/**
 * Set wallet-selector NEAR wallet
 *
 * This must be called by apps that use @near-eth/client before performing any
 * transfer operations with @near-eth/client itself or with connector libraries
 * such as @near-eth/nep141-erc20.
 *
 * Example:
 *
 *     import { setNearWallet } from '@near-eth/client'
 *     import { setupWalletSelector } from "@near-wallet-selector/core"
 *     import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet"
 *     import { setupSender } from "@near-wallet-selector/sender"
 *
 *     const selector = await setupWalletSelector({
 *       network: "testnet",
 *       debug: true,
 *       modules: [setupMyNearWallet(), setupSender()]
 *     })
 *     setNearWallet(await selector.wallet())
 *
 * @param wallet Near Wallet signer
 *
 * @returns `wallet`
 */
export function setNearWallet (wallet: NearWalletBehaviour): NearWalletBehaviour {
  nearWallet = wallet
  // TODO: verify provider meets expectations
  return nearWallet
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
export function getEthProvider (): ethersProviders.JsonRpcProvider {
  return ethProvider
}

export function getAuroraProvider (): ethersProviders.JsonRpcProvider {
  return auroraProvider
}

export function getAuroraCloudProvider (
  { auroraEvmAccount }: { auroraEvmAccount?: AuroraEvmAccount }
): ethersProviders.JsonRpcProvider {
  if (!auroraEvmAccount || auroraEvmAccount === 'aurora') return getAuroraProvider()
  const cloudProvider = auroraCloudProviders[auroraEvmAccount]
  if (!cloudProvider) {
    throw new Error(
      'Must `setAuroraCloudProviders({ "example-silo.near": new ethers.providers.JsonRpcProvider(url) })` prior to calling getAuroraCloudProvider'
    )
  }
  return cloudProvider
}

export function getSignerProvider (): ethersProviders.JsonRpcProvider {
  return signerProvider
}

export function getNearProvider (): najProviders.Provider {
  if (nearProvider) return nearProvider
  else return (getNearAccount()).connection.provider
}

export function getNearWallet (): NearWalletBehaviour | ConnectedWalletAccount {
  if (nearWallet) return nearWallet
  // Backward compatibility
  else return getNearAccount()
}

export async function getNearAccountId (): Promise<string> {
  if (nearWallet) return (await nearWallet.getAccounts())[0]!.accountId
  // Backward compatibility
  else return (getNearAccount().accountId)
}

/**
 * Get NEAR Account for the nearConnection set by `setNearConnection`
 *
 * Internal function, only expected to be used by @near-eth/nep141-erc20 and
 * other connector libraries that interoperate with @near-eth/client. If you
 * are an app developer, you can ignore this function.
 * Ensures that app called `setNearConnection`
 *
 * @returns WalletAccount a NEAR account object, when it doesn't trigger a page redirect.
 */
export function getNearAccount (): ConnectedWalletAccount {
  if (!nearConnection) {
    throw new Error(
      'Must `setNearConnection(new WalletConnection(near))` prior to calling anything from `@near-eth/client` or connector libraries'
    )
  }
  return nearConnection.account()
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
