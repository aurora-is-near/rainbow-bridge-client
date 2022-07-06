import BN from 'bn.js'
import { Account, providers as najProviders } from 'near-api-js'
import { AccountView } from 'near-api-js/lib/providers/provider'
import { getNearProvider } from '@near-eth/client/dist/utils'
import { AccountBalance } from 'near-api-js/lib/account'

export default async function getBalance (
  { owner, options }: {
    owner: string
    options?: {
      nearAccount?: Account
      nearProvider?: najProviders.Provider
    }
  }
): Promise<AccountBalance> {
  options = options ?? {}
  const nearProvider =
    options.nearProvider ??
    options.nearAccount?.connection.provider ??
    getNearProvider()

  // https://github.com/near/near-api-js/blob/fae90841ee320d812c352e2116cf974dbc283fc7/src/account.ts#L645
  const protocolConfig = await nearProvider.experimental_protocolConfig({ finality: 'final' })
  const state = await nearProvider.query<AccountView>({
    request_type: 'view_account',
    account_id: owner,
    finality: 'optimistic'
  })
  const costPerByte = new BN(protocolConfig.runtime_config.storage_amount_per_byte)
  const stateStaked = new BN(state.storage_usage).mul(costPerByte)
  const staked = new BN(state.locked)
  const totalBalance = new BN(state.amount).add(staked)
  const availableBalance = totalBalance.sub(BN.max(staked, stateStaked))
  return {
    total: totalBalance.toString(),
    stateStaked: stateStaked.toString(),
    staked: staked.toString(),
    available: availableBalance.toString()
  }
}
