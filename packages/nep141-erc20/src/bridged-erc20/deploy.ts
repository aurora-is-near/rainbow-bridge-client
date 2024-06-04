import { Account, providers as najProviders } from 'near-api-js'
import { FinalExecutionOutcome } from 'near-api-js/lib/providers'
import {
  getNearWallet,
  getNearProvider,
  getSignerProvider,
  getBridgeParams
} from '@near-eth/client/dist/utils'
import { providers, Signer, Contract } from 'ethers'
import {
  borshifyOutcomeProof,
  nearOnEthSyncHeight,
  findNearProof
} from '@near-eth/utils'

export async function logNep141Metadata (
  { nep141Address, options }: {
    nep141Address: string
    options?: {
      nearAccount?: Account
      nep141LockerAccount?: string
    }
  }
): Promise<FinalExecutionOutcome> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nep141LockerAccount: string = options.nep141LockerAccount ?? bridgeParams.nep141LockerAccount
  const nearWallet = options.nearAccount ?? getNearWallet()
  const isNajAccount = nearWallet instanceof Account

  let tx: FinalExecutionOutcome
  if (isNajAccount) {
    tx = await nearWallet.functionCall({
      contractId: nep141LockerAccount,
      methodName: 'log_metadata',
      args: { token_id: nep141Address },
      gas: '100' + '0'.repeat(12)
    })
  } else {
    tx = await nearWallet.signAndSendTransaction({
      receiverId: nep141LockerAccount,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'log_metadata',
            args: { token_id: nep141Address },
            gas: '100' + '0'.repeat(12)
          }
        }
      ]
    })
  }
  return tx
}

export async function deploy (
  { nep141MetadataLogTx, options }: {
    nep141MetadataLogTx: string
    options?: {
      erc20FactoryAddress?: string
      nep141LockerAccount?: string
      erc20FactoryAbi?: string
      signer?: Signer
      provider?: providers.JsonRpcProvider
      ethChainId?: number
      nearProvider?: najProviders.Provider
    }
  }
): Promise<providers.TransactionResponse> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const erc20FactoryAddress: string = options.erc20FactoryAddress ?? bridgeParams.erc20FactoryAddress
  const nep141LockerAccount: string = options.nep141LockerAccount ?? bridgeParams.nep141LockerAccount
  const provider = options.provider ?? getSignerProvider()
  const ethChainId: number = (await provider.getNetwork()).chainId
  const expectedChainId: number = options.ethChainId ?? bridgeParams.ethChainId
  if (ethChainId !== expectedChainId) {
    throw new Error(
      `Wrong network for deploying token, expected: ${expectedChainId}, got: ${ethChainId}`
    )
  }
  const nearProvider = getNearProvider()
  const logTx = await nearProvider.txStatus(nep141MetadataLogTx, process.env.nep141LockerAccount!)
  const logReceipt = logTx.receipts_outcome[3]
  if (!logReceipt) {
    console.log(logReceipt)
    throw new Error('Failed to parse NEP-141 log metadata receipt.')
  }
  // @ts-expect-error
  const receiptBlock = await nearProvider.block({ blockId: logReceipt.block_hash })
  const logBlockHeight = Number(receiptBlock.header.height)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(
    provider,
    process.env.ethClientAddress!,
    process.env.ethNearOnEthClientAbiText!
  )
  if (logBlockHeight > nearOnEthClientBlockHeight) {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw new Error(`Wait for the light client sync: NEP-141 metadata log block height: ${logBlockHeight}, light client block height: ${nearOnEthClientBlockHeight}`)
  }
  const proof = await findNearProof(
    logReceipt.id,
    nep141LockerAccount,
    nearOnEthClientBlockHeight,
    nearProvider,
    provider,
    process.env.ethClientAddress!,
    process.env.ethNearOnEthClientAbiText!
  )
  const borshProof = borshifyOutcomeProof(proof)
  const erc20Factory = new Contract(
    erc20FactoryAddress,
    options.erc20FactoryAbi ?? bridgeParams.erc20FactoryAbi,
    provider.getSigner()
  )
  const tx = await erc20Factory.newBridgeToken(borshProof, nearOnEthClientBlockHeight)
  return tx
}
