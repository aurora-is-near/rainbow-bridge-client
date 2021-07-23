import { ethers } from 'ethers'

export async function nearOnEthSyncHeight (
  provider: ethers.providers.Provider,
  ethClientAddress: string,
  ethClientAbi: string
): Promise<number> {
  const nearOnEthClient = new ethers.Contract(
    ethClientAddress,
    ethClientAbi,
    provider
  )
  const { currentHeight } = await nearOnEthClient.bridgeState()
  return Number(currentHeight)
}
