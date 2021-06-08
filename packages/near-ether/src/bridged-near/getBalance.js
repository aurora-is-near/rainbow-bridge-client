import { ethers } from 'ethers'
import { getEthProvider } from '@near-eth/client/dist/utils'

export default async function getBalance (user) {
  if (!user) return null

  const provider = getEthProvider()

  const erc20Contract = new ethers.Contract(
    process.env.eNEARAddress,
    process.env.eNEARAbiText,
    provider
  )

  return (await erc20Contract.balanceOf(user)).toString()
}
