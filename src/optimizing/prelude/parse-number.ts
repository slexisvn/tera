import {
  nodesMatching,
  NodeType,
  type ASTNode,
} from "../../frontend/ast/index.js";
import {
  NUMBER_BUILTIN,
  PARSE_FLOAT_BUILTIN,
  PARSE_INT_BUILTIN,
} from "../metadata/builtin-methods.js";
import type { DeclaredSignature } from "../types/signature.js";
import { float, POWER_STEPS } from "./spelling.js";

export const PARSE_FLOAT_FUNCTION = "_parse_float";
export const PARSE_INT_FUNCTION = "_parse_int";

const READ = "_pn_read";
const TRIM = "_pn_trim";
const MUL_SMALL = "_pn_mul_small";
const ADD_SMALL = "_pn_add_small";
const COPY = "_pn_copy";
const SHIFT = "_pn_shift";
const HALVE = "_pn_halve";
const BITS = "_pn_bits";
const COMPARE = "_pn_compare";
const SUBTRACT = "_pn_subtract";
const TENTH = "_pn_tenth";
const SCALE = "_pn_scale";
const EXACT_TEN = "_pn_exact_ten";
const INFINITY_OF = "_pn_infinity";
const NOT_A_NUMBER = "_pn_not_a_number";
const ODD = "_pn_odd";
const ASSEMBLE = "_pn_assemble";
const BLANK = "_pn_blank";
const NAMED = "_pn_named";
const ROUND = "_pn_round";
const RADIX = "_pn_radix";
const DIGIT = "_pn_digit";
export const NUMBER_OF_FUNCTION = "_number_of";

export const PARSE_NUMBER_SIGNATURE: DeclaredSignature = {
  params: ["string"],
  returns: "float",
};

export const NUMBER_TEXT_READERS: ReadonlySet<string> = new Set([
  READ,
  NAMED,
  RADIX,
  PARSE_FLOAT_FUNCTION,
  PARSE_INT_FUNCTION,
  NUMBER_OF_FUNCTION,
]);

export const PARSE_NUMBER_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  [PARSE_FLOAT_BUILTIN, PARSE_FLOAT_FUNCTION],
  [PARSE_INT_BUILTIN, PARSE_INT_FUNCTION],
  [NUMBER_BUILTIN, NUMBER_OF_FUNCTION],
]);

const LIMB_BITS = 15;
const LIMB_BASE = 2 ** LIMB_BITS;
const LIMB_MASK = LIMB_BASE - 1;
const SMALL_DIGITS = 4;
const SMALL_FACTOR = 10 ** SMALL_DIGITS;

const MANTISSA_BITS = 53;
const MANTISSA_LIMIT = 2 ** MANTISSA_BITS;
const MANTISSA_SHIFT = MANTISSA_BITS - 1;
const LEAST_EXPONENT = -1074;
const MOST_EXPONENT = 1023 - MANTISSA_SHIFT;

const EXACT_DIGITS = 15;
const EXACT_POWER = 22;
const DIGIT_LIMIT = 800;
const POINT_ABOVE = 310;
const POINT_BELOW = -330;
const EXPONENT_LIMIT = 100000;
const BINARY_LIMIT = MOST_EXPONENT + MANTISSA_SHIFT + 1;

interface Prefix {
  readonly marks: readonly string[];
  readonly base: number;
  readonly step: number;
}

const PREFIXES: readonly Prefix[] = [
  { marks: ["x", "X"], base: 16, step: 4 },
  { marks: ["o", "O"], base: 8, step: 3 },
  { marks: ["b", "B"], base: 2, step: 1 },
];

const DECIMAL_BASE = 10;

const INFINITY_TEXT = "Infinity";

const code = (character: string): number => character.codePointAt(0)!;

const ZERO = code("0");
const NINE = code("9");
const MINUS = code("-");
const PLUS = code("+");
const DOT = code(".");
const SMALL_E = code("e");
const CAPITAL_E = code("E");
const SPACE = code(" ");
const LEAST_LETTER = code("a");
const MOST_LETTER = code("f");
const LEAST_CAPITAL = code("A");
const MOST_CAPITAL = code("F");
const LEAST_BLANK = code("\t");
const MOST_BLANK = code("\r");

function ladder(operator: string): readonly string[] {
  const lines: string[] = [];
  for (const step of POWER_STEPS) {
    lines.push(
      `  while n >= ${step}:`,
      `    v = v ${operator} ${float(2 ** step)}`,
      `    n -= ${step}`,
    );
  }
  return lines;
}

function storage(): readonly string[] {
  return [
    `fn ${TRIM}(a: int[]) -> void:`,
    "  while a.length > 0 and a[a.length - 1] == 0:",
    "    a.pop()",
    "",
    `fn ${COPY}(a: int[]) -> int[]:`,
    "  out: int[] = []",
    "  i: int = 0",
    "  while i < a.length:",
    "    out.push(a[i])",
    "    i += 1",
    "  return out",
  ];
}

function arithmetic(): readonly string[] {
  return [
    `fn ${MUL_SMALL}(a: int[], m: int) -> void:`,
    "  carry: int = 0",
    "  i: int = 0",
    "  while i < a.length:",
    "    product: int = a[i] * m + carry",
    `    a[i] = product & ${LIMB_MASK}`,
    `    carry = product >> ${LIMB_BITS}`,
    "    i += 1",
    "  while carry > 0:",
    `    a.push(carry & ${LIMB_MASK})`,
    `    carry = carry >> ${LIMB_BITS}`,
    "",
    `fn ${ADD_SMALL}(a: int[], v: int) -> void:`,
    "  carry: int = v",
    "  i: int = 0",
    "  while carry > 0:",
    "    if i >= a.length:",
    "      a.push(0)",
    "    total: int = a[i] + carry",
    `    a[i] = total & ${LIMB_MASK}`,
    `    carry = total >> ${LIMB_BITS}`,
    "    i += 1",
    "",
    `fn ${SUBTRACT}(a: int[], b: int[]) -> void:`,
    "  borrow: int = 0",
    "  i: int = 0",
    "  while i < a.length:",
    "    value: int = a[i] - borrow",
    "    if i < b.length:",
    "      value = value - b[i]",
    "    if value < 0:",
    `      value = value + ${LIMB_BASE}`,
    "      borrow = 1",
    "    else:",
    "      borrow = 0",
    "    a[i] = value",
    "    i += 1",
    `  ${TRIM}(a)`,
    "",
    `fn ${TENTH}(a: int[], k: int) -> void:`,
    "  n: int = k",
    `  while n >= ${SMALL_DIGITS}:`,
    `    ${MUL_SMALL}(a, ${SMALL_FACTOR})`,
    `    n -= ${SMALL_DIGITS}`,
    "  while n > 0:",
    `    ${MUL_SMALL}(a, 10)`,
    "    n -= 1",
  ];
}

function shifting(): readonly string[] {
  return [
    `fn ${SHIFT}(a: int[], bits: int) -> void:`,
    "  if bits <= 0 or a.length == 0:",
    "    return",
    `  spare: int = bits % ${LIMB_BITS}`,
    `  whole: int = Math.floor(bits / ${LIMB_BITS})`,
    "  i: int = 0",
    "  if spare > 0:",
    "    factor: int = 1",
    "    while i < spare:",
    "      factor = factor * 2",
    "      i += 1",
    "    carry: int = 0",
    "    i = 0",
    "    while i < a.length:",
    "      value: int = a[i] * factor + carry",
    `      a[i] = value & ${LIMB_MASK}`,
    `      carry = value >> ${LIMB_BITS}`,
    "      i += 1",
    "    if carry > 0:",
    "      a.push(carry)",
    "  if whole > 0:",
    "    old: int = a.length",
    "    i = 0",
    "    while i < whole:",
    "      a.push(0)",
    "      i += 1",
    "    i = old - 1",
    "    while i >= 0:",
    "      a[i + whole] = a[i]",
    "      i -= 1",
    "    i = 0",
    "    while i < whole:",
    "      a[i] = 0",
    "      i += 1",
    "",
    `fn ${HALVE}(a: int[]) -> void:`,
    "  carry: int = 0",
    "  i: int = a.length - 1",
    "  while i >= 0:",
    `    value: int = carry * ${LIMB_BASE} + a[i]`,
    "    a[i] = value >> 1",
    "    carry = value & 1",
    "    i -= 1",
    `  ${TRIM}(a)`,
    "",
    `fn ${BITS}(a: int[]) -> int:`,
    "  if a.length == 0:",
    "    return 0",
    "  top: int = a[a.length - 1]",
    "  used: int = 0",
    "  while top > 0:",
    "    used += 1",
    "    top = top >> 1",
    `  return (a.length - 1) * ${LIMB_BITS} + used`,
    "",
    `fn ${COMPARE}(a: int[], b: int[]) -> int:`,
    "  if a.length != b.length:",
    "    if a.length > b.length:",
    "      return 1",
    "    return -1",
    "  i: int = a.length - 1",
    "  while i >= 0:",
    "    if a[i] != b[i]:",
    "      if a[i] > b[i]:",
    "        return 1",
    "      return -1",
    "    i -= 1",
    "  return 0",
  ];
}

function floats(): readonly string[] {
  return [
    `fn ${SCALE}(m: float, k: int) -> float:`,
    "  v: float = m",
    "  n: int = k",
    "  if n < 0:",
    "    n = 0 - n",
    ...ladder("/").map((line) => `  ${line}`),
    "    return v",
    ...ladder("*"),
    "  return v",
    "",
    `fn ${EXACT_TEN}(k: int) -> float:`,
    "  v: float = 1.0",
    "  n: int = 0",
    "  while n < k:",
    "    v = v * 10.0",
    "    n += 1",
    "  return v",
    "",
    `fn ${INFINITY_OF}() -> float:`,
    "  zero: float = 0.0",
    "  one: float = 1.0",
    "  return one / zero",
    "",
    `fn ${NOT_A_NUMBER}() -> float:`,
    "  zero: float = 0.0",
    "  return zero / zero",
    "",
    `fn ${ODD}(q: float) -> int:`,
    "  if Math.floor(q * 0.5) * 2.0 == q:",
    "    return 0",
    "  return 1",
  ];
}

function fastPath(): readonly string[] {
  return [
    `  if cut == 0 and nd <= ${EXACT_DIGITS} and exponent >= -${EXACT_POWER} and exponent <= ${EXACT_POWER}:`,
    "    whole: float = 0.0",
    "    while i < nd:",
    "      whole = whole * 10.0 + dig[i]",
    "      i += 1",
    "    if exponent >= 0:",
    `      return whole * ${EXACT_TEN}(exponent)`,
    `    return whole / ${EXACT_TEN}(0 - exponent)`,
  ];
}

function ratio(): readonly string[] {
  return [
    "  num: int[] = []",
    "  while i < nd:",
    "    chunk: int = 0",
    "    scale: int = 1",
    "    j: int = 0",
    `    while j < ${SMALL_DIGITS} and i < nd:`,
    "      chunk = chunk * 10 + dig[i]",
    "      scale = scale * 10",
    "      i += 1",
    "      j += 1",
    `    ${MUL_SMALL}(num, scale)`,
    `    ${ADD_SMALL}(num, chunk)`,
    "  den: int[] = [1]",
    "  if exponent > 0:",
    `    ${TENTH}(num, exponent)`,
    "  else if exponent < 0:",
    `    ${TENTH}(den, 0 - exponent)`,
  ];
}

function binade(): readonly string[] {
  return [
    `  gap: int = ${BITS}(num) - ${BITS}(den)`,
    `  probe: int[] = ${COPY}(num)`,
    `  guard: int[] = ${COPY}(den)`,
    "  if gap > 0:",
    `    ${SHIFT}(guard, gap)`,
    "  else:",
    `    ${SHIFT}(probe, 0 - gap)`,
    "  order: int = gap - 1",
    `  if ${COMPARE}(probe, guard) >= 0:`,
    "    order = gap",
    `  place: int = order - ${MANTISSA_SHIFT}`,
    `  if place < ${LEAST_EXPONENT}:`,
    `    place = ${LEAST_EXPONENT}`,
    `  if place > ${MOST_EXPONENT}:`,
    `    return ${INFINITY_OF}()`,
  ];
}

function divide(): readonly string[] {
  return [
    `  rest: int[] = ${COPY}(num)`,
    `  divisor: int[] = ${COPY}(den)`,
    "  if place < 0:",
    `    ${SHIFT}(rest, 0 - place)`,
    "  else:",
    `    ${SHIFT}(divisor, place)`,
    "  q: float = 0.0",
    `  span: int = ${BITS}(rest) - ${BITS}(divisor)`,
    "  if span >= 0:",
    `    step: int[] = ${COPY}(divisor)`,
    `    ${SHIFT}(step, span)`,
    `    bit: float = ${SCALE}(1.0, span)`,
    "    i = span",
    "    while i >= 0:",
    `      if ${COMPARE}(rest, step) >= 0:`,
    `        ${SUBTRACT}(rest, step)`,
    "        q = q + bit",
    `      ${HALVE}(step)`,
    "      bit = bit * 0.5",
    "      i -= 1",
  ];
}

function rounding(): readonly string[] {
  return [
    `  ${SHIFT}(rest, 1)`,
    `  order = ${COMPARE}(rest, divisor)`,
    "  up: int = 0",
    "  if order > 0:",
    "    up = 1",
    "  else if order == 0:",
    "    if cut == 1:",
    "      up = 1",
    `    else if ${ODD}(q) == 1:`,
    "      up = 1",
    "  if up == 1:",
    "    q = q + 1.0",
    `    if q >= ${float(MANTISSA_LIMIT)}:`,
    "      q = q * 0.5",
    "      place += 1",
    `      if place > ${MOST_EXPONENT}:`,
    `        return ${INFINITY_OF}()`,
    `  return ${SCALE}(q, place)`,
  ];
}

function assembling(): readonly string[] {
  return [
    `fn ${ROUND}(num: int[], den: int[], cut: int) -> float:`,
    "  if num.length == 0:",
    "    return 0.0",
    "  i: int = 0",
    ...binade(),
    ...divide(),
    ...rounding(),
    "",
    `fn ${ASSEMBLE}(dig: int[], point: int, cut: int) -> float:`,
    "  nd: int = dig.length",
    "  if nd == 0:",
    "    return 0.0",
    `  if point > ${POINT_ABOVE}:`,
    `    return ${INFINITY_OF}()`,
    `  if point < ${POINT_BELOW}:`,
    "    return 0.0",
    "  exponent: int = point - nd",
    "  i: int = 0",
    ...fastPath(),
    ...ratio(),
    `  return ${ROUND}(num, den, cut)`,
  ];
}

function scanning(): readonly string[] {
  return [
    `fn ${BLANK}(c: int) -> int:`,
    `  if c == ${SPACE} or (c >= ${LEAST_BLANK} and c <= ${MOST_BLANK}):`,
    "    return 1",
    "  return 0",
    "",
    `fn ${NAMED}(text: string, at: int, stop: int) -> int:`,
    `  if at + ${INFINITY_TEXT.length} > stop:`,
    "    return 0",
    `  word: string = "${INFINITY_TEXT}"`,
    "  i: int = 0",
    `  while i < ${INFINITY_TEXT.length}:`,
    "    if text.char_code_at(at + i) != word.char_code_at(i):",
    "      return 0",
    "    i += 1",
    "  return 1",
  ];
}

function digits(): readonly string[] {
  return [
    "  dig: int[] = []",
    "  point: int = 0",
    "  cut: int = 0",
    "  seen: int = 0",
    "  dotted: int = 0",
    "  while at < stop:",
    "    c: int = text.char_code_at(at)",
    `    if fraction == 1 and c == ${DOT} and dotted == 0:`,
    "      dotted = 1",
    "      point = dig.length",
    "      at += 1",
    `    else if c >= ${ZERO} and c <= ${NINE}:`,
    "      seen = 1",
    `      if c == ${ZERO} and dig.length == 0:`,
    "        point -= 1",
    `      else if dig.length < ${DIGIT_LIMIT}:`,
    `        dig.push(c - ${ZERO})`,
    `      else if c != ${ZERO}:`,
    "        cut = 1",
    "      at += 1",
    "    else:",
    "      break",
    "  if seen == 0:",
    `    return ${NOT_A_NUMBER}()`,
    "  if dotted == 0:",
    "    point = dig.length",
  ];
}

function exponent(): readonly string[] {
  return [
    "  if fraction == 1 and at < stop:",
    "    mark: int = text.char_code_at(at)",
    `    if mark == ${SMALL_E} or mark == ${CAPITAL_E}:`,
    "      after: int = at + 1",
    "      lift: int = 1",
    "      if after < stop:",
    "        marker: int = text.char_code_at(after)",
    `        if marker == ${MINUS}:`,
    "          lift = -1",
    "          after += 1",
    `        else if marker == ${PLUS}:`,
    "          after += 1",
    "      power: int = 0",
    "      count: int = 0",
    "      while after < stop:",
    "        c: int = text.char_code_at(after)",
    `        if c < ${ZERO} or c > ${NINE}:`,
    "          break",
    `        if power < ${EXPONENT_LIMIT}:`,
    `          power = power * 10 + c - ${ZERO}`,
    "        count += 1",
    "        after += 1",
    "      if count > 0:",
    "        point = point + lift * power",
    "        at = after",
  ];
}

function reading(): readonly string[] {
  return [
    `fn ${READ}(text: string, fraction: int, whole: int) -> float:`,
    "  stop: int = text.length",
    "  at: int = 0",
    `  while at < stop and ${BLANK}(text.char_code_at(at)) == 1:`,
    "    at += 1",
    "  if whole == 1:",
    `    while stop > at and ${BLANK}(text.char_code_at(stop - 1)) == 1:`,
    "      stop -= 1",
    "    if at >= stop:",
    "      return 0.0",
    ...prefixed(),
    "  negative: int = 0",
    "  if at < stop:",
    "    lead: int = text.char_code_at(at)",
    `    if lead == ${MINUS}:`,
    "      negative = 1",
    "      at += 1",
    `    else if lead == ${PLUS}:`,
    "      at += 1",
    `  if fraction == 1 and ${NAMED}(text, at, stop) == 1:`,
    `    if whole == 1 and at + ${INFINITY_TEXT.length} != stop:`,
    `      return ${NOT_A_NUMBER}()`,
    "    if negative == 1:",
    `      return 0.0 - ${INFINITY_OF}()`,
    `    return ${INFINITY_OF}()`,
    ...digits(),
    ...exponent(),
    "  if whole == 1 and at != stop:",
    `    return ${NOT_A_NUMBER}()`,
    "  while dig.length > 0 and dig[dig.length - 1] == 0:",
    "    dig.pop()",
    `  value: float = ${ASSEMBLE}(dig, point, cut)`,
    "  if negative == 1:",
    "    return 0.0 - value",
    "  return value",
    "",
    `fn ${PARSE_FLOAT_FUNCTION}(text: string) -> float:`,
    `  return ${READ}(text, 1, 0)`,
    "",
    `fn ${PARSE_INT_FUNCTION}(text: string) -> float:`,
    `  return ${READ}(text, 0, 0)`,
    "",
    `fn ${NUMBER_OF_FUNCTION}(text: string) -> float:`,
    `  return ${READ}(text, 1, 1)`,
  ];
}

function radix(): readonly string[] {
  return [
    `fn ${DIGIT}(c: int, base: int) -> int:`,
    "  v: int = -1",
    `  if c >= ${ZERO} and c <= ${NINE}:`,
    `    v = c - ${ZERO}`,
    `  else if c >= ${LEAST_LETTER} and c <= ${MOST_LETTER}:`,
    `    v = c - ${LEAST_LETTER} + ${DECIMAL_BASE}`,
    `  else if c >= ${LEAST_CAPITAL} and c <= ${MOST_CAPITAL}:`,
    `    v = c - ${LEAST_CAPITAL} + ${DECIMAL_BASE}`,
    "  if v >= base:",
    "    return -1",
    "  return v",
    "",
    `fn ${RADIX}(text: string, start: int, stop: int, base: int, step: int) -> float:`,
    "  if start >= stop:",
    `    return ${NOT_A_NUMBER}()`,
    "  i: int = start",
    "  while i < stop:",
    `    if ${DIGIT}(text.char_code_at(i), base) < 0:`,
    `      return ${NOT_A_NUMBER}()`,
    "    i += 1",
    "  i = start",
    `  while i < stop and text.char_code_at(i) == ${ZERO}:`,
    "    i += 1",
    `  if (stop - i - 1) * step >= ${BINARY_LIMIT}:`,
    `    return ${INFINITY_OF}()`,
    "  num: int[] = []",
    "  while i < stop:",
    `    ${MUL_SMALL}(num, base)`,
    `    ${ADD_SMALL}(num, ${DIGIT}(text.char_code_at(i), base))`,
    "    i += 1",
    "  den: int[] = [1]",
    `  return ${ROUND}(num, den, 0)`,
  ];
}

function prefixed(): readonly string[] {
  const marked = PREFIXES.flatMap((prefix, index) => [
    `      ${index === 0 ? "if" : "else if"} ${prefix.marks
      .map((mark) => `marker == ${code(mark)}`)
      .join(" or ")}:`,
    `        base = ${prefix.base}`,
    `        step = ${prefix.step}`,
  ]);
  return [
    `    if text.char_code_at(at) == ${ZERO} and at + 2 <= stop:`,
    "      marker: int = text.char_code_at(at + 1)",
    "      base: int = 0",
    "      step: int = 0",
    ...marked,
    "      if base > 0:",
    `        return ${RADIX}(text, at + 2, stop, base, step)`,
  ];
}

function source(): string {
  const blocks = [
    storage(),
    arithmetic(),
    shifting(),
    floats(),
    assembling(),
    scanning(),
    radix(),
    reading(),
  ];
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

function readsNumberText(node: ASTNode): boolean {
  if (node === null || node === undefined) return false;
  if (node.type !== NodeType.CallExpression) return false;
  const callee = node.callee as ASTNode | undefined;
  if (callee === undefined) return false;
  if (callee.type === NodeType.Identifier) {
    const name = String(callee.name);
    return (
      name === PARSE_FLOAT_BUILTIN || name === PARSE_INT_BUILTIN || name === NUMBER_BUILTIN
    );
  }
  if (callee.type !== NodeType.MemberExpression || callee.computed === true) return false;
  const owner = callee.object as ASTNode | undefined;
  if (owner === undefined || owner.type !== NodeType.Identifier) return false;
  if (String(owner.name) !== NUMBER_BUILTIN) return false;
  const member = String(callee.property);
  return member === PARSE_FLOAT_BUILTIN || member === PARSE_INT_BUILTIN;
}

export function readsNumbers(roots: readonly ASTNode[]): boolean {
  return nodesMatching(roots, readsNumberText).length > 0;
}

export function parseNumberPrelude(roots: readonly ASTNode[], required: boolean): string {
  return required || readsNumbers(roots) ? source() : "";
}
