import Web3 from 'web3'
import { getEthProvider } from '@near-eth/client/dist/utils'

const erc20Names = {}
export default async function getName (address) {
  if (erc20Names[address]) return erc20Names[address]

  const web3 = new Web3(getEthProvider())

  const contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    address
  )

  erc20Names[address] = await contract.methods.symbol().call()
    .catch(() => address.slice(0, 5) + '…')

  return erc20Names[address]
}
