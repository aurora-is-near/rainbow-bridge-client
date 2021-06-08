import { ethers } from 'ethers'
import bs58 from 'bs58'
import { toBuffer } from 'ethereumjs-util'
import { getEthProvider, getNearAccount } from '@near-eth/client/dist/utils'

export default async function findProof (transfer, options) {
  options = options || {}
  const provider = options.ethProvider || getEthProvider()
  const nearAccount = options.nearAccount || await getNearAccount()

  const nearOnEthClient = new ethers.Contract(
    options.ethClientAddress || process.env.ethClientAddress,
    options.ethNearOnEthClientAbi || process.env.ethNearOnEthClientAbiText,
    provider
  )
  const clientBlockHashB58 = bs58.encode(toBuffer(
    await nearOnEthClient.blockHashes(transfer.nearOnEthClientBlockHeight)
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
