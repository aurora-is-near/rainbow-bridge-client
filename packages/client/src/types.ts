import { ACTION_NEEDED, IN_PROGRESS, COMPLETE, FAILED } from './statuses'

export interface Step {
  key: string
  description?: string
  status: typeof FAILED | 'completed' | 'pending'
}

export interface TransferStatus {
  errors: string[]
  completedStep: null | string
  status: typeof IN_PROGRESS |
          typeof ACTION_NEEDED |
          typeof COMPLETE |
          typeof FAILED
}
export interface UnsavedTransfer extends TransferStatus {
  destinationTokenName: string
  recipient: string
  sender: string
  sourceToken: string
  sourceTokenName: string
  type: string
}

export interface TransactionInfo {
  amount: string
  sourceToken: string
  ethCache?: {
    from: string
    to: string
    safeReorgHeight: number
    data: string
    nonce: number
  }
}

/**
 * Attributes required by all transfer types. Individual
 * connector libraries may add additional attributes.
 */
export type Transfer = UnsavedTransfer & {
  id: string
}

export type DecoratedTransfer = Transfer & {
  error?: string
  sourceNetwork: string
  destinationNetwork: string
  steps: Step[]
  statusMessage: string
  callToAction?: string
}

export interface Transfers {
  [key: string]: Transfer
}

export interface CustomTransferTypes {
  [key: string]: ConnectorLib
}

interface Localizations {
  steps: (t: Transfer) => Step[]
  callToAction: (t: Transfer) => string | null
  statusMessage: (t: Transfer) => string
}

export interface ConnectorLib {
  SOURCE_NETWORK: string
  DESTINATION_NETWORK: string
  TOKEN_TYPE: string
  i18n: { [key: string]: Localizations }
  act: (t: Transfer) => Promise<Transfer>
  checkStatus: (t: Transfer) => Promise<Transfer>
}
