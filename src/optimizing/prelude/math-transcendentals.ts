import {
  Identifier,
  nodesMatching,
  NodeType,
  type ASTNode,
} from "../../frontend/ast/index.js";
import { BUILTIN_NAMESPACE } from "../metadata/builtin-methods.js";
import { float, POWER_STEPS } from "./spelling.js";

interface Transcendental {
  readonly member: string;
  readonly fn: string;
  readonly needs: readonly string[];
  readonly source: () => readonly string[];
}

interface Helper {
  readonly name: string;
  readonly source: () => readonly string[];
}

const MANTISSA_WORD_BITS = 20;
const MANTISSA_WORD_SCALE = 2 ** MANTISSA_WORD_BITS;
const MANTISSA_WORD_MASK = MANTISSA_WORD_SCALE - 1;
const ROOT_TWO_WORD = 0x6a09c;
const LOWER_POLYNOMIAL_WORD = 0x6147a;
const UPPER_POLYNOMIAL_WORD = 0x6b851;

const SUBNORMAL_SCALE_BITS = 54;
const SUBNORMAL_SCALE = 2 ** SUBNORMAL_SCALE_BITS;
const LEAST_SCALED_EXPONENT = -1021;
const UNDERFLOW_SCALE_BITS = 1000;

const bits = new DataView(new ArrayBuffer(8));

function wordDouble(word: number): number {
  bits.setUint32(0, word >>> 0);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}

function negated(value: number): string {
  return value < 0 ? `(0.0 - ${float(-value)})` : float(value);
}

const POWER_OF_TWO = "_m_pow2";
const EXPONENT_OF = "_m_exponent";

function powerOfTwo(): readonly string[] {
  const lines = [
    `fn ${POWER_OF_TWO}(k: int) -> float:`,
    "  n: int = k",
    "  if n < 0:",
    "    n = 0 - n",
    "  y: float = 1.0",
  ];
  for (const step of POWER_STEPS) {
    lines.push(`  if n >= ${step}:`);
    lines.push(`    y = y * ${float(2 ** step)}`);
    lines.push(`    n -= ${step}`);
  }
  lines.push("  if k < 0:");
  lines.push("    return 1.0 / y");
  lines.push("  return y");
  return lines;
}

function exponentOf(): readonly string[] {
  const lines = [`fn ${EXPONENT_OF}(v: float) -> int:`, "  y: float = v", "  k: int = 0"];
  for (const step of POWER_STEPS) {
    lines.push(`  if y >= ${float(2 ** step)}:`);
    lines.push(`    y = y / ${float(2 ** step)}`);
    lines.push(`    k += ${step}`);
  }
  for (const step of POWER_STEPS) {
    lines.push(`  if y * ${float(2 ** step)} < 2.0:`);
    lines.push(`    y = y * ${float(2 ** step)}`);
    lines.push(`    k -= ${step}`);
  }
  lines.push("  return k");
  return lines;
}

const OVERFLOW_LIMIT = 7.09782712893383973096e2;
const UNDERFLOW_LIMIT = -7.45133219101941108420e2;
const LN2_HIGH = 6.93147180369123816490e-1;
const LN2_LOW = 1.90821492927058770002e-10;
const INVERSE_LN2 = 1.44269504088896338700e0;
const EXP_P1 = 1.66666666666666019037e-1;
const EXP_P2 = -2.77777777770155933842e-3;
const EXP_P3 = 6.61375632143793436117e-5;
const EXP_P4 = -1.65339022054652515390e-6;
const EXP_P5 = 4.13813679705723846039e-8;
const OVERFLOW_FACTOR = 1e300;
const UNDERFLOW_FACTOR = 9.33263618503218878990e-302;
const LARGEST_DOUBLE = Number.MAX_VALUE;

const EXP_HALF_LN2 = wordDouble(0x3fd62e42 + 1);
const EXP_THREE_HALF_LN2 = wordDouble(0x3ff0a2b2);
const EXP_NEGLIGIBLE = wordDouble(0x3e300000);
const EXP_LIMIT = wordDouble(0x40862e42);

const INTERPRETER_EXP_OF_ONE = Math.E;

function expSource(): readonly string[] {
  return [
    "fn _m_exp(x: float) -> float:",
    "  if x != x:",
    "    return x + x",
    "  if x == 1.0:",
    `    return ${float(INTERPRETER_EXP_OF_ONE)}`,
    "  negative: bool = x < 0.0",
    "  ax: float = x",
    "  if negative:",
    "    ax = 0.0 - x",
    `  if ax >= ${float(EXP_LIMIT)}:`,
    `    if ax > ${float(LARGEST_DOUBLE)}:`,
    "      if negative:",
    "        return 0.0",
    "      return x",
    `    if x > ${float(OVERFLOW_LIMIT)}:`,
    `      return (x * ${float(OVERFLOW_FACTOR)}) * ${float(OVERFLOW_FACTOR)}`,
    `    if x < ${negated(UNDERFLOW_LIMIT)}:`,
    `      return ${float(UNDERFLOW_FACTOR)} * ${float(UNDERFLOW_FACTOR)}`,
    "  k: int = 0",
    "  high: float = 0.0",
    "  low: float = 0.0",
    "  r: float = x",
    `  if ax >= ${float(EXP_HALF_LN2)}:`,
    `    if ax < ${float(EXP_THREE_HALF_LN2)}:`,
    "      if negative:",
    `        high = x + ${float(LN2_HIGH)}`,
    `        low = ${negated(-LN2_LOW)}`,
    "        k = 0 - 1",
    "      else:",
    `        high = x - ${float(LN2_HIGH)}`,
    `        low = ${float(LN2_LOW)}`,
    "        k = 1",
    "    else:",
    "      bias: float = 0.5",
    "      if negative:",
    "        bias = 0.0 - 0.5",
    `      k = Math.trunc(${float(INVERSE_LN2)} * x + bias)`,
    "      scaled: float = k",
    `      high = x - scaled * ${float(LN2_HIGH)}`,
    `      low = scaled * ${float(LN2_LOW)}`,
    "    r = high - low",
    "  else:",
    `    if ax < ${float(EXP_NEGLIGIBLE)}:`,
    `      if ${float(OVERFLOW_FACTOR)} + x > 1.0:`,
    "        return 1.0 + x",
    "  t: float = r * r",
    `  c: float = r - t * (${float(EXP_P1)} + t * (${negated(EXP_P2)} + t * (${float(EXP_P3)} + ` +
      `t * (${negated(EXP_P4)} + t * ${float(EXP_P5)}))))`,
    "  if k == 0:",
    "    return 1.0 - ((r * c) / (c - 2.0) - r)",
    "  y: float = 1.0 - ((low - (r * c) / (2.0 - c)) - high)",
    `  if k >= ${negated(LEAST_SCALED_EXPONENT)}:`,
    "    lower: int = Math.trunc(k / 2)",
    `    return (y * ${POWER_OF_TWO}(lower)) * ${POWER_OF_TWO}(k - lower)`,
    `  return (y * ${POWER_OF_TWO}(k + ${UNDERFLOW_SCALE_BITS})) * ${float(UNDERFLOW_FACTOR)}`,
  ];
}

const LOG_LG1 = 6.666666666666735130e-1;
const LOG_LG2 = 3.999999999940941908e-1;
const LOG_LG3 = 2.857142874366239149e-1;
const LOG_LG4 = 2.222219843214978396e-1;
const LOG_LG5 = 1.818357216161805012e-1;
const LOG_LG6 = 1.531383769920937332e-1;
const LOG_LG7 = 1.479819860511658591e-1;
const LOG_THIRD = 0.33333333333333333;
const SMALLEST_NORMAL = wordDouble(0x00100000);

function logSource(): readonly string[] {
  return [
    "fn _m_log(x: float) -> float:",
    "  if x != x:",
    "    return x + x",
    "  v: float = x",
    "  k: int = 0",
    `  if v < ${float(SMALLEST_NORMAL)}:`,
    "    if v == 0.0:",
    "      return (0.0 - 1.0) / (v * v)",
    "    if v < 0.0:",
    "      return (v - v) / (v - v)",
    `    k -= ${SUBNORMAL_SCALE_BITS}`,
    `    v = v * ${float(SUBNORMAL_SCALE)}`,
    `  if v > ${float(LARGEST_DOUBLE)}:`,
    "    return v + v",
    `  e: int = ${EXPONENT_OF}(v)`,
    `  m: float = v / ${POWER_OF_TWO}(e)`,
    "  k += e",
    `  word: int = Math.floor((m - 1.0) * ${float(MANTISSA_WORD_SCALE)})`,
    "  reduced: float = m",
    `  if word >= ${ROOT_TWO_WORD}:`,
    "    reduced = m * 0.5",
    "    k += 1",
    "  f: float = reduced - 1.0",
    `  if ((word + 2) & ${MANTISSA_WORD_MASK}) < 3:`,
    "    if f == 0.0:",
    "      if k == 0:",
    "        return 0.0",
    "      tiny: float = k",
    `      return tiny * ${float(LN2_HIGH)} + tiny * ${float(LN2_LOW)}`,
    `    near: float = f * f * (0.5 - ${float(LOG_THIRD)} * f)`,
    "    if k == 0:",
    "      return f - near",
    "    steps: float = k",
    `    return steps * ${float(LN2_HIGH)} - ((near - steps * ${float(LN2_LOW)}) - f)`,
    "  s: float = f / (2.0 + f)",
    "  dk: float = k",
    "  z: float = s * s",
    "  w: float = z * z",
    `  t1: float = w * (${float(LOG_LG2)} + w * (${float(LOG_LG4)} + w * ${float(LOG_LG6)}))`,
    `  t2: float = z * (${float(LOG_LG1)} + w * (${float(LOG_LG3)} + w * (${float(LOG_LG5)} + ` +
      `w * ${float(LOG_LG7)})))`,
    "  total: float = t2 + t1",
    `  if word >= ${LOWER_POLYNOMIAL_WORD} and word <= ${UPPER_POLYNOMIAL_WORD}:`,
    "    hfsq: float = 0.5 * f * f",
    "    if k == 0:",
    "      return f - (hfsq - s * (hfsq + total))",
    `    return dk * ${float(LN2_HIGH)} - ((hfsq - (s * (hfsq + total) + dk * ` +
      `${float(LN2_LOW)})) - f)`,
    "  if k == 0:",
    "    return f - s * (f - total)",
    `  return dk * ${float(LN2_HIGH)} - ((s * (f - total) - dk * ${float(LN2_LOW)}) - f)`,
  ];
}

const TWO_OVER_PI: readonly number[] = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62,
  0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7, 0x246e3a,
  0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129,
  0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41,
  0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8,
  0x97ffde, 0x05980f, 0xef2f11, 0x8b5a0a, 0x6d1f6d, 0x367ecf,
  0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5,
  0xf17b3d, 0x0739f7, 0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08,
  0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3,
  0x91615e, 0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880,
  0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
];

const HALF_PI_PIECES: readonly number[] = [
  1.57079625129699707031e0, 7.54978941586159635335e-8,
  5.39030252995776476554e-15, 3.28200341580791294123e-22,
  1.27065575308067607349e-29, 1.22933308981111328932e-36,
  2.73370053816464559624e-44, 2.16741683877804819444e-51,
];

const SIN_S1 = -1.66666666666666324348e-1;
const SIN_S2 = 8.33333333332248946124e-3;
const SIN_S3 = -1.98412698298579493134e-4;
const SIN_S4 = 2.75573137070700676789e-6;
const SIN_S5 = -2.50507602534068634195e-8;
const SIN_S6 = 1.58969099521155010221e-10;

const COS_C1 = 4.16666666666666019037e-2;
const COS_C2 = -1.38888888888741095749e-3;
const COS_C3 = 2.48015872894767294178e-5;
const COS_C4 = -2.75573143513906633035e-7;
const COS_C5 = 2.08757232129817482790e-9;
const COS_C6 = -1.13596475577881948265e-11;

const INVERSE_HALF_PI = 6.36619772367581382433e-1;
const HALF_PI_1 = 1.57079632673412561417e0;
const HALF_PI_1T = 6.07710050650619224932e-11;
const HALF_PI_2 = 6.07710050630396597660e-11;
const HALF_PI_2T = 2.02226624879595063154e-21;
const HALF_PI_3 = 2.02226624871116645580e-21;
const HALF_PI_3T = 8.47842766036889956997e-32;

const CHUNK_BITS = 24;
const CHUNK_SCALE = 2 ** CHUNK_BITS;
const CHUNK_STEP = 2 ** -CHUNK_BITS;
const CHUNK_MASK = CHUNK_SCALE - 1;
const CHUNK_ROUNDS = 4;
const SCRATCH_SLOTS = 24;
const REDUCED_EXPONENT = 23;
const REDUCED_BIAS = 1046;
const EXPONENT_BIAS = 1023;
const QUADRANTS = 4;
const SECOND_STEP_GAP = 16;
const THIRD_STEP_GAP = 49;

const NO_REDUCTION_WORD = 0x3fe921fb;
const ONE_STEP_WORD = 0x4002d97c;
const AT_HALF_PI_WORD = 0x3ff921fb;
const CODY_WAITE_WORD = 0x413921fb;
const NOT_FINITE_WORD = 0x7ff00000;
const KERNEL_NEGLIGIBLE = wordDouble(0x3e400000);
const COS_SMALL = wordDouble(0x3fd33333);
const COS_TRUNCATED = wordDouble(0x3fe90000 + 1);

const HIGH_WORD = "_m_highword";
const BIASED_EXPONENT = "_m_biased";
const TRUNCATED_LOW = "_m_lowbits";
const KERNEL_SIN = "_m_kernel_sin";
const KERNEL_COS = "_m_kernel_cos";
const KERNEL_REDUCE = "_m_kernel_rem_pio2";
const REDUCE = "_m_rem_pio2";

function zeroed(count: number, value: string): string {
  return Array.from({ length: count }, () => value).join(", ");
}

function highWord(): readonly string[] {
  return [
    `fn ${HIGH_WORD}(v: float) -> int:`,
    `  e: int = ${EXPONENT_OF}(v)`,
    `  m: float = v / ${POWER_OF_TWO}(e)`,
    `  return (e + ${EXPONENT_BIAS}) * ${MANTISSA_WORD_SCALE} + ` +
      `Math.trunc((m - 1.0) * ${float(MANTISSA_WORD_SCALE)})`,
  ];
}

function biasedExponent(): readonly string[] {
  return [
    `fn ${BIASED_EXPONENT}(v: float) -> int:`,
    "  a: float = v",
    "  if a < 0.0:",
    "    a = 0.0 - a",
    `  if a < ${float(SMALLEST_NORMAL)}:`,
    "    return 0",
    `  return ${EXPONENT_OF}(a) + ${EXPONENT_BIAS}`,
  ];
}

function truncatedLow(): readonly string[] {
  return [
    `fn ${TRUNCATED_LOW}(v: float) -> float:`,
    `  e: int = ${EXPONENT_OF}(v)`,
    `  m: float = v / ${POWER_OF_TWO}(e)`,
    `  return (Math.floor((m - 1.0) * ${float(MANTISSA_WORD_SCALE)}) / ` +
      `${float(MANTISSA_WORD_SCALE)} + 1.0) * ${POWER_OF_TWO}(e)`,
  ];
}

function kernelSin(): readonly string[] {
  return [
    `fn ${KERNEL_SIN}(x: float, y: float, iy: int) -> float:`,
    "  ax: float = x",
    "  if ax < 0.0:",
    "    ax = 0.0 - ax",
    `  if ax < ${float(KERNEL_NEGLIGIBLE)}:`,
    "    if Math.trunc(x) == 0.0:",
    "      return x",
    "  z: float = x * x",
    "  v: float = z * x",
    `  r: float = ${float(SIN_S2)} + z * (${negated(SIN_S3)} + z * (${float(SIN_S4)} + ` +
      `z * (${negated(SIN_S5)} + z * ${float(SIN_S6)})))`,
    "  if iy == 0:",
    `    return x + v * (${negated(SIN_S1)} + z * r)`,
    `  return x - ((z * (0.5 * y - v * r) - y) - v * ${negated(SIN_S1)})`,
  ];
}

function kernelCos(): readonly string[] {
  return [
    `fn ${KERNEL_COS}(x: float, y: float) -> float:`,
    "  ax: float = x",
    "  if ax < 0.0:",
    "    ax = 0.0 - ax",
    `  if ax < ${float(KERNEL_NEGLIGIBLE)}:`,
    "    if Math.trunc(x) == 0.0:",
    "      return 1.0",
    "  z: float = x * x",
    `  r: float = z * (${float(COS_C1)} + z * (${negated(COS_C2)} + z * (${float(COS_C3)} + ` +
      `z * (${negated(COS_C4)} + z * (${float(COS_C5)} + z * ${negated(COS_C6)})))))`,
    `  if ax < ${float(COS_SMALL)}:`,
    "    return 1.0 - (0.5 * z - (z * r - x * y))",
    "  qx: float = 0.28125",
    `  if ax < ${float(COS_TRUNCATED)}:`,
    `    qx = ${TRUNCATED_LOW}(ax) * 0.25`,
    "  hz: float = 0.5 * z - qx",
    "  a: float = 1.0 - qx",
    "  return a - (hz - (z * r - x * y))",
  ];
}

function kernelReduce(): readonly string[] {
  return [
    `fn ${KERNEL_REDUCE}(e0: int, nx: int, y: float[], tx: float[], iq: int[], ` +
      "fa: float[], qa: float[], fq: float[]) -> int:",
    `  ipio2: int[] = [${TWO_OVER_PI.join(", ")}]`,
    `  pio2: float[] = [${HALF_PI_PIECES.map(float).join(", ")}]`,
    `  jk: int = ${CHUNK_ROUNDS}`,
    "  jp: int = jk",
    "  jx: int = nx - 1",
    `  jv: int = Math.trunc((e0 - 3) / ${CHUNK_BITS})`,
    "  if jv < 0:",
    "    jv = 0",
    `  q0: int = e0 - ${CHUNK_BITS} * (jv + 1)`,
    "  j: int = jv - jx",
    "  m: int = jx + jk",
    "  i: int = 0",
    "  while i <= m:",
    "    if j < 0:",
    "      fa[i] = 0.0",
    "    else:",
    "      fa[i] = ipio2[j]",
    "    i = i + 1",
    "    j = j + 1",
    "  i = 0",
    "  fw: float = 0.0",
    "  while i <= jk:",
    "    fw = 0.0",
    "    j = 0",
    "    while j <= jx:",
    "      fw = fw + tx[j] * fa[jx + i - j]",
    "      j = j + 1",
    "    qa[i] = fw",
    "    i = i + 1",
    "  jz: int = jk",
    "  z: float = 0.0",
    "  n: int = 0",
    "  ih: int = 0",
    "  carry: int = 0",
    "  k: int = 0",
    "  again: bool = true",
    "  while again:",
    "    again = false",
    "    i = 0",
    "    j = jz",
    "    z = qa[jz]",
    "    while j > 0:",
    `      fw = Math.trunc(${float(CHUNK_STEP)} * z)`,
    `      iq[i] = Math.trunc(z - ${float(CHUNK_SCALE)} * fw)`,
    "      z = qa[j - 1] + fw",
    "      i = i + 1",
    "      j = j - 1",
    `    z = z * ${POWER_OF_TWO}(q0)`,
    "    z = z - 8.0 * Math.floor(z * 0.125)",
    "    n = Math.trunc(z)",
    "    z = z - n",
    "    ih = 0",
    "    if q0 > 0:",
    `      i = iq[jz - 1] >> (${CHUNK_BITS} - q0)`,
    "      n = n + i",
    `      iq[jz - 1] = iq[jz - 1] - (i << (${CHUNK_BITS} - q0))`,
    `      ih = iq[jz - 1] >> (${CHUNK_BITS - 1} - q0)`,
    "    else:",
    "      if q0 == 0:",
    `        ih = iq[jz - 1] >> ${CHUNK_BITS - 1}`,
    "      else:",
    "        if z >= 0.5:",
    "          ih = 2",
    "    if ih > 0:",
    "      n = n + 1",
    "      carry = 0",
    "      i = 0",
    "      while i < jz:",
    "        j = iq[i]",
    "        if carry == 0:",
    "          if j != 0:",
    "            carry = 1",
    `            iq[i] = ${CHUNK_SCALE} - j`,
    "        else:",
    `          iq[i] = ${CHUNK_MASK} - j`,
    "        i = i + 1",
    "      if q0 == 1:",
    `        iq[jz - 1] = iq[jz - 1] & ${CHUNK_MASK >> 1}`,
    "      if q0 == 2:",
    `        iq[jz - 1] = iq[jz - 1] & ${CHUNK_MASK >> 2}`,
    "      if ih == 2:",
    "        z = 1.0 - z",
    "        if carry != 0:",
    `          z = z - ${POWER_OF_TWO}(q0)`,
    "    if z == 0.0:",
    "      j = 0",
    "      i = jz - 1",
    "      while i >= jk:",
    "        j = j | iq[i]",
    "        i = i - 1",
    "      if j == 0:",
    "        k = 1",
    "        while iq[jk - k] == 0:",
    "          k = k + 1",
    "        i = jz + 1",
    "        while i <= jz + k:",
    "          fa[jx + i] = ipio2[jv + i]",
    "          fw = 0.0",
    "          j = 0",
    "          while j <= jx:",
    "            fw = fw + tx[j] * fa[jx + i - j]",
    "            j = j + 1",
    "          qa[i] = fw",
    "          i = i + 1",
    "        jz = jz + k",
    "        again = true",
    "  if z == 0.0:",
    "    jz = jz - 1",
    `    q0 = q0 - ${CHUNK_BITS}`,
    "    while iq[jz] == 0:",
    "      jz = jz - 1",
    `      q0 = q0 - ${CHUNK_BITS}`,
    "  else:",
    `    z = z * ${POWER_OF_TWO}(0 - q0)`,
    `    if z >= ${float(CHUNK_SCALE)}:`,
    `      fw = Math.trunc(${float(CHUNK_STEP)} * z)`,
    `      iq[jz] = Math.trunc(z - ${float(CHUNK_SCALE)} * fw)`,
    "      jz = jz + 1",
    `      q0 = q0 + ${CHUNK_BITS}`,
    "      iq[jz] = Math.trunc(fw)",
    "    else:",
    "      iq[jz] = Math.trunc(z)",
    `  fw = ${POWER_OF_TWO}(q0)`,
    "  i = jz",
    "  while i >= 0:",
    "    qa[i] = fw * iq[i]",
    `    fw = fw * ${float(CHUNK_STEP)}`,
    "    i = i - 1",
    "  i = jz",
    "  while i >= 0:",
    "    fw = 0.0",
    "    k = 0",
    "    while k <= jp and k <= jz - i:",
    "      fw = fw + pio2[k] * qa[i + k]",
    "      k = k + 1",
    "    fq[jz - i] = fw",
    "    i = i - 1",
    "  fw = 0.0",
    "  i = jz",
    "  while i >= 0:",
    "    fw = fw + fq[i]",
    "    i = i - 1",
    "  if ih == 0:",
    "    y[0] = fw",
    "  else:",
    "    y[0] = 0.0 - fw",
    "  fw = fq[0] - fw",
    "  i = 1",
    "  while i <= jz:",
    "    fw = fw + fq[i]",
    "    i = i + 1",
    "  if ih == 0:",
    "    y[1] = fw",
    "  else:",
    "    y[1] = 0.0 - fw",
    "  return n & 7",
  ];
}

function reduce(): readonly string[] {
  return [
    `fn ${REDUCE}(x: float, y: float[]) -> int:`,
    "  ax: float = x",
    "  if x < 0.0:",
    "    ax = 0.0 - x",
    `  ix: int = ${HIGH_WORD}(ax)`,
    "  z: float = 0.0",
    "  w: float = 0.0",
    "  t: float = 0.0",
    "  r: float = 0.0",
    "  scaled: float = 0.0",
    "  i: int = 0",
    "  j: int = 0",
    "  n: int = 0",
    `  if ix <= ${NO_REDUCTION_WORD}:`,
    "    y[0] = x",
    "    y[1] = 0.0",
    "    return 0",
    `  if ix < ${ONE_STEP_WORD}:`,
    "    if x > 0.0:",
    `      z = x - ${float(HALF_PI_1)}`,
    `      if ix != ${AT_HALF_PI_WORD}:`,
    `        y[0] = z - ${float(HALF_PI_1T)}`,
    `        y[1] = (z - y[0]) - ${float(HALF_PI_1T)}`,
    "      else:",
    `        z = z - ${float(HALF_PI_2)}`,
    `        y[0] = z - ${float(HALF_PI_2T)}`,
    `        y[1] = (z - y[0]) - ${float(HALF_PI_2T)}`,
    "      return 1",
    `    z = x + ${float(HALF_PI_1)}`,
    `    if ix != ${AT_HALF_PI_WORD}:`,
    `      y[0] = z + ${float(HALF_PI_1T)}`,
    `      y[1] = (z - y[0]) + ${float(HALF_PI_1T)}`,
    "    else:",
    `      z = z + ${float(HALF_PI_2)}`,
    `      y[0] = z + ${float(HALF_PI_2T)}`,
    `      y[1] = (z - y[0]) + ${float(HALF_PI_2T)}`,
    "    return 0 - 1",
    `  if ix <= ${CODY_WAITE_WORD}:`,
    "    t = ax",
    `    n = Math.trunc(t * ${float(INVERSE_HALF_PI)} + 0.5)`,
    "    scaled = n",
    `    r = t - scaled * ${float(HALF_PI_1)}`,
    `    w = scaled * ${float(HALF_PI_1T)}`,
    `    j = ix >> ${MANTISSA_WORD_BITS}`,
    "    y[0] = r - w",
    `    i = j - ${BIASED_EXPONENT}(y[0])`,
    `    if i > ${SECOND_STEP_GAP}:`,
    "      t = r",
    `      w = scaled * ${float(HALF_PI_2)}`,
    "      r = t - w",
    `      w = scaled * ${float(HALF_PI_2T)} - ((t - r) - w)`,
    "      y[0] = r - w",
    `      i = j - ${BIASED_EXPONENT}(y[0])`,
    `      if i > ${THIRD_STEP_GAP}:`,
    "        t = r",
    `        w = scaled * ${float(HALF_PI_3)}`,
    "        r = t - w",
    `        w = scaled * ${float(HALF_PI_3T)} - ((t - r) - w)`,
    "        y[0] = r - w",
    "    y[1] = (r - y[0]) - w",
    "    if x < 0.0:",
    "      y[0] = 0.0 - y[0]",
    "      y[1] = 0.0 - y[1]",
    "      return 0 - n",
    "    return n",
    `  if ix >= ${NOT_FINITE_WORD}:`,
    "    y[0] = x - x",
    "    y[1] = y[0]",
    "    return 0",
    "  tx: float[] = [0.0, 0.0, 0.0]",
    `  iq: int[] = [${zeroed(SCRATCH_SLOTS, "0")}]`,
    `  fa: float[] = [${zeroed(SCRATCH_SLOTS, "0.0")}]`,
    `  qa: float[] = [${zeroed(SCRATCH_SLOTS, "0.0")}]`,
    `  fq: float[] = [${zeroed(SCRATCH_SLOTS, "0.0")}]`,
    `  e0: int = (ix >> ${MANTISSA_WORD_BITS}) - ${REDUCED_BIAS}`,
    `  z = (ax / ${POWER_OF_TWO}(${EXPONENT_OF}(ax))) * ${float(2 ** REDUCED_EXPONENT)}`,
    "  i = 0",
    "  while i < 2:",
    "    tx[i] = Math.trunc(z)",
    `    z = (z - tx[i]) * ${float(CHUNK_SCALE)}`,
    "    i = i + 1",
    "  tx[2] = z",
    "  nx: int = 3",
    "  while tx[nx - 1] == 0.0:",
    "    nx = nx - 1",
    `  n = ${KERNEL_REDUCE}(e0, nx, y, tx, iq, fa, qa, fq)`,
    "  if x < 0.0:",
    "    y[0] = 0.0 - y[0]",
    "    y[1] = 0.0 - y[1]",
    "    return 0 - n",
    "  return n",
  ];
}

function circular(name: string, near: string, quadrants: readonly string[]): readonly string[] {
  const lines = [
    `fn ${name}(x: float) -> float:`,
    "  if x != x:",
    "    return x - x",
    "  ax: float = x",
    "  if ax < 0.0:",
    "    ax = 0.0 - ax",
    `  if ax > ${float(LARGEST_DOUBLE)}:`,
    "    return x - x",
    "  if ax == 0.0:",
    `    return ${near}`,
    `  ix: int = ${HIGH_WORD}(ax)`,
    `  if ix <= ${NO_REDUCTION_WORD}:`,
    `    return ${near}`,
    "  y: float[] = [0.0, 0.0]",
    `  n: int = ${REDUCE}(x, y)`,
    `  q: int = n & ${QUADRANTS - 1}`,
  ];
  for (let quadrant = 0; quadrant < QUADRANTS; quadrant++) {
    lines.push(`  if q == ${quadrant}:`);
    lines.push(`    return ${quadrants[quadrant]}`);
  }
  lines.push(`  return ${quadrants[0]}`);
  return lines;
}

const SINE_QUADRANTS: readonly string[] = [
  `${KERNEL_SIN}(y[0], y[1], 1)`,
  `${KERNEL_COS}(y[0], y[1])`,
  `0.0 - ${KERNEL_SIN}(y[0], y[1], 1)`,
  `0.0 - ${KERNEL_COS}(y[0], y[1])`,
];

const COSINE_QUADRANTS: readonly string[] = [
  SINE_QUADRANTS[1]!,
  SINE_QUADRANTS[2]!,
  SINE_QUADRANTS[3]!,
  SINE_QUADRANTS[0]!,
];

function sinSource(): readonly string[] {
  return circular("_m_sin", `${KERNEL_SIN}(x, 0.0, 0)`, SINE_QUADRANTS);
}

function cosSource(): readonly string[] {
  return circular("_m_cos", `${KERNEL_COS}(x, 0.0)`, COSINE_QUADRANTS);
}

const HELPERS: readonly Helper[] = [
  { name: POWER_OF_TWO, source: powerOfTwo },
  { name: EXPONENT_OF, source: exponentOf },
  { name: HIGH_WORD, source: highWord },
  { name: BIASED_EXPONENT, source: biasedExponent },
  { name: TRUNCATED_LOW, source: truncatedLow },
  { name: KERNEL_REDUCE, source: kernelReduce },
  { name: REDUCE, source: reduce },
  { name: KERNEL_SIN, source: kernelSin },
  { name: KERNEL_COS, source: kernelCos },
];

const CIRCULAR_HELPERS: readonly string[] = HELPERS.map((helper) => helper.name);

const TRANSCENDENTALS: readonly Transcendental[] = [
  { member: "exp", fn: "_m_exp", needs: [POWER_OF_TWO], source: expSource },
  { member: "log", fn: "_m_log", needs: [POWER_OF_TWO, EXPONENT_OF], source: logSource },
  { member: "sin", fn: "_m_sin", needs: CIRCULAR_HELPERS, source: sinSource },
  { member: "cos", fn: "_m_cos", needs: CIRCULAR_HELPERS, source: cosSource },
];

const BY_MEMBER: ReadonlyMap<string, Transcendental> = new Map(
  TRANSCENDENTALS.map((one) => [one.member, one]),
);

function namespaceCall(node: ASTNode): Transcendental | null {
  if (node === null || node === undefined) return null;
  if (node.type !== NodeType.CallExpression) return null;
  const callee = node.callee as ASTNode | undefined;
  if (callee === undefined || callee.type !== NodeType.MemberExpression) return null;
  if (callee.computed === true) return null;
  const owner = callee.object as ASTNode | undefined;
  if (owner === undefined || owner.type !== NodeType.Identifier) return null;
  if (String(owner.name) !== BUILTIN_NAMESPACE) return null;
  const wanted = BY_MEMBER.get(String(callee.property));
  if (wanted === undefined) return null;
  return ((node.args as ASTNode[]) ?? []).length === 1 ? wanted : null;
}

function callSites(roots: readonly ASTNode[]): readonly ASTNode[] {
  return nodesMatching(roots, (node: ASTNode) => namespaceCall(node) !== null);
}

export function mathTranscendentalPrelude(roots: readonly ASTNode[]): string {
  const wanted = new Set(callSites(roots).map((site) => namespaceCall(site)!));
  if (wanted.size === 0) return "";
  const needed = new Set<string>();
  for (const one of wanted) for (const helper of one.needs) needed.add(helper);
  const blocks = [
    ...HELPERS.filter((helper) => needed.has(helper.name)).map((helper) => helper.source()),
    ...TRANSCENDENTALS.filter((one) => wanted.has(one)).map((one) => one.source()),
  ];
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

export function rewriteMathTranscendentals(roots: readonly ASTNode[]): number {
  const sites = callSites(roots);
  for (const site of sites) {
    site.callee = Identifier(namespaceCall(site)!.fn);
  }
  return sites.length;
}
