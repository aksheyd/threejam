// What a page hid while game code ran, to put back after.
interface Hidden {
  readonly owner: object
  readonly key: string
  readonly descriptor: PropertyDescriptor
}

// While game code runs, the page's global object is as bare as sim's realm, which has the language and the guard's stand-ins and nothing else: a game there finds no frames to open, whose own Date and crypto no guard covers, and none of the page's clocks, languages, screens, storage, or network. Every global the realm lacks reads undefined, document has no methods, and chrome loses its timing calls; window, document, location, top, and chrome themselves can't be removed. Baring the page costs a fraction of a millisecond, so it wraps whole runs of ticks, not each one.
export function barePage(keep: Iterable<string>): <T>(run: () => T) => T {
  const kept = new Set(keep)
  return (run) => {
    const hidden: Hidden[] = []
    hide(globalThis, Object.getOwnPropertyNames(globalThis).filter((key) => !kept.has(key)), hidden)
    const chrome: unknown = Reflect.get(globalThis, 'chrome')
    if (typeof chrome === 'object' && chrome !== null) hide(chrome, Object.getOwnPropertyNames(chrome), hidden)
    const page: unknown = Object.getPrototypeOf(document)
    Object.setPrototypeOf(document, null)
    try {
      return run()
    } finally {
      Object.setPrototypeOf(document, typeof page === 'object' ? page : null)
      for (let i = hidden.length - 1; i >= 0; i--) {
        const { owner, key, descriptor } = hidden[i]
        if (descriptor.writable) Reflect.set(owner, key, descriptor.value)
        else Object.defineProperty(owner, key, descriptor)
      }
    }
  }
}

// Undefined rather than deleted, which is cheaper and leaves the page's own code its optimized lookups.
function hide(owner: object, keys: readonly string[], into: Hidden[]): void {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor === undefined || !descriptor.configurable) continue
    into.push({ owner, key, descriptor })
    if (descriptor.writable) Reflect.set(owner, key, undefined)
    else Object.defineProperty(owner, key, { value: undefined, writable: true, configurable: true })
  }
}
