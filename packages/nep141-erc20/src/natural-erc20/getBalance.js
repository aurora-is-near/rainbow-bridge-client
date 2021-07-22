import { ethers } from 'ethers'
import { getEthProvider } from '@near-eth/client/dist/utils'

export default async function getBalance (address, user) {
  if (!user) return null

  const provider = getEthProvider()

  const contract = new ethers.Contract(
    address,
    process.env.ethErc20AbiText,
    provider
  )

  return await contract.balanceOf(user)
}
