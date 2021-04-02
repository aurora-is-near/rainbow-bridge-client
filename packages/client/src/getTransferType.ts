import { ConnectorLib, Transfer } from './types'

export function getTransferType (transfer: Transfer): ConnectorLib {
  // TODO: find a way to `require(transfer.type)`
  try {
    switch (transfer.type) {
      case '@near-eth/nep141-erc20/natural-erc20/sendToNear':
        return require('@near-eth/nep141-erc20/dist/natural-erc20/sendToNear')
      case '@near-eth/nep141-erc20/bridged-nep141/sendToEthereum':
        return require('@near-eth/nep141-erc20/dist/bridged-nep141/sendToEthereum')
      default:
        throw new Error(`Unregistered library for transfer with type=${transfer.type}`)
    }
  } catch (depLoadError) {
    console.error(depLoadError)
    throw new Error(`Can't find library for transfer with type=${transfer.type}`)
  }
}
