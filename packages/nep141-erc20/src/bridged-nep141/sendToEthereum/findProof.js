import Web3 from 'web3'
import bs58 from 'bs58'
import { toBuffer } from 'ethereumjs-util'
import { getEthProvider, getNearAccount } from '@near-eth/client/dist/utils'

export default async function findProof (transfer) {
  const web3 = new Web3(getEthProvider())
  const nearAccount = await getNearAccount()

  const nearOnEthClient = new web3.eth.Contract(
    JSON.parse(process.env.ethNearOnEthClientAbiText),
    process.env.ethClientAddress
  )
  const clientBlockHashB58 = bs58.encode(toBuffer(
    await nearOnEthClient.methods
      .blockHashes(transfer.nearOnEthClientBlockHeight).call()
  ))
  const withdrawReceiptId = last(transfer.withdrawReceiptIds)
  return await nearAccount.connection.provider.sendJsonRpc(
    'light_client_proof',
    {
      type: 'receipt',
      receipt_id: withdrawReceiptId,
      receiver_id: transfer.sender,
      light_client_head: clientBlockHashB58
    }
  )
}

const last = arr => arr[arr.length - 1]
