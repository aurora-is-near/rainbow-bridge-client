// TODO: delete this file!
//
// dependence on URL Params only needed as workaround until
// https://github.com/near/near-api-js/pull/467 is merged

export function get (...paramNames: string[]): string | null | { [x: string]: string } {
  const params = new URLSearchParams(window.location.search)

  if (paramNames.length === 0) {
    return Object.fromEntries(params.entries())
  }

  if (paramNames.length === 1) {
    return params.get(paramNames[0]!)
  }

  return paramNames.reduce(
    (obj, paramName) => ({ ...obj, [paramName]: params.get(paramName) }),
    {}
  )
}

export function set (newParams: { [x: string]: string }): void {
  const params = new URLSearchParams(window.location.search)
  for (const param in newParams) {
    params.set(param, newParams[param]!)
  }
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  window.history.replaceState({}, '', `${location.pathname}?${params}`)
}

export function clear (...paramNames: any[]): void {
  if (paramNames.length === 0) {
    window.history.replaceState({}, '', location.pathname)
  } else {
    const params = new URLSearchParams(window.location.search)
    paramNames.forEach(p => params.delete(p))
    if (params.toString()) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      window.history.replaceState({}, '', `${location.pathname}?${params}`)
    } else {
      window.history.replaceState({}, '', location.pathname)
    }
  }
}
