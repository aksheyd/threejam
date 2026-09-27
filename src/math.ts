// JavaScript engines disagree in the last bit of these functions, so games get these portable versions,
// which follow fdlibm (sin, cos, atan, atan2, exp, log) or build on them.

const words = new DataView(new ArrayBuffer(8))

function high(x: number): number {
  words.setFloat64(0, x)
  return words.getInt32(0)
}

function low(x: number): number {
  words.setFloat64(0, x)
  return words.getUint32(4)
}

function withHigh(x: number, hi: number): number {
  words.setFloat64(0, x)
  words.setInt32(0, hi)
  return words.getFloat64(0)
}

function fromWords(hi: number, lo: number): number {
  words.setInt32(0, hi)
  words.setUint32(4, lo)
  return words.getFloat64(0)
}

const S1 = -1.66666666666666324348e-1
const S2 = 8.33333333332248946124e-3
const S3 = -1.98412698298579493134e-4
const S4 = 2.75573137070700676789e-6
const S5 = -2.50507602534068634195e-8
const S6 = 1.58969099521155010221e-10

function kernelSin(x: number, y: number, withTail: boolean): number {
  if ((high(x) & 0x7fffffff) < 0x3e400000 && Math.trunc(x) === 0) return x
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  if (!withTail) return x + v * (S1 + z * r)
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}

const C1 = 4.16666666666666019037e-2
const C2 = -1.38888888888741095749e-3
const C3 = 2.48015872894767294178e-5
const C4 = -2.75573143513906633035e-7
const C5 = 2.08757232129817482790e-9
const C6 = -1.13596475577881948265e-11

function kernelCos(x: number, y: number): number {
  const ix = high(x) & 0x7fffffff
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1
  const z = x * x
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y))
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0)
  return 1 - qx - (0.5 * z - qx - (z * r - x * y))
}

const INV_PIO2 = 6.36619772367581382433e-1
const PIO2_1 = 1.57079632673412561417
const PIO2_1T = 6.07710050650619224932e-11
const PIO2_2 = 6.07710050630396597660e-11
const PIO2_2T = 2.02226624879595063154e-21
const PIO2_3 = 2.02226624871116645580e-21
const PIO2_3T = 8.47842766036889956997e-32
const NPIO2_HW = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb, 0x402c463a, 0x402f6a7a, 0x4031475c,
  0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c,
  0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
]

interface Reduced {
  readonly quadrant: number
  readonly head: number
  readonly tail: number
}

const TWO_PI = 6.283185307179586

// Arguments beyond 2^19 * pi/2 fall back to an exact remainder by 2 pi: less accurate, but the same everywhere.
function reduce(x: number): Reduced {
  const hx = high(x)
  const ix = hx & 0x7fffffff
  if (ix > 0x413921fb) return reduce(x % TWO_PI)
  if (ix < 0x4002d97c) {
    const sign = hx > 0 ? 1 : -1
    let z = x - sign * PIO2_1
    if (ix !== 0x3ff921fb) {
      const head = z - sign * PIO2_1T
      return { quadrant: sign, head, tail: z - head - sign * PIO2_1T }
    }
    z -= sign * PIO2_2
    const head = z - sign * PIO2_2T
    return { quadrant: sign, head, tail: z - head - sign * PIO2_2T }
  }
  const t = Math.abs(x)
  const n = Math.trunc(t * INV_PIO2 + 0.5)
  let r = t - n * PIO2_1
  let w = n * PIO2_1T
  let head = r - w
  if (n >= 32 || ix === NPIO2_HW[n - 1]) {
    const j = ix >> 20
    if (j - ((high(head) >> 20) & 0x7ff) > 16) {
      let u = r
      w = n * PIO2_2
      r = u - w
      w = n * PIO2_2T - (u - r - w)
      head = r - w
      if (j - ((high(head) >> 20) & 0x7ff) > 49) {
        u = r
        w = n * PIO2_3
        r = u - w
        w = n * PIO2_3T - (u - r - w)
        head = r - w
      }
    }
  }
  const tail = r - head - w
  return hx < 0 ? { quadrant: -n, head: -head, tail: -tail } : { quadrant: n, head, tail }
}

export function sin(x: number): number {
  const ix = high(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, false)
  if (ix >= 0x7ff00000) return Number.NaN
  const { quadrant, head, tail } = reduce(x)
  switch (quadrant & 3) {
    case 0:
      return kernelSin(head, tail, true)
    case 1:
      return kernelCos(head, tail)
    case 2:
      return -kernelSin(head, tail, true)
    default:
      return -kernelCos(head, tail)
  }
}

export function cos(x: number): number {
  const ix = high(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kernelCos(x, 0)
  if (ix >= 0x7ff00000) return Number.NaN
  const { quadrant, head, tail } = reduce(x)
  switch (quadrant & 3) {
    case 0:
      return kernelCos(head, tail)
    case 1:
      return -kernelSin(head, tail, true)
    case 2:
      return -kernelCos(head, tail)
    default:
      return kernelSin(head, tail, true)
  }
}

export function tan(x: number): number {
  return sin(x) / cos(x)
}

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800]
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.1111110405462355788e-1, 9.09088713343650656196e-2,
  -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2, -3.6531572744216915527e-2,
  1.62858201153657823623e-2,
]

export function atan(input: number): number {
  const hx = high(input)
  const ix = hx & 0x7fffffff
  if (ix >= 0x44100000) {
    if (Number.isNaN(input)) return input
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3]
  }
  let x = input
  let id = -1
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e400000) return x
  } else {
    x = Math.abs(x)
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0
        x = (2 * x - 1) / (2 + x)
      } else {
        id = 1
        x = (x - 1) / (x + 1)
      }
    } else if (ix < 0x40038000) {
      id = 2
      x = (x - 1.5) / (1 + 1.5 * x)
    } else {
      id = 3
      x = -1 / x
    }
  }
  const z = x * x
  const w = z * z
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))))
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))))
  if (id < 0) return x - x * (s1 + s2)
  const angle = ATAN_HI[id] - (x * (s1 + s2) - ATAN_LO[id] - x)
  return hx < 0 ? -angle : angle
}

const PI = 3.141592653589793116
const PI_LO = 1.2246467991473531772e-16
const PI_O_2 = 1.570796326794896558
const PI_O_4 = 7.8539816339744827900e-1
const TINY = 1.0e-300

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN
  const hx = high(x)
  const lx = low(x)
  const ix = hx & 0x7fffffff
  const hy = high(y)
  const ly = low(y)
  const iy = hy & 0x7fffffff
  if (hx === 0x3ff00000 && lx === 0) return atan(y)
  let m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2)
  if ((iy | ly) === 0) {
    if (m < 2) return y
    return m === 2 ? PI + TINY : -PI - TINY
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) return [PI_O_4 + TINY, -PI_O_4 - TINY, 3 * PI_O_4 + TINY, -3 * PI_O_4 - TINY][m]
    return [0, -0, PI + TINY, -PI - TINY][m]
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY
  const k = (iy - ix) >> 20
  let z: number
  if (k > 60) {
    z = PI_O_2 + 0.5 * PI_LO
    m &= 1
  } else if (hx < 0 && k < -60) {
    z = 0
  } else {
    z = atan(Math.abs(y / x))
  }
  switch (m) {
    case 0:
      return z
    case 1:
      return -z
    case 2:
      return PI - (z - PI_LO)
    default:
      return z - PI_LO - PI
  }
}

export function asin(x: number): number {
  if (!(Math.abs(x) <= 1)) return Number.NaN
  return atan2(x, Math.sqrt((1 - x) * (1 + x)))
}

export function acos(x: number): number {
  if (!(Math.abs(x) <= 1)) return Number.NaN
  return atan2(Math.sqrt((1 - x) * (1 + x)), x)
}

const LN2_HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1]
const LN2_LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10]
const INV_LN2 = 1.44269504088896338700
const P1 = 1.66666666666666019037e-1
const P2 = -2.77777777770155933842e-3
const P3 = 6.61375632143793436117e-5
const P4 = -1.65339022054652515390e-6
const P5 = 4.13813679705723846039e-8
const TWO_M1000 = 9.33263618503218878990e-302

export function exp(input: number): number {
  const hxSigned = high(input)
  const sign = (hxSigned >>> 31) & 1
  const hx = hxSigned & 0x7fffffff
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (Number.isNaN(input)) return input
      return sign === 0 ? input : 0
    }
    if (input > 7.09782712893383973096e2) return Number.POSITIVE_INFINITY
    if (input < -7.45133219101941108420e2) return 0
  }
  let x = input
  let hi = 0
  let lo = 0
  let k = 0
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      if (x === 1) return Math.E
      hi = x - LN2_HI[sign]
      lo = LN2_LO[sign]
      k = 1 - sign - sign
    } else {
      k = Math.trunc(INV_LN2 * x + (sign === 0 ? 0.5 : -0.5))
      hi = x - k * LN2_HI[0]
      lo = k * LN2_LO[0]
    }
    x = hi - lo
  } else if (hx < 0x3e300000) {
    return 1 + x
  }
  const t = x * x
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  if (k === 0) return 1 - ((x * c) / (c - 2) - x)
  const y = 1 - (lo - (x * c) / (2 - c) - hi)
  if (k >= -1021) {
    if (k === 1024) return y * 2 * 8.98846567431157953865e307
    return y * fromWords(0x3ff00000 + (k << 20), 0)
  }
  return y * fromWords(0x3ff00000 + ((k + 1000) << 20), 0) * TWO_M1000
}

export function expm1(x: number): number {
  const u = exp(x)
  if (u === 1) return x
  if (u - 1 === -1) return -1
  if (!Number.isFinite(u)) return u
  return ((u - 1) * x) / log(u)
}

const LN2_HI_1 = 6.93147180369123816490e-1
const LN2_LO_1 = 1.90821492927058770002e-10
const TWO54 = 1.80143985094819840000e16
const LG1 = 6.666666666666735130e-1
const LG2 = 3.999999999940941908e-1
const LG3 = 2.857142874366239149e-1
const LG4 = 2.222219843214978396e-1
const LG5 = 1.818357216161805012e-1
const LG6 = 1.531383769920937332e-1
const LG7 = 1.479819860511658591e-1

export function log(input: number): number {
  let x = input
  let hx = high(x)
  const lx = low(x)
  let k = 0
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return Number.NEGATIVE_INFINITY
    if (hx < 0) return Number.NaN
    k -= 54
    x *= TWO54
    hx = high(x)
  }
  if (hx >= 0x7ff00000) return x + x
  k += (hx >> 20) - 1023
  hx &= 0x000fffff
  const i = (hx + 0x95f64) & 0x100000
  x = withHigh(x, hx | (i ^ 0x3ff00000))
  k += i >> 20
  const f = x - 1
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : k * LN2_HI_1 + k * LN2_LO_1
    const r = f * f * (0.5 - 0.33333333333333333 * f)
    return k === 0 ? f - r : k * LN2_HI_1 - (r - k * LN2_LO_1 - f)
  }
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  const r = t2 + t1
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f
    return k === 0 ? f - (hfsq - s * (hfsq + r)) : k * LN2_HI_1 - (hfsq - (s * (hfsq + r) + k * LN2_LO_1) - f)
  }
  return k === 0 ? f - s * (f - r) : k * LN2_HI_1 - (s * (f - r) - k * LN2_LO_1 - f)
}

export function log1p(x: number): number {
  const u = 1 + x
  if (u === 1) return x
  if (!Number.isFinite(u) || u <= 0) return log(u)
  return (log(u) * x) / (u - 1)
}

export function log2(x: number): number {
  const power = exactPower(x, 2, 1023)
  return power ?? log(x) / Math.LN2
}

export function log10(x: number): number {
  const power = exactPower(x, 10, 22)
  return power ?? log(x) / Math.LN10
}

function exactPower(x: number, base: number, most: number): number | undefined {
  if (!(x >= 1) || !Number.isFinite(x)) return undefined
  let value = 1
  for (let power = 0; power <= most; power++, value *= base) if (value === x) return power
  return undefined
}

export function cbrt(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return x
  const root = Math.sign(x) * exp(log(Math.abs(x)) / 3)
  return root - (root * root * root - x) / (3 * root * root)
}

const TWO_M28 = 3.725290298461914e-9
const TWO_28 = 268435456
const LOG_MAX = 709.7822265625

export function sinh(x: number): number {
  const a = Math.abs(x)
  const half = x < 0 ? -0.5 : 0.5
  if (a < 22) {
    if (a < TWO_M28) return x
    const t = expm1(a)
    return a < 1 ? half * (2 * t - (t * t) / (t + 1)) : half * (t + t / (t + 1))
  }
  if (a < LOG_MAX) return half * exp(a)
  const w = exp(0.5 * a)
  return half * w * w
}

export function cosh(x: number): number {
  const a = Math.abs(x)
  if (a < 0.5 * Math.LN2) {
    const t = expm1(a)
    return 1 + (t * t) / (2 * (1 + t))
  }
  if (a < 22) {
    const t = exp(a)
    return 0.5 * t + 0.5 / t
  }
  if (a < LOG_MAX) return 0.5 * exp(a)
  const w = exp(0.5 * a)
  return 0.5 * w * w
}

export function tanh(x: number): number {
  const a = Math.abs(x)
  if (a < TWO_M28) return x
  let value = 1
  if (a < 22) {
    const t = expm1(a >= 1 ? 2 * a : -2 * a)
    value = a >= 1 ? 1 - 2 / (t + 2) : -t / (t + 2)
  }
  return x < 0 ? -value : value
}

export function asinh(x: number): number {
  const a = Math.abs(x)
  if (a < TWO_M28 || !Number.isFinite(a)) return x
  let value: number
  if (a > TWO_28) value = log(a) + Math.LN2
  else if (a > 2) value = log(2 * a + 1 / (Math.sqrt(a * a + 1) + a))
  else value = log1p(a + (a * a) / (1 + Math.sqrt(1 + a * a)))
  return x < 0 ? -value : value
}

export function acosh(x: number): number {
  if (!(x >= 1)) return Number.NaN
  if (x > TWO_28) return log(x) + Math.LN2
  if (x > 2) return log(2 * x - 1 / (x + Math.sqrt(x * x - 1)))
  const t = x - 1
  return log1p(t + Math.sqrt(2 * t + t * t))
}

export function atanh(x: number): number {
  const a = Math.abs(x)
  if (!(a <= 1)) return Number.NaN
  if (a === 1) return x > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  if (a < TWO_M28) return x
  const value = a < 0.5 ? 0.5 * log1p(2 * a + (2 * a * a) / (1 - a)) : 0.5 * log1p((2 * a) / (1 - a))
  return x < 0 ? -value : value
}

export const PORTABLE = { sin, cos, tan, asin, acos, atan, atan2, exp, expm1, log, log1p, log2, log10, cbrt, sinh, cosh, tanh, asinh, acosh, atanh }
