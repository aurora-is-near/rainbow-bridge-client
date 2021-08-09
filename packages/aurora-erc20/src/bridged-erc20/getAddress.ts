import { getBridgeParams, getNearAccount } from '@near-eth/client/dist/utils'
import { Account } from 'near-api-js'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'

/**
 * Given an erc20 contract address, get the NEAR contract address of the
 * corresponding BridgeToken contract.
 *
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.erc20Address Contract address of an ERC20 token on Ethereum
 * @param params.options Optional arguments.
 * @param params.options.nep141Factory Bridge token factory account on NEAR.
 * @returns string Contract address of ERC-20 BridgeToken on Aurora
 */
export default async function getAuroraErc20Address (
  { erc20Address, options }: {
    erc20Address: string
    options?: {
      nep141Factory?: string
      nearAccount?: Account
      auroraEvmAccount?: string
    }
  }
): Promise<string> {
  options = options ?? {}
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const bridgeParams = getBridgeParams()
  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  const nep141Factory: string = options.nep141Factory ?? bridgeParams.nep141Factory
  const nep141Address = erc20Address.replace('0x', '').toLowerCase() + '.' + nep141Factory
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
