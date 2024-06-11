import { Account, providers as najProviders } from 'near-api-js'
import { FinalExecutionOutcome } from 'near-api-js/lib/providers'
import { deserialize as deserializeBorsh } from 'near-api-js/lib/utils/serialize'
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
      ethClientAddress?: string
      ethClientAbi?: string
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
  const nearProvider = options.nearProvider ?? getNearProvider()
  const logTx = await nearProvider.txStatus(nep141MetadataLogTx, nep141LockerAccount)
  let logReceipt: any
  logTx.receipts_outcome.some((receipt) => {
    // @ts-expect-error
    if (receipt.outcome.executor_id !== nep141LockerAccount) return false
    try {
      // @ts-expect-error
      const successValue = receipt.outcome.status.SuccessValue
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      class LogEvent {
        constructor (args: any) {
          Object.assign(this, args)
        }
      }
      const SCHEMA = new Map([
        [LogEvent, {
          kind: 'struct',
          fields: [
            ['prefix', [32]],
            ['token', 'String'],
            ['name', 'String'],
            ['symbol', 'String'],
            ['decimals', 'u8'],
            ['block_height', 'u64']
          ]
        }]
      ])
      deserializeBorsh(
        SCHEMA, LogEvent, Buffer.from(successValue, 'base64')
      )
      logReceipt = receipt
      return true
    } catch (error) {
      console.log(error)
    }
    return false
  })
  if (!logReceipt) {
    console.log(logReceipt)
    throw new Error('Failed to parse NEP-141 log metadata receipt.')
  }
  const receiptBlock = await nearProvider.block({ blockId: logReceipt.block_hash })
  const logBlockHeight = Number(receiptBlock.header.height)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(
    provider,
    options.ethClientAddress ?? bridgeParams.ethClientAddress,
    options.ethClientAbi ?? bridgeParams.ethClientAbi
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
    options.ethClientAddress ?? bridgeParams.ethClientAddress,
    options.ethClientAbi ?? bridgeParams.ethClientAbi
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
