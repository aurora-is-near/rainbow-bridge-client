import { FAILED } from './statuses'
import { Localizations, Transfer, Step } from './types'
import { getTransferType } from './getTransferType'

export function stepsFor (
  transfer: Transfer,
  steps: string[],
  descriptions: { [key: string]: string }
): Step[] {
  const completed = steps.indexOf(String(transfer.completedStep))
  return steps.map((key, i) => ({
    key,
    description: descriptions[key],
    status: transfer.status === FAILED && i === completed + 1
      ? FAILED
      : i <= completed ? 'completed' : 'pending'
  }))
}

export function localizedError (
  transfer: Transfer,
  errorKey: string
): string {
  const type = getTransferType(transfer)
  const i18n = type.i18n

  // get user's locale from browser
  const locale = navigator.language.replace('-', '_')

  // get available & fallback locale from given i18n
  const availableLocales = Object.keys(i18n)
  const fallback = availableLocales[0] as string

  // check if i18n includes localizations for browser's locale;
  // fall back to fallback if not
  let localized = i18n[locale]
  if (localized === undefined) {
    localized = i18n[fallback] as Localizations
  }

  // check if preferred localization contains error for given errorKey;
  // fall back to fallback's error message if not
  let error = localized.errors(transfer)[errorKey]
  if (error === undefined) {
    error = (i18n[fallback] as Localizations).errors(transfer)[errorKey]
  }

  if (error !== undefined) return error

  console.error(`No defined error for errorKey=${errorKey} for locale=${locale} or fallback=${fallback}`)
  return errorKey
}
