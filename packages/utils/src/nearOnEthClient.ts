import { ethers } from 'ethers'

export async function nearOnEthSyncHeight (provider: ethers.providers.Provider): Promise<number> {
  const nearOnEthClient = new ethers.Contract(
    process.env.ethClientAddress!,
    process.env.ethNearOnEthClientAbiText!,
    provider
  )
  const { currentHeight } = await nearOnEthClient.bridgeState()
  return Number(currentHeight)
}
