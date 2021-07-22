import { ethers } from 'ethers'
import { getEthProvider } from '@near-eth/client/dist/utils'

/**
 * Returns the amount of erc20Address tokens which spender is allowed to withdraw from owner.
 * @param {*} param.erc20Address
 * @param {*} param.owner
 * @param {*} param.spender
 */
export default async function getAllowance ({ erc20Address, owner, spender }) {
  if (!owner || !spender) return null

  const provider = getEthProvider()

  const erc20Contract = new ethers.Contract(
    erc20Address,
    process.env.ethErc20AbiText,
    provider
  )

  return (await erc20Contract.allowance(owner, spender)).toString()
}
