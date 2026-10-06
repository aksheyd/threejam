import assert from 'node:assert/strict'

// A game that tries each way around the guard the determinism review found, run by the tests in sim, in a Node process set to another language and time zone, and in a page. An error the guard raises keeps its text; any other reads "refused", since sim and a page word those differently.
export const PROBE = `import { defineGame, listOf } from 'threejam'

const host: Record<string, any> = globalThis
const DateType = Date.prototype.constructor as DateConstructor
const NowType = host.Temporal === undefined ? undefined : Object.getPrototypeOf(host.Temporal.Now)
const instant = Date.UTC(2024, 0, 31, 23, 30)
const full = { dateStyle: 'full', timeStyle: 'long' } as const

function attempt(run: () => unknown): string {
  try {
    return String(run())
  } catch (error: any) {
    const text = String(error?.message)
    return text.includes('would make runs differ') ? text.split(';')[0] : 'refused'
  }
}

// A call that names no locale or zone, beside the same call in en-US and UTC; an engine without the formatter, like Node 22's DurationFormat, agrees too.
function english(given: () => unknown, named: () => unknown): string {
  const [a, b] = [attempt(given), attempt(named)]
  return a === b ? 'en-US' : a + ' (en-US: ' + b + ')'
}

function frame(): any {
  const made = host.document.createElement('iframe')
  host.document.body.append(made)
  return made.contentWindow
}

export default defineGame({
  entities: { probe: { out: listOf(''), n: 0 } },
  update({ probe }, ctx) {
    const day = new Date(instant)
    if (ctx.tick === 1) Promise.resolve().then(() => void (probe.n += 1))
    probe.out = [
      attempt(() => DateType.now()),
      attempt(() => Date.prototype.getHours.call(day)),
      attempt(() => Date.prototype.getTimezoneOffset.call(day)),
      attempt(() => Date.prototype.toString.call(day)),
      english(() => Date.prototype.toLocaleString.call(day), () => day.toLocaleString('en-US', { timeZone: 'UTC' })),
      attempt(() => Object.setPrototypeOf(new Date(instant), Date.prototype).getHours()),
      attempt(() => {
        class Later extends Date {}
        return new Later(instant).getHours()
      }),
      attempt(() => (NowType === undefined ? 'refused' : NowType.instant())),
      attempt(() => (host.Temporal === undefined ? 'refused' : Object.getPrototypeOf(host.Temporal).Now.instant())),
      english(() => new (Intl.DateTimeFormat.prototype.constructor as any)(undefined, full).format(instant), () => new Intl.DateTimeFormat('en-US', { ...full, timeZone: 'UTC' }).format(instant)),
      english(() => new (Intl.NumberFormat.prototype.constructor as any)().format(1234567.5), () => new Intl.NumberFormat('en-US').format(1234567.5)),
      attempt(() => typeof Object.getPrototypeOf(Intl).DateTimeFormat),
      attempt(() => (Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format') as any).get.call(new Intl.DateTimeFormat('en-US'))()),
      english(() => 'I'.toLocaleLowerCase([]), () => 'I'.toLocaleLowerCase('en-US')),
      english(() => 'i'.toLocaleUpperCase([]), () => 'i'.toLocaleUpperCase('en-US')),
      english(() => (1234567.5).toLocaleString([]), () => (1234567.5).toLocaleString('en-US')),
      english(() => (1234567n).toLocaleString([]), () => (1234567n).toLocaleString('en-US')),
      english(() => new Intl.DateTimeFormat([], full).format(instant), () => new Intl.DateTimeFormat('en-US', { ...full, timeZone: 'UTC' }).format(instant)),
      english(() => new Intl.NumberFormat([]).format(1234567.5), () => new Intl.NumberFormat('en-US').format(1234567.5)),
      english(() => new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(1, 'day'), () => new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(1, 'day')),
      english(() => new Intl.DisplayNames([], { type: 'language' }).of('tr'), () => new Intl.DisplayNames('en-US', { type: 'language' }).of('tr')),
      english(() => new Intl.ListFormat([]).format(['a', 'b']), () => new Intl.ListFormat('en-US').format(['a', 'b'])),
      english(() => new Intl.PluralRules([]).select(0), () => new Intl.PluralRules('en-US').select(0)),
      english(() => new host.Intl.DurationFormat([], { style: 'long' }).format({ hours: 1, minutes: 2 }), () => new host.Intl.DurationFormat('en-US', { style: 'long' }).format({ hours: 1, minutes: 2 })),
      english(() => new Intl.Collator([]).compare('i', 'İ'), () => new Intl.Collator('en-US').compare('i', 'İ')),
      english(() => (1234567.5).toLocaleString({} as any), () => (1234567.5).toLocaleString('en-US')),
      attempt(() => frame().Date.now()),
      attempt(() => frame().crypto.getRandomValues(new Uint8Array(4)).join()),
      attempt(() => new (frame().Date)(instant).getHours()),
      attempt(() => host.chrome.loadTimes().requestTime),
      [host.navigator, host.localStorage, host.XMLHttpRequest, host.process, host.chrome].map((value) => typeof value).join(' '),
    ]
  },
})
`

// What the probe must show wherever it runs: every path to the clock or the machine's zone refused, every unnamed locale in en-US and UTC, and no frame or chrome timing to reach. Where game code runs bare, as in sim and a page, none of the host's own globals either; a Node process importing the game keeps its own.
export function checkProbe(out: unknown, { bare }: { bare: boolean }): void {
  assert.ok(Array.isArray(out) && out.every((line) => typeof line === 'string'), `the probe gave ${JSON.stringify(out)}`)
  const refused = (line: string) => line.endsWith('would make runs differ') || line === 'refused'
  assert.deepEqual(out.slice(0, 4), ['Date.now() would make runs differ', 'date.getHours() would make runs differ', 'date.getTimezoneOffset() would make runs differ', 'date.toString() would make runs differ'])
  assert.deepEqual(out.slice(5, 7), ['date.getHours() would make runs differ', 'date.getHours() would make runs differ'])
  assert.deepEqual(out.slice(7, 9), ['refused', 'refused'])
  assert.equal(out[11], 'undefined')
  assert.equal(out[12], 'Intl.DateTimeFormat format() with no date would make runs differ')
  for (const index of [4, 9, 10, ...Array.from({ length: 13 }, (_, i) => 13 + i)]) assert.equal(out[index], 'en-US', `line ${index}`)
  assert.ok(out.slice(26, 30).every(refused), JSON.stringify(out.slice(26, 30)))
  if (bare) assert.equal(out[30], 'undefined undefined undefined undefined undefined')
}
