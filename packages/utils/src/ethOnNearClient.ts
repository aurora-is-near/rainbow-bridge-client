import { providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class EthOnNearClientBorsh {
  constructor (args: any) {
    Object.assign(this, args)
  }
}

const schema = new Map([
  [EthOnNearClientBorsh, {
    kind: 'struct',
    fields: [
      ['last_block_number', 'u64']
    ]
  }]
])

function deserializeEthOnNearClient (raw: Buffer): any {
  return deserializeBorsh(schema, EthOnNearClientBorsh, raw)
}

export async function ethOnNearSyncHeight (
  nearClientAccount: string,
  nearProvider: najProviders.Provider
): Promise<number> {
  const result = await nearProvider.query<CodeResult>({
    request_type: 'call_function',
    account_id: nearClientAccount,
    method_name: 'last_block_number',
    args_base64: '',
    finality: 'optimistic'
  })
  const deserialized = deserializeEthOnNearClient(Buffer.from(result.result))
  return deserialized.last_block_number.toNumber()
}
