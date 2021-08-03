import { ethers } from 'ethers'

export async function getBalance (
  { erc20Address, owner, provider, erc20Abi }: {
    erc20Address: string
    owner: string
    provider: ethers.providers.Provider
    erc20Abi: string
  }
): Promise<string> {
  const erc20Contract = new ethers.Contract(
    erc20Address,
    erc20Abi,
    provider
  )

  return (await erc20Contract.balanceOf(owner)).toString()
}

export async function getAllowance (
  { erc20Address, owner, spender, provider, erc20Abi }: {
    erc20Address: string
    owner: string
    spender: string
    provider: ethers.providers.Provider
    erc20Abi: string
  }
): Promise<string> {
  const erc20Contract = new ethers.Contract(
    erc20Address,
    erc20Abi,
    provider
  )

  const allowance = await erc20Contract.allowance(owner, spender)
  return allowance.toString()
}

export async function getDecimals (
  { erc20Address, provider, erc20Abi }: {
    erc20Address: string
    provider: ethers.providers.Provider
    erc20Abi: string
  }
): Promise<number> {
  const erc20Contract = new ethers.Contract(
    erc20Address,
    erc20Abi,
    provider
  )
  const decimals = await erc20Contract.decimals()
  return Number(decimals)
}

export async function getSymbol (
  { erc20Address, provider, erc20Abi }: {
    erc20Address: string
    provider: ethers.providers.Provider
    erc20Abi: string
  }
): Promise<string> {
  const erc20Contract = new ethers.Contract(
    erc20Address,
    erc20Abi,
    provider
  )
  const symbol = await erc20Contract.symbol()
  return symbol
}
