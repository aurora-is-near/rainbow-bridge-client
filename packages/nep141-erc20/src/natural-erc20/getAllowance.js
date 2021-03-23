import Web3 from 'web3'
import { getEthProvider } from '@near-eth/client/dist/utils'

export default async function getAllowance (address, user, spender) {
  if (!user || !spender) return null

  const web3 = new Web3(getEthProvider())

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    address
  )

  return await erc20Contract.methods.allowance(user, spender).call()
}
