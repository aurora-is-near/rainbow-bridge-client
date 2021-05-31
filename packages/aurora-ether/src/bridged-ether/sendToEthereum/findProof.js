import Web3 from 'web3'
import bs58 from 'bs58'
import { toBuffer } from 'ethereumjs-util'
import { getEthProvider, getNearAccount } from '@near-eth/client/dist/utils'

export default async function findProof (transfer, options) {
  options = options || {}
  const ethProvider = options.ethProvider || getEthProvider()
  const web3 = new Web3(ethProvider)
  const nearAccount = options.nearAccount || await getNearAccount()

  const nearOnEthClient = new web3.eth.Contract(
    options.ethNearOnEthClientAbi || JSON.parse(process.env.ethNearOnEthClientAbiText),
    options.ethClientAddress || process.env.ethClientAddress
  )
  const clientBlockHashB58 = bs58.encode(toBuffer(
    await nearOnEthClient.methods
      .blockHashes(transfer.nearOnEthClientBlockHeight).call()
  ))
  const burnReceiptId = last(transfer.nearBurnReceiptIds)
  return await nearAccount.connection.provider.sendJsonRpc(
    'light_client_proof',
    {
      type: 'receipt',
      receipt_id: burnReceiptId,
      receiver_id: transfer.sender,
      light_client_head: clientBlockHashB58
    }
  )
}

const last = arr => arr[arr.length - 1]
