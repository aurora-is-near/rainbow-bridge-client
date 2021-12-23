import BN from 'bn.js'
import { FinalExecutionOutcome } from 'near-api-js/lib/providers'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'
import { Account } from 'near-api-js'
import { getNearAccount } from '@near-eth/client/dist/utils'
import { getBridgeParams } from '@near-eth/client'
import { urlParams } from '@near-eth/utils'

export default async function deployToAurora (
  { nep141Address, options }: {
    nep141Address: string
    options?: {
      nearAccount?: Account
      auroraEvmAccount?: string
    }
  }
): Promise<FinalExecutionOutcome> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class BorshArg {
    constructor (proof: any) {
      Object.assign(this, proof)
    }
  }

  const borshArgSchema = new Map([
    [BorshArg, {
      kind: 'struct',
      fields: [
        ['nep141', ['u8']]
      ]
    }]
  ])
  const borshArg = new BorshArg({
    nep141: Buffer.from(nep141Address)
  })

  const arg = serializeBorsh(borshArgSchema, borshArg)

  urlParams.set({ bridging: nep141Address })
  const tx = await nearAccount.functionCall({
    contractId: options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount,
    methodName: 'deploy_erc20_token',
    args: arg,
    gas: new BN('100' + '0'.repeat(12))
  })
  return tx
}
