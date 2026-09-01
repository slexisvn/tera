import { astChildren, Identifier, Literal, NodeType, type ASTNode } from "../../frontend/ast/index.js";

export const FIXED_TEXT_MEMBER = "to_fixed";
export const FIXED_TEXT_FUNCTION = "_fixed_text";
export const FIXED_DIGITS_CLASS = "_FixedDigits";
export const FIXED_FORMAT_METHOD = "format";

const TEXT_CLASS = "_FixedText";
const DIV = "div";
const MOD = "mod";
const CELLS = "cells";
const COUNT = "count";
const TEXT_FIELD = "text";
const ADD = "add";
const PUT = "put";
const TRIM = "trim";
const SCALE = "scale";
const BUMP = "bump";
const DIGIT = "digit";
const WIDTH = "width";
const LOAD = "load";
const SHRINK = "shrink";
const RENDER = "render";

const LIMB_DIGITS = 4;
const LIMB_BASE = 10 ** LIMB_DIGITS;
const CHUNK_BITS = 16;
const CHUNK_BASE = 2 ** CHUNK_BITS;
const MANTISSA_BITS = 53;
const CHUNK_COUNT = Math.ceil(MANTISSA_BITS / CHUNK_BITS);
const MANTISSA_LIMIT = 2 ** MANTISSA_BITS;
const FIVE_STEP = 6;
const FIVE_FACTOR = 5 ** FIVE_STEP;
const HALF_DIGIT = 5;
const MOST_DIGITS = 100;
const SHORTEST_TEXT_LIMIT = 1e21;
const RANGE_FAULT = `toFixed() digits argument must be between 0 and ${MOST_DIGITS}`;

const NOT_A_NUMBER_TEXT = "NaN";
const INFINITY_TEXT = "Infinity";
const NEGATIVE_INFINITY_TEXT = `-${INFINITY_TEXT}`;

function float(value: number): string {
  const spelled = String(value).replace("e+", "e");
  return spelled.includes(".") || spelled.includes("e") ? spelled : `${spelled}.0`;
}

function textClass(): readonly string[] {
  return [
    `class ${TEXT_CLASS}:`,
    `  public ${TEXT_FIELD}: string`,
    "  public constructor():",
    `    this.${TEXT_FIELD} = ""`,
    `  public ${ADD}(piece: string) -> void:`,
    `    this.${TEXT_FIELD} = this.${TEXT_FIELD} + piece`,
  ];
}

function storage(): readonly string[] {
  return [
    `class ${FIXED_DIGITS_CLASS}:`,
    `  public ${CELLS}: int[]`,
    `  public ${COUNT}: int`,
    "  public constructor():",
    `    this.${CELLS} = []`,
    `    this.${COUNT} = 0`,
    `  public ${DIV}(value: int, by: int) -> int:`,
    "    return Math.floor(value / by)",
    `  public ${MOD}(value: int, by: int) -> int:`,
    "    return value % by",
    `  public ${PUT}(index: int, value: int) -> void:`,
    `    while this.${CELLS}.length <= index:`,
    `      this.${CELLS}.push(0)`,
    `    this.${CELLS}[index] = value`,
    `  public ${TRIM}() -> void:`,
    `    while this.${COUNT} > 0 and this.${CELLS}[this.${COUNT} - 1] == 0:`,
    `      this.${COUNT} -= 1`,
  ];
}

function arithmetic(): readonly string[] {
  return [
    `  public ${SCALE}(factor: int) -> void:`,
    "    carry: int = 0",
    "    i: int = 0",
    `    while i < this.${COUNT}:`,
    `      product: int = this.${CELLS}[i] * factor + carry`,
    `      this.${PUT}(i, this.${MOD}(product, ${LIMB_BASE}))`,
    `      carry = this.${DIV}(product, ${LIMB_BASE})`,
    "      i += 1",
    "    while carry > 0:",
    `      this.${PUT}(this.${COUNT}, this.${MOD}(carry, ${LIMB_BASE}))`,
    `      this.${COUNT} += 1`,
    `      carry = this.${DIV}(carry, ${LIMB_BASE})`,
    `  public ${BUMP}(value: int) -> void:`,
    "    carry: int = value",
    "    i: int = 0",
    "    while carry > 0:",
    `      if i >= this.${COUNT}:`,
    `        this.${PUT}(this.${COUNT}, 0)`,
    `        this.${COUNT} += 1`,
    `      total: int = this.${CELLS}[i] + carry`,
    `      this.${PUT}(i, this.${MOD}(total, ${LIMB_BASE}))`,
    `      carry = this.${DIV}(total, ${LIMB_BASE})`,
    "      i += 1",
    `  public ${SHRINK}(drop: int) -> void:`,
    `    whole: int = this.${DIV}(drop, ${LIMB_DIGITS})`,
    `    if whole >= this.${COUNT}:`,
    `      this.${COUNT} = 0`,
    "      return",
    "    i: int = 0",
    `    while i + whole < this.${COUNT}:`,
    `      this.${PUT}(i, this.${CELLS}[i + whole])`,
    "      i += 1",
    `    this.${COUNT} -= whole`,
    "    scale: int = 1",
    "    i = 0",
    `    while i < this.${MOD}(drop, ${LIMB_DIGITS}):`,
    "      scale = scale * 10",
    "      i += 1",
    "    if scale == 1:",
    `      this.${TRIM}()`,
    "      return",
    "    carry: int = 0",
    `    i = this.${COUNT} - 1`,
    "    while i >= 0:",
    `      current: int = carry * ${LIMB_BASE} + this.${CELLS}[i]`,
    `      this.${PUT}(i, this.${DIV}(current, scale))`,
    `      carry = this.${MOD}(current, scale)`,
    "      i -= 1",
    `    this.${TRIM}()`,
  ];
}

function reading(): readonly string[] {
  const widths: string[] = [];
  for (let digits = LIMB_DIGITS; digits > 1; digits--) {
    widths.push(
      `    ${widths.length === 0 ? "if" : "else if"} top >= ${10 ** (digits - 1)}:`,
      `      extra = ${digits}`,
    );
  }
  return [
    `  public ${DIGIT}(index: int) -> int:`,
    `    limb: int = this.${DIV}(index, ${LIMB_DIGITS})`,
    `    if limb >= this.${COUNT}:`,
    "      return 0",
    `    value: int = this.${CELLS}[limb]`,
    `    step: int = this.${MOD}(index, ${LIMB_DIGITS})`,
    "    i: int = 0",
    "    while i < step:",
    `      value = this.${DIV}(value, 10)`,
    "      i += 1",
    `    return this.${MOD}(value, 10)`,
    `  public ${WIDTH}() -> int:`,
    `    if this.${COUNT} <= 0:`,
    "      return 1",
    `    top: int = this.${CELLS}[this.${COUNT} - 1]`,
    "    extra: int = 1",
    ...widths,
    `    return (this.${COUNT} - 1) * ${LIMB_DIGITS} + extra`,
  ];
}

function loading(): readonly string[] {
  return [
    `  public ${LOAD}(mantissa: float) -> void:`,
    `    chunks: int[] = [${new Array(CHUNK_COUNT).fill("0").join(", ")}]`,
    "    rest: float = mantissa",
    "    i: int = 0",
    `    while i < ${CHUNK_COUNT}:`,
    `      whole: float = Math.floor(rest / ${float(CHUNK_BASE)})`,
    `      chunks[i] = Math.floor(rest - whole * ${float(CHUNK_BASE)})`,
    "      rest = whole",
    "      i += 1",
    `    this.${COUNT} = 0`,
    `    i = ${CHUNK_COUNT - 1}`,
    "    while i >= 0:",
    `      this.${SCALE}(${CHUNK_BASE})`,
    `      this.${BUMP}(chunks[i])`,
    "      i -= 1",
  ];
}

function rendering(): readonly string[] {
  return [
    `  public ${RENDER}(sign: string, digits: int) -> string:`,
    `    out = ${TEXT_CLASS}()`,
    `    out.${ADD}(sign)`,
    `    place: int = this.${WIDTH}() - 1`,
    "    if place < digits:",
    "      place = digits",
    "    while place >= 0:",
    `      out.${ADD}(this.${DIGIT}(place).to_string())`,
    "      if place == digits and digits > 0:",
    `        out.${ADD}(".")`,
    "      place -= 1",
    `    return out.${TEXT_FIELD}`,
  ];
}

function formatting(): readonly string[] {
  return [
    `  public ${FIXED_FORMAT_METHOD}(value: float, digits: int) -> string:`,
    `    if digits < 0 or digits > ${MOST_DIGITS}:`,
    `      throw "${RANGE_FAULT}"`,
    "    if value != value:",
    `      return "${NOT_A_NUMBER_TEXT}"`,
    `    if value > ${float(Number.MAX_VALUE)}:`,
    `      return "${INFINITY_TEXT}"`,
    `    if value < -${float(Number.MAX_VALUE)}:`,
    `      return "${NEGATIVE_INFINITY_TEXT}"`,
    `    sign: string = ""`,
    "    x: float = value",
    "    if x < 0.0:",
    `      sign = "-"`,
    "      x = 0.0 - x",
    `    if x >= ${float(SHORTEST_TEXT_LIMIT)}:`,
    "      return sign + x.to_string()",
    "    mantissa: float = x",
    "    exponent: int = 0",
    "    while mantissa != Math.floor(mantissa):",
    "      mantissa = mantissa * 2.0",
    "      exponent -= 1",
    `    while mantissa >= ${float(MANTISSA_LIMIT)}:`,
    "      mantissa = mantissa / 2.0",
    "      exponent += 1",
    `    this.${LOAD}(mantissa)`,
    "    point: int = 0",
    "    i: int = 0",
    "    if exponent > 0:",
    "      while i < exponent:",
    `        this.${SCALE}(2)`,
    "        i += 1",
    "    else:",
    "      point = 0 - exponent",
    `      while i + ${FIVE_STEP} <= point:`,
    `        this.${SCALE}(${FIVE_FACTOR})`,
    `        i += ${FIVE_STEP}`,
    "      while i < point:",
    `        this.${SCALE}(5)`,
    "        i += 1",
    `    this.${TRIM}()`,
    "    drop: int = point - digits",
    "    if drop <= 0:",
    "      i = 0",
    "      while i < 0 - drop:",
    `        this.${SCALE}(10)`,
    "        i += 1",
    "    else:",
    `      carried: int = this.${DIGIT}(drop - 1)`,
    `      this.${SHRINK}(drop)`,
    `      if carried >= ${HALF_DIGIT}:`,
    `        this.${BUMP}(1)`,
    `    this.${TRIM}()`,
    `    return this.${RENDER}(sign, digits)`,
  ];
}

function source(): string {
  return `${[
    ...textClass(),
    "",
    ...storage(),
    ...arithmetic(),
    ...reading(),
    ...loading(),
    ...rendering(),
    ...formatting(),
    "",
    `fn ${FIXED_TEXT_FUNCTION}(value: float, digits: int) -> string:`,
    `  return ${FIXED_DIGITS_CLASS}().${FIXED_FORMAT_METHOD}(value, digits)`,
  ].join("\n")}\n`;
}

function callsMember(node: ASTNode): boolean {
  if (node === null || node === undefined) return false;
  if (node.type !== NodeType.CallExpression) return false;
  const callee = node.callee as ASTNode | undefined;
  if (callee === undefined || callee.type !== NodeType.MemberExpression) return false;
  return callee.computed !== true && callee.property === FIXED_TEXT_MEMBER;
}

function declaresMember(node: ASTNode): boolean {
  if (node === null || node === undefined) return false;
  if (node.type !== NodeType.ClassDeclaration) return false;
  const methods = (node.methods ?? []) as { name?: string | null }[];
  return methods.some((method) => method.name === FIXED_TEXT_MEMBER);
}

function sitesIn(node: ASTNode, found: ASTNode[]): ASTNode[] {
  if (node === null || node === undefined) return found;
  if (callsMember(node)) found.push(node);
  for (const child of astChildren(node)) sitesIn(child, found);
  return found;
}

function declaresAnywhere(node: ASTNode): boolean {
  if (node === null || node === undefined) return false;
  return declaresMember(node) || astChildren(node).some(declaresAnywhere);
}

function callSites(roots: readonly ASTNode[]): readonly ASTNode[] {
  if (roots.some(declaresAnywhere)) return [];
  const found: ASTNode[] = [];
  for (const root of roots) sitesIn(root, found);
  return found;
}

export function fixedTextPrelude(roots: readonly ASTNode[]): string {
  return callSites(roots).length === 0 ? "" : source();
}

export function rewriteFixedTexts(roots: readonly ASTNode[]): number {
  const sites = callSites(roots);
  for (const site of sites) {
    const callee = site.callee as ASTNode;
    const given = (site.args as ASTNode[]) ?? [];
    site.args = [callee.object as ASTNode, ...(given.length === 0 ? [Literal(0, "number")] : given)];
    site.callee = Identifier(FIXED_TEXT_FUNCTION);
  }
  return sites.length;
}
