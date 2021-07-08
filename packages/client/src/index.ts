import * as storage from './storage'
import * as status from './statuses'
import {
  ConnectorLib,
  Transfer,
  DecoratedTransfer,
  Step,
  UnsavedTransfer
} from './types'

export { onChange } from './storage'
export {
  setEthProvider, setNearConnection, setAuroraProvider, setSignerProvider,
  getSignerProvider, getEthProvider, getAuroraProvider
} from './utils'
export * as utils from './utils'

/**
 * Get the connector library for the given transfer's type
 * @param transfer Transfer object
 */
function getTransferType (transfer: Transfer): ConnectorLib {
  // TODO: find a way to `require(transfer.type)`
  try {
    switch (transfer.type) {
      case '@near-eth/nep141-erc20/natural-erc20/sendToNear':
        return require('@near-eth/nep141-erc20/dist/natural-erc20/sendToNear')
      case '@near-eth/nep141-erc20/bridged-nep141/sendToEthereum':
        return require('@near-eth/nep141-erc20/dist/bridged-nep141/sendToEthereum')
      case '@near-eth/near-ether/natural-near/sendToEthereum':
        return require('@near-eth/near-ether/dist/natural-near/sendToEthereum')
      case '@near-eth/near-ether/bridged-near/sendToNear':
        return require('@near-eth/near-ether/dist/bridged-near/sendToNear')
      case '@near-eth/near-ether/natural-ether/sendToNear':
        return require('@near-eth/near-ether/dist/natural-ether/sendToNear')
      case '@near-eth/near-ether/bridged-ether/sendToEthereum':
        return require('@near-eth/near-ether/dist/bridged-ether/sendToEthereum')
      case '@near-eth/aurora-erc20/natural-erc20/sendToAurora':
        return require('@near-eth/aurora-erc20/dist/natural-erc20/sendToAurora')
      case '@near-eth/aurora-erc20/bridged-erc20/sendToEthereum':
        return require('@near-eth/aurora-erc20/dist/bridged-erc20/sendToEthereum')
      case '@near-eth/aurora-ether/natural-ether/sendToAurora':
        return require('@near-eth/aurora-ether/dist/natural-ether/sendToAurora')
      case '@near-eth/aurora-ether/bridged-ether/sendToEthereum':
        return require('@near-eth/aurora-ether/dist/bridged-ether/sendToEthereum')
      default:
        throw new Error(`Unregistered library for transfer with type=${transfer.type}`)
    }
  } catch (depLoadError) {
    console.error(depLoadError)
    throw new Error(`Can't find library for transfer with type=${transfer.type}`)
  }
}

/**
 * Return a list of transfers
 *
 * @param {object} params Object of options
 * @param params.filter function Optional filter function
 *
 * @example
 *
 *     import { get } from '@near-eth/client'
 *     import { IN_PROGRESS, ACTION_NEEDED } from '@near-eth/client/dist/statuses'
 *     const inFlight = await get({
 *       filter: t => [IN_PROGRESS, ACTION_NEEDED].includes(t.status)
 *     })
 *
 * @returns array of transfers
 */
export async function get (
  { filter }: { filter?: (t: Transfer) => boolean } = {}
): Promise<Transfer[]> {
  let transfers = storage.getAll()
  if (filter !== undefined) transfers = transfers.filter(filter)
  return transfers
}

/*
 * Decorate a transfer with human- and app-friendly attributes.
 *
 * For storage efficiency, raw transfers don't include various attributes. This
 * returns a new object with all original attributes of provided `transfer`,
 * and also adds:
 *
 * - sourceNetwork: either 'ethereum' or 'near'
 * - destinationNetwork: either 'near' or 'ethereum'
 * - error: if status === 'failed', gets set to most recent error encountered
 *     by transfer (raw transfer has `errors` key which stores all errors
 *     encountered throughout life of transfer)
 * - steps: array, with each entry of the form `{ key: String, status:
 *     'pending' | 'complete' | 'failed', description: i18n'd String }`
 * - statusMessage: i18n'd present-tense version of in-progress step, or
 *     "Failed" if transfer.status === 'failed' (check transfer.error for error
 *     message)
 * - callToAction: something like 'Mint' or 'Confirm'; only added if
 *     transfer.status === 'action-needed'
 *
 * If you provide no `locale` or one unsupported by the underlying transfer
 * type, the transfer type's first locale will be used.
 */
export function decorate (
  transfer: Transfer,
  { locale }: { locale?: string } = {}
): DecoratedTransfer {
  const type = getTransferType(transfer)

  // @ts-expect-error
  let localized = type.i18n[locale]
  if (localized === undefined) {
    const availableLocales = Object.keys(type.i18n)
    const fallback = availableLocales[0]
    if (fallback !== undefined && locale !== undefined) {
      console.warn(
        `Requested locale ${locale} not available for ${transfer.type
        }. Available locales: \n\n  • ${availableLocales.join('\n  • ')
        }\n\nFalling back to ${fallback}`
      )
    }
    // @ts-expect-error
    localized = type.i18n[fallback]
  }

  let error: string | undefined
  if (transfer.status === status.FAILED) {
    error = transfer.errors[transfer.errors.length - 1]
  }

  let steps: Step[]
  let statusMessage: string
  let callToAction: string | undefined
  if (localized !== undefined) {
    steps = localized.steps(transfer)
    statusMessage = localized.statusMessage(transfer)
    callToAction = localized.callToAction(transfer)
  } else {
    steps = []
    statusMessage = `transfer with type=${
      transfer.type
    } has no defined i18n settings; cannot decorate it`
  }

  return {
    ...transfer,
    sourceNetwork: type.SOURCE_NETWORK,
    destinationNetwork: type.DESTINATION_NETWORK,
    error,
    steps,
    statusMessage,
    callToAction
  }
}

const transfersToRemove: string[] = []

/**
 * Record a transfer to be removed at the next status check.
 * This remove request will not be processed immediatly (at the next checkStatus loop)
 * so apps may want to manually hide the transfer until it actually gets removed from storage.
 * @param transferId
 */
export function remove (transferId: string): void {
  transfersToRemove.push(transferId)
}

/**
 * Process all pending transfer removal requests
 */
async function checkPendingTransferRemovals (): Promise<void> {
  await Promise.all(transfersToRemove.map(
    async transferId => await storage.clear(transferId)
  ))
  transfersToRemove.splice(0, transfersToRemove.length)
}

/*
 * Check statuses of all inProgress transfers, and update them accordingly.
 *
 * Can provide a `loop` frequency, in milliseconds, to call repeatedly while
 * inProgress transfers remain
 */
export async function checkStatusAll (
  { loop }: { loop?: number } = { loop: undefined }
): Promise<void> {
  if (loop !== undefined && !Number.isInteger(loop)) {
    throw new Error('`loop` must be frequency, in milliseconds')
  }

  await checkPendingTransferRemovals()

  const inProgress = await get({
    filter: t => t.status === status.IN_PROGRESS
  })

  // Check & update statuses for all in parallel
  await Promise.all(inProgress.map(async (t: Transfer) => await checkStatus(t.id)))

  // loop, if told to loop
  if (loop !== undefined) {
    window.setTimeout(
      () => { checkStatusAll({ loop }).catch(console.error) },
      loop
    )
  }
}

/*
 * Act on a transfer! That is, start whatever comes next.
 *
 * If a transfer step requires user confirmation before proceeding, this gets
 * called when the user confirms they're ready. Whatever next action is
 * appropriate for the transfer with given id, this will take it.
 *
 * If the transfer failed, this will retry it.
 */
export async function act (id: string): Promise<void> {
  const transfer = storage.get(id)
  if (!transfer) {
    throw new Error(`Cannot find and act on transfer with id ${id}`)
  }
  if (![status.FAILED, status.ACTION_NEEDED].includes(transfer.status)) {
    console.warn('No action needed for transfer with status', transfer.status)
    return
  }
  const type = getTransferType(transfer)

  try {
    await storage.update(await type.act(transfer))
  } catch (error) {
    await storage.update(transfer, {
      status: status.FAILED,
      errors: [...transfer.errors, error.message]
    })
    throw error
  }
}

/**
 * Clear a transfer from localStorage
 */
export async function clear (id: string): Promise<void> {
  await storage.clear(id)
}

/**
 * Add a new transfer to the set of cached local transfers. Transfer will
 * be given a chronologically-ordered id.
 *
 * @param transfer {@link UnsavedTransfer} a transfer with no 'id'
 *
 * @returns {@link Transfer} transfer with an 'id'
 */
export async function track (transferRaw: UnsavedTransfer): Promise<Transfer> {
  const id = new Date().toISOString()
  const transfer = { id, ...transferRaw }
  await storage.add(transfer)
  return transfer
}

// Check the status of a single transfer.
async function checkStatus (id: string): Promise<void> {
  let transfer = storage.get(id)
  if (!transfer) {
    throw new Error(`Cannot find and act on transfer with id ${id}`)
  }
  const type = getTransferType(transfer)

  // only in-progress transfers need to be checked on
  if (transfer.status === status.IN_PROGRESS) {
    try {
      transfer = await type.checkStatus(transfer)
      await storage.update(transfer)
    } catch (e) {
      console.error(e)
    }
  }
}
