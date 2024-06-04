import { providers as najProviders } from 'near-api-js'
import { CodeResult } from 'near-api-js/lib/providers/provider'

export async function getMetadata (
  { nep141Address, nearProvider }: {
    nep141Address: string
    nearProvider: najProviders.Provider
  }
): Promise<{symbol: string, decimals: number, name: string, icon: string}> {
  const result = await nearProvider.query<CodeResult>({
    request_type: 'call_function',
    account_id: nep141Address,
    method_name: 'ft_metadata',
    args_base64: '',
    finality: 'optimistic'
  })
  return JSON.parse(Buffer.from(result.result).toString())
}

export async function getBalance (
  { nep141Address, owner, nearProvider }: {
    nep141Address: string
    owner: string
    nearProvider: najProviders.Provider
  }
): Promise<string> {
  const result = await nearProvider.query<CodeResult>({
    request_type: 'call_function',
    account_id: nep141Address,
    method_name: 'ft_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: owner })).toString('base64'),
    finality: 'optimistic'
  })
  return JSON.parse(Buffer.from(result.result).toString())
}

export async function getMinStorageBalance (
  { nep141Address, nearProvider }: {
    nep141Address: string
    nearProvider: najProviders.Provider
  }
): Promise<string> {
  try {
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      account_id: nep141Address,
      method_name: 'storage_balance_bounds',
      args_base64: '',
      finality: 'optimistic'
    })
    return JSON.parse(Buffer.from(result.result).toString()).min
  } catch (e) {
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      account_id: nep141Address,
      method_name: 'storage_minimum_balance',
      args_base64: '',
      finality: 'optimistic'
    })
    return JSON.parse(Buffer.from(result.result).toString())
  }
}

export async function getStorageBalance (
  { nep141Address, accountId, nearProvider }: {
    nep141Address: string
    accountId: string
    nearProvider: najProviders.Provider
  }
): Promise<null | {total: string}> {
  try {
    const result = await nearProvider.query<CodeResult>({
      request_type: 'call_function',
      account_id: nep141Address,
      method_name: 'storage_balance_of',
      args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString('base64'),
      finality: 'optimistic'
    })
    return JSON.parse(Buffer.from(result.result).toString())
  } catch (e) {
    console.warn(e, nep141Address)
    return null
  }
}
