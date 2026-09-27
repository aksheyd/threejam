import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PORTABLE } from '../src/math.ts'
import { defineGame, simulate } from '../src/index.ts'

function ulps(a: number, b: number): number {
  if (Object.is(a, b)) return 0
  const view = new DataView(new ArrayBuffer(16))
  view.setFloat64(0, a)
  view.setFloat64(8, b)
  const gap = view.getBigInt64(0) - view.getBigInt64(8)
  return Number(gap < 0n ? -gap : gap)
}

test('the portable math functions stay within a few ulps of the platform and keep its special values', () => {
  let state = 7
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296
  const worst = new Map<string, number>()
  for (let i = 0; i < 20000; i++) {
    const [x, unit, positive] = [(next() - 0.5) * 400, next() * 2 - 1, next() * 50 + 1e-9]
    const pairs: Array<[string, number, number]> = [
      ['sin', PORTABLE.sin(x), Math.sin(x)],
      ['cos', PORTABLE.cos(x), Math.cos(x)],
      ['tan', PORTABLE.tan(unit), Math.tan(unit)],
      ['asin', PORTABLE.asin(unit), Math.asin(unit)],
      ['acos', PORTABLE.acos(unit), Math.acos(unit)],
      ['atan', PORTABLE.atan(x), Math.atan(x)],
      ['atan2', PORTABLE.atan2(unit, x), Math.atan2(unit, x)],
      ['exp', PORTABLE.exp(unit * 700), Math.exp(unit * 700)],
      ['expm1', PORTABLE.expm1(unit * 3), Math.expm1(unit * 3)],
      ['log', PORTABLE.log(positive), Math.log(positive)],
      ['log1p', PORTABLE.log1p(unit * 0.99), Math.log1p(unit * 0.99)],
      ['log2', PORTABLE.log2(positive), Math.log2(positive)],
      ['log10', PORTABLE.log10(positive), Math.log10(positive)],
      ['cbrt', PORTABLE.cbrt(x), Math.cbrt(x)],
      ['sinh', PORTABLE.sinh(unit * 5), Math.sinh(unit * 5)],
      ['cosh', PORTABLE.cosh(unit * 5), Math.cosh(unit * 5)],
      ['tanh', PORTABLE.tanh(unit * 5), Math.tanh(unit * 5)],
      ['asinh', PORTABLE.asinh(x), Math.asinh(x)],
      ['acosh', PORTABLE.acosh(positive + 1), Math.acosh(positive + 1)],
      ['atanh', PORTABLE.atanh(unit * 0.99), Math.atanh(unit * 0.99)],
    ]
    for (const [name, portable, native] of pairs) worst.set(name, Math.max(worst.get(name) ?? 0, ulps(portable, native)))
  }
  for (const [name, gap] of worst) assert.ok(gap <= 8, `${name} is ${gap} ulps from the platform`)
  const specials: Array<[number, number]> = [
    [PORTABLE.sin(-0), -0],
    [PORTABLE.cos(0), 1],
    [PORTABLE.exp(1), Math.E],
    [PORTABLE.log(0), Number.NEGATIVE_INFINITY],
    [PORTABLE.log2(8), 3],
    [PORTABLE.log10(1000), 3],
    [PORTABLE.atan2(0, -1), Math.PI],
  ]
  for (const [actual, expected] of specials) assert.ok(Object.is(actual, expected), `${actual} should be ${expected}`)
  assert.ok(Number.isNaN(PORTABLE.log(-1)) && Number.isNaN(PORTABLE.sin(Number.POSITIVE_INFINITY)))
})

test('game code sees the portable math while it runs, and the platform gets its own back after', () => {
  const seen: boolean[] = []
  const game = defineGame({ entities: { dot: { x: 0 } }, update: () => void seen.push(Math.sin === PORTABLE.sin && Math.log === PORTABLE.log) })
  simulate(game, { ticks: 2 })
  assert.deepEqual(seen, [true, true])
  assert.notEqual(Math.sin, PORTABLE.sin)
})
