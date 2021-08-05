import { Account } from 'near-api-js'
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
  nearAccount: Account
): Promise<number> {
  // near-api-js requires instantiating an "account" object, even though view
  // functions require no signature and therefore no associated account, so the
  // account name passed in doesn't matter.
  const deserialized = await nearAccount.viewFunction(
    nearClientAccount,
    'last_block_number',
    {},
    { parse: deserializeEthOnNearClient }
  )
  return deserialized.last_block_number.toNumber()
}
