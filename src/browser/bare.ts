// What a page hid while game code ran, to put back after, and what went in its place.
interface Hidden {
  readonly key: string
  readonly descriptor: PropertyDescriptor
  readonly placed: PropertyDescriptor | null
}

// While game code runs, the page's global object is as bare as sim's realm, which has the language and the guard's stand-ins and nothing else: a game there finds no frames to open, whose own Date and crypto no guard covers, and none of the page's clocks, languages, screens, storage, or network. Every global the realm lacks reads undefined and document has no methods; window, document, location, and top themselves can't be removed. Baring the page costs a fraction of a millisecond, so it wraps whole runs of ticks, not each one.
export function barePage(keep: Iterable<string>): <T>(run: () => T) => T {
  const kept = new Set(keep)
  // What game code put under the page's own names, or null where it deleted one, which it finds there again in later runs of ticks, as it would in sim's realm.
  const theirs = new Map<string, PropertyDescriptor | null>()
  return (run) => {
    const names = Object.getOwnPropertyNames(globalThis)
    const hidden = hide(names.filter((key) => !kept.has(key)), theirs)
    const page: unknown = Object.getPrototypeOf(document)
    Object.setPrototypeOf(document, null)
    try {
      return run()
    } finally {
      Object.setPrototypeOf(document, typeof page === 'object' ? page : null)
      // A global game code made is its own from then on, as it would be in sim's realm.
      const had = new Set(names)
      for (const key of Object.getOwnPropertyNames(globalThis)) if (!had.has(key)) kept.add(key)
      for (let i = hidden.length - 1; i >= 0; i--) {
        const { key, descriptor, placed } = hidden[i]
        // A descriptor, not a read, so no getter game code put there runs.
        const now = Object.getOwnPropertyDescriptor(globalThis, key)
        if (!alike(now, placed)) theirs.set(key, now ?? null)
        if (descriptor.writable === true && now?.writable === true) Reflect.set(globalThis, key, descriptor.value)
        else Object.defineProperty(globalThis, key, descriptor)
      }
    }
  }
}

// Undefined rather than deleted, which is cheaper and leaves the page's own code its optimized lookups, and which reaches chrome too, whose value can change though the property can't go.
function hide(keys: readonly string[], theirs: ReadonlyMap<string, PropertyDescriptor | null>): Hidden[] {
  const hidden: Hidden[] = []
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    if (descriptor === undefined || !(descriptor.configurable || descriptor.writable)) continue
    const own = theirs.get(key)
    if (own === null) Reflect.deleteProperty(globalThis, key)
    else if (own !== undefined) Object.defineProperty(globalThis, key, own)
    else if (descriptor.writable) Reflect.set(globalThis, key, undefined)
    else Object.defineProperty(globalThis, key, { value: undefined, writable: true, configurable: true })
    hidden.push({ key, descriptor, placed: own === undefined ? EMPTY : own })
  }
  return hidden
}

const EMPTY: PropertyDescriptor = Object.freeze({ value: undefined, writable: true })

function alike(now: PropertyDescriptor | undefined, placed: PropertyDescriptor | null): boolean {
  if (now === undefined || placed === null) return now === undefined && placed === null
  return now.value === placed.value && now.writable === placed.writable && now.get === placed.get && now.set === placed.set
}
