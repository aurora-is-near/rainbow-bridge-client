import Web3 from 'web3'
import { getEthProvider } from '@near-eth/client/dist/utils'

/**
 * Returns the amount of erc20Address tokens which spender is allowed to withdraw from owner.
 * @param {*} param.erc20Address
 * @param {*} param.owner
 * @param {*} param.spender
 */
export default async function getAllowance ({ erc20Address, owner, spender }) {
  console.log(erc20Address, owner, spender)
  if (!owner || !spender) return null

  const web3 = new Web3(getEthProvider())

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    erc20Address
  )

  return await erc20Contract.methods.allowance(owner, spender).call()
}
