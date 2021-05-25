import Web3 from 'web3'

export async function nearOnEthSyncHeight (provider: any): Promise<number> {
  const web3 = new Web3(provider)
  const nearOnEthClient = new web3.eth.Contract(
    JSON.parse(process.env.ethNearOnEthClientAbiText!),
    process.env.ethClientAddress
  )
  const { currentHeight } = await nearOnEthClient.methods.bridgeState().call()
  return Number(currentHeight)
}
