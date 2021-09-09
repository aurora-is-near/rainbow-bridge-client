import { Account } from 'near-api-js'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'

export async function getErc20FromNep141 (
  { nep141Address, nearAccount, auroraEvmAccount }: {
    nep141Address: string
    nearAccount: Account
    auroraEvmAccount: string
  }
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class BorshArgs {
    constructor (args: any) {
      Object.assign(this, args)
    }
  };
  const schema = new Map([
    [BorshArgs, {
      kind: 'struct',
      fields: [
        ['nep141', 'String']
      ]
    }]
  ])
  const args = new BorshArgs({
    nep141: nep141Address
  })
  const serializedArgs = serializeBorsh(schema, args)
  const address: string = await nearAccount.viewFunction(
    auroraEvmAccount,
    'get_erc20_from_nep141',
    Buffer.from(serializedArgs),
    { parse: (result) => Buffer.from(result).toString('hex') }
  )
  return '0x' + address
}

export async function getNep141FromErc20 (
  { auroraErc20Address, nearAccount, auroraEvmAccount }: {
    auroraErc20Address: string
    nearAccount: Account
    auroraEvmAccount: string
  }
): Promise<string> {
  const address: string = await nearAccount.viewFunction(
    auroraEvmAccount,
    'get_nep141_from_erc20',
    Buffer.from(auroraErc20Address.toLowerCase().slice(2), 'hex'),
    { parse: (result) => Buffer.from(result).toString('utf-8') }
  )
  return address
}
