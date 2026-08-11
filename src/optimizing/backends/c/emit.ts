import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_PARAMETER,
  IR_PHI,
  IR_CONSTANT,
  IR_RETURN,
  IR_JUMP,
  IR_BRANCH,
  IR_NEG,
  IR_NOT,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_INT32_AND,
  IR_INT32_OR,
  IR_INT32_XOR,
  IR_INT32_NOT,
  IR_INT32_SHL,
  IR_INT32_SHR,
  IR_INT32_USHR,
  IR_INT32_COMPARE,
  IR_FLOAT64_COMPARE,
  IR_CALL_KNOWN_FUNCTION,
  IR_NEW_ARRAY,
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_ADD,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_CALL_BUILTIN,
  IR_LOAD_GLOBAL,
} from "../../ir/index.js";
import { buildDispatch } from "../../infra/dispatch.js";
import { AnalysisManager } from "../../infra/analysis-manager.js";
import { createAnalysisRegistry } from "../../analyses/index.js";
import {
  typeInferenceAnalysisId,
  type TypeInference,
} from "../../analyses/type-inference.js";
import {
  analyzeAotLegality,
  builtinOperandScalar,
  calleeSymbolName,
  AOT_CHAR_AT,
  AOT_INT_TO_STRING,
  type AotLegality,
  type AotStringBuffer,
} from "../../analyses/aot-legality.js";
import {
  builtinIntrinsicByName,
  qualifiedMethodName,
} from "../../metadata/builtin-methods.js";
import { SCALAR_INT32, SCALAR_STRING, type AotScalar } from "../../types/scalar.js";
import { INT32_DECIMAL_BYTES } from "../../machine/data.js";
import {
  cTypeOf,
  declarationOf,
  immutableDeclarationOf,
  prototypeOf,
  C_STRING,
  type CScalarType,
} from "../../target/c-types.js";
import {
  sanitizeSymbol,
  C_KEYWORDS,
  C_LIBRARY_NAMES,
} from "../../target/symbols.js";

export const C_HEADER_PREAMBLE =
  "#include <stdint.h>\n#include <string.h>\n#include <math.h>";
const C_STRING_SET = "tera_str_set";
const C_STRING_APPEND = "tera_str_append";
const C_STRING_BUFFER_PREFIX = "sb";

export const C_RUNTIME_SUPPORT = `static inline int32_t tera_i32_add(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a + (uint32_t)b);
}

static inline int32_t tera_i32_sub(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a - (uint32_t)b);
}

static inline int32_t tera_i32_mul(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a * (uint32_t)b);
}

static inline int32_t tera_i32_div(int32_t a, int32_t b) {
  return b == 0 || (a == INT32_MIN && b == -1) ? 0 : a / b;
}

static inline int32_t tera_i32_mod(int32_t a, int32_t b) {
  return b == 0 || (a == INT32_MIN && b == -1) ? 0 : a % b;
}

static inline int32_t tera_i32_neg(int32_t a) {
  return (int32_t)(0u - (uint32_t)a);
}

static inline int32_t tera_i32_shl(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a << ((uint32_t)b & 31u));
}

static inline int32_t tera_i32_shr(int32_t a, int32_t b) {
  return a >> ((uint32_t)b & 31u);
}

static inline double tera_u32_shr(int32_t a, int32_t b) {
  return (double)((uint32_t)a >> ((uint32_t)b & 31u));
}

static inline int32_t tera_to_i32(double value) {
  if (!isfinite(value)) return 0;
  double truncated = trunc(value);
  if (truncated >= -2147483648.0 && truncated <= 2147483647.0) return (int32_t)truncated;
  double wrapped = fmod(truncated, 4294967296.0);
  if (wrapped < 0.0) wrapped += 4294967296.0;
  if (wrapped >= 2147483648.0) wrapped -= 4294967296.0;
  return (int32_t)wrapped;
}

static inline char *tera_str_copy(char *dst, int32_t cap, const char *src, size_t at) {
  if (cap <= 0) return dst;
  size_t limit = (size_t)cap - 1u;
  while (at < limit && *src != '\\0') dst[at++] = *src++;
  dst[at] = '\\0';
  return dst;
}

static inline char *${C_STRING_SET}(char *dst, int32_t cap, const char *src) {
  return tera_str_copy(dst, cap, src, 0);
}

static inline char *${C_STRING_APPEND}(char *dst, int32_t cap, const char *src) {
  if (cap <= 0) return dst;
  size_t at = 0;
  size_t limit = (size_t)cap - 1u;
  while (at < limit && dst[at] != '\\0') at++;
  return tera_str_copy(dst, cap, src, at);
}`;

const C_BUILTIN_METHODS = new Map<string, CBuiltinMethod>([
  [
    qualifiedMethodName("Math", "abs"),
    {
      helper: "tera_math_abs",
      definition: `static inline double tera_math_abs(double v) {
  return v < 0.0 ? -v : v;
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "floor"),
    {
      helper: "tera_math_floor",
      definition: `static inline double tera_math_floor(double v) {
  return floor(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "ceil"),
    {
      helper: "tera_math_ceil",
      definition: `static inline double tera_math_ceil(double v) {
  return ceil(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "sqrt"),
    {
      helper: "tera_math_sqrt",
      definition: `static inline double tera_math_sqrt(double v) {
  return sqrt(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "trunc"),
    {
      helper: "tera_math_trunc",
      definition: `static inline double tera_math_trunc(double v) {
  return trunc(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "round"),
    {
      helper: "tera_math_round",
      definition: `static inline double tera_math_round(double v) {
  return floor(v + 0.5);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "min"),
    {
      helper: "tera_math_min",
      definition: `static inline double tera_math_min(double a, double b) {
  if (a != a || b != b) return a - a + (b - b);
  return a < b ? a : b;
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "max"),
    {
      helper: "tera_math_max",
      definition: `static inline double tera_math_max(double a, double b) {
  if (a != a || b != b) return a - a + (b - b);
  return a > b ? a : b;
}`,
    },
  ],
  [
    qualifiedMethodName("string", "char_code_at"),
    {
      helper: "tera_string_char_code_at",
      definition: `static inline int32_t tera_string_char_code_at(const char *value, int32_t index) {
  return index < 0 ? 0 : (int32_t)(unsigned char)value[index];
}`,
    },
  ],
  [
    qualifiedMethodName("string", "length"),
    {
      helper: "tera_string_length",
      definition: `static inline int32_t tera_string_length(const char *value) {
  return (int32_t)strlen(value);
}`,
    },
  ],
  [
    AOT_CHAR_AT,
    {
      helper: "tera_string_char_at",
      definition: `static inline char *tera_string_char_at(char *dst, int32_t cap, const char *src, int32_t index) {
  if (cap <= 0) return dst;
  if (cap < 2 || index < 0) {
    dst[0] = '\\0';
    return dst;
  }
  for (int32_t seen = 0; seen < index; seen++) {
    if (src[seen] == '\\0') {
      dst[0] = '\\0';
      return dst;
    }
  }
  dst[0] = src[index];
  dst[dst[0] == '\\0' ? 0 : 1] = '\\0';
  return dst;
}`,
    },
  ],
  [
    AOT_INT_TO_STRING,
    {
      helper: "tera_i32_to_str",
      definition: `static inline char *tera_i32_to_str(char *dst, int32_t cap, int32_t value) {
  if (cap <= 0) return dst;
  if (cap < ${INT32_DECIMAL_BYTES}) {
    dst[0] = '\\0';
    return dst;
  }
  uint32_t magnitude = value < 0 ? 0u - (uint32_t)value : (uint32_t)value;
  size_t at = 0;
  if (value < 0) dst[at++] = '-';
  size_t start = at;
  do {
    dst[at++] = (char)('0' + (magnitude % 10u));
    magnitude /= 10u;
  } while (magnitude != 0u);
  dst[at] = '\\0';
  for (size_t last = at - 1; start < last; start++, last--) {
    char swap = dst[start];
    dst[start] = dst[last];
    dst[last] = swap;
  }
  return dst;
}`,
    },
  ],
]);

const C_BUILTIN_SUPPORT = [...C_BUILTIN_METHODS.values()]
  .map((method) => method.definition)
  .join("\n\n");

export const C_SOURCE_PREAMBLE = `${C_HEADER_PREAMBLE}\n\n${C_RUNTIME_SUPPORT}\n\n${C_BUILTIN_SUPPORT}`;

export type CEmitResult =
  | {
      readonly ok: true;
      readonly symbol: string;
      readonly parameterCount: number;
      readonly parameterScalars: readonly AotScalar[];
      readonly returnScalar: AotScalar;
      readonly prototype: string;
      readonly source: string;
      readonly headerPreamble: string;
      readonly sourcePreamble: string;
      readonly translationUnitPreamble: string;
      readonly references: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const INT32_HELPERS = new Map<string, string>([
  [IR_INT32_ADD, "tera_i32_add"],
  [IR_INT32_SUB, "tera_i32_sub"],
  [IR_INT32_MUL, "tera_i32_mul"],
  [IR_INT32_DIV, "tera_i32_div"],
  [IR_INT32_MOD, "tera_i32_mod"],
  [IR_INT32_SHL, "tera_i32_shl"],
  [IR_INT32_SHR, "tera_i32_shr"],
  [IR_INT32_USHR, "tera_u32_shr"],
]);

const INT32_OPERATORS = new Map<string, string>([
  [IR_INT32_AND, "&"],
  [IR_INT32_OR, "|"],
  [IR_INT32_XOR, "^"],
]);

const FLOAT_OPERATORS = new Map<string, string>([
  [IR_FLOAT64_ADD, "+"],
  [IR_FLOAT64_SUB, "-"],
  [IR_FLOAT64_MUL, "*"],
  [IR_FLOAT64_DIV, "/"],
]);

const COMPARE_OPERATORS = new Map<string, string>([
  ["==", "=="],
  ["loose==", "=="],
  ["!=", "!="],
  ["loose!=", "!="],
  ["<", "<"],
  [">", ">"],
  ["<=", "<="],
  [">=", ">="],
]);

const SKIPPED_IN_BLOCK = new Set<string>([IR_PARAMETER, IR_PHI, IR_CONSTANT]);

const RESERVED_C_IDENTIFIERS = new Set<string>([
  ...C_KEYWORDS,
  ...C_LIBRARY_NAMES,
  ...INT32_HELPERS.values(),
  ...[...C_BUILTIN_METHODS.values()].map((method) => method.helper),
  "tera_i32_neg",
  "tera_to_i32",
]);

function formatDouble(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

export function cIdentifier(name: string): string {
  return sanitizeSymbol(name, RESERVED_C_IDENTIFIERS);
}

function cStringLiteral(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"' || character === "\\") out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

interface CBuiltinMethod {
  readonly helper: string;
  readonly definition: string;
}

interface EmitContext {
  readonly node: CFGInstruction;
  nameOf(value: CFGInstruction): string;
  emit(line: string): void;
  copyEdge(from: CFGBlock, to: CFGBlock): void;
  labelOf(block: CFGBlock): string;
}

class CFunctionEmitter {
  private readonly names = new Map<CFGInstruction, string>();
  private readonly bufferNames = new Map<AotStringBuffer, string>();
  private readonly blockPhis: CFGInstruction[] = [];
  private readonly constantDeclarations: string[] = [];
  private readonly references = new Set<string>();
  private readonly body: string[] = [];
  private readonly dispatch = buildDispatch<string, EmitContext>(this.handlers());
  private tempSeq = 0;

  constructor(
    private readonly graph: CFGFunction,
    private readonly legality: AotLegality,
  ) {}

  emit(): CEmitResult {
    this.assignNames();
    this.declareStringBuffers();
    this.declareConstants();
    for (const block of this.graph.blocks) this.emitBlock(block);

    const symbol = cIdentifier(this.graph.name);
    const signature = this.signature(symbol);
    return {
      ok: true,
      symbol,
      parameterCount: this.graph.parameters.length,
      parameterScalars: this.legality.parameterScalars,
      returnScalar: this.legality.returnScalar,
      prototype: `${signature};`,
      source: this.render(signature),
      headerPreamble: C_HEADER_PREAMBLE,
      sourcePreamble: C_SOURCE_PREAMBLE,
      translationUnitPreamble: `${C_RUNTIME_SUPPORT}\n\n${C_BUILTIN_SUPPORT}`,
      references: [...this.references],
    };
  }

  private typeNameOf(value: CFGInstruction): CScalarType {
    return cTypeOf(this.legality.scalarOf(value));
  }

  private isInt32(value: CFGInstruction): boolean {
    return this.legality.scalarOf(value) === SCALAR_INT32;
  }

  private assignNames(): void {
    for (const param of this.graph.parameters) {
      this.names.set(param, `p${Number(param.props.index)}`);
    }
    let phiSeq = 0;
    let valueSeq = 0;
    for (const constant of this.legality.constants) {
      this.names.set(constant, `v${valueSeq++}`);
    }
    for (const block of this.graph.blocks) {
      for (const phi of block.phis) {
        if (this.legality.arrayOf(phi) !== null) continue;
        this.names.set(phi, `b${phiSeq++}`);
        this.blockPhis.push(phi);
      }
      for (const node of block.nodes) {
        if (!this.names.has(node)) this.names.set(node, `v${valueSeq++}`);
      }
    }
  }

  private declareStringBuffers(): void {
    let sequence = 0;
    for (const buffer of this.legality.stringBuffers) {
      const name = `${C_STRING_BUFFER_PREFIX}${sequence++}`;
      this.bufferNames.set(buffer, name);
      this.constantDeclarations.push(`static char ${name}[${buffer.capacity}];`);
    }
  }

  private bufferNameOf(node: CFGInstruction): string {
    const buffer = this.legality.stringBufferOf(node);
    const name = buffer === null ? undefined : this.bufferNames.get(buffer);
    if (name === undefined) throw new Error(`no string buffer for v${node.id}`);
    return name;
  }

  private bufferCapacityOf(node: CFGInstruction): number {
    return this.legality.stringBufferOf(node)!.capacity;
  }

  private emitStringConcat(ctx: EmitContext): void {
    const name = this.bufferNameOf(ctx.node);
    const capacity = this.bufferCapacityOf(ctx.node);
    const left = this.nameOf(ctx.node.inputs[0]!);
    const right = this.nameOf(ctx.node.inputs[1]!);
    this.define(
      ctx,
      `${C_STRING_APPEND}(${C_STRING_SET}(${name}, ${capacity}, ${left}), ${capacity}, ${right})`,
    );
  }

  private declareConstants(): void {
    for (const constant of this.legality.constants) {
      const value = constant.props.value;
      const name = this.nameOf(constant);
      if (typeof value === "string") {
        this.constantDeclarations.push(
          `${declarationOf(C_STRING, name)} = ${cStringLiteral(value)};`,
        );
        continue;
      }
      const expression =
        typeof value === "boolean"
          ? value
            ? "1"
            : "0"
          : this.isInt32(constant)
            ? String(Number(value) | 0)
            : formatDouble(Number(value));
      this.constantDeclarations.push(
        `const ${declarationOf(this.typeNameOf(constant), name)} = ${expression};`,
      );
    }
  }

  private emitBlock(block: CFGBlock): void {
    if (block.predecessors.length > 0) this.body.push(`${this.labelOf(block)}:;`);
    for (const node of block.nodes) {
      if (SKIPPED_IN_BLOCK.has(node.type)) continue;
      if (!this.dispatch(node.type, this.contextFor(node))) {
        throw new Error(`C backend has no lowering for admitted opcode ${node.type}`);
      }
    }
  }

  private define(ctx: EmitContext, expression: string): void {
    ctx.emit(
      `${immutableDeclarationOf(this.typeNameOf(ctx.node), ctx.nameOf(ctx.node))} = ${expression};`,
    );
  }

  private asDouble(value: CFGInstruction): string {
    return `(double)${this.nameOf(value)}`;
  }

  private asInt32(value: CFGInstruction): string {
    return this.isInt32(value) ? this.nameOf(value) : `tera_to_i32(${this.nameOf(value)})`;
  }

  private handlers(): Array<readonly [string, (ctx: EmitContext) => void]> {
    const entries: Array<readonly [string, (ctx: EmitContext) => void]> = [];

    entries.push([IR_CALL_BUILTIN, (ctx) => this.emitBuiltinCall(ctx)]);
    entries.push([IR_GENERIC_ADD, (ctx) => this.emitStringConcat(ctx)]);
    entries.push([IR_CALL_KNOWN_FUNCTION, (ctx) => this.emitKnownCall(ctx)]);
    entries.push([IR_NEW_ARRAY, (ctx) => this.emitNewArray(ctx)]);
    entries.push([IR_LOAD_ELEMENT, (ctx) => this.emitLoadElement(ctx)]);
    entries.push([IR_GENERIC_GET_INDEX, (ctx) => this.emitLoadElement(ctx)]);
    entries.push([IR_STORE_ELEMENT, (ctx) => this.emitStoreElement(ctx)]);
    entries.push([IR_GENERIC_SET_INDEX, (ctx) => this.emitStoreElement(ctx)]);
    entries.push([IR_LOAD_ARRAY_LENGTH, (ctx) => this.emitArrayLength(ctx)]);
    entries.push([IR_NEG, (ctx) => this.emitNegate(ctx)]);
    entries.push([IR_NOT, (ctx) => this.emitLogicalNot(ctx)]);
    entries.push([IR_INT32_NOT, (ctx) => this.define(ctx, `~${this.asInt32(ctx.node.inputs[0]!)}`)]);
    entries.push([IR_INT32_COMPARE, (ctx) => this.emitCompare(ctx, false)]);
    entries.push([IR_FLOAT64_COMPARE, (ctx) => this.emitCompare(ctx, true)]);
    entries.push([IR_LOAD_GLOBAL, () => undefined]);
    entries.push([IR_RETURN, (ctx) => this.emitReturn(ctx)]);
    entries.push([IR_JUMP, (ctx) => this.emitJump(ctx)]);
    entries.push([IR_BRANCH, (ctx) => this.emitBranch(ctx)]);

    for (const [opcode, helper] of INT32_HELPERS) {
      entries.push([
        opcode,
        (ctx) =>
          this.define(
            ctx,
            `${helper}(${this.asInt32(ctx.node.inputs[0]!)}, ${this.asInt32(ctx.node.inputs[1]!)})`,
          ),
      ]);
    }
    for (const [opcode, operator] of INT32_OPERATORS) {
      entries.push([
        opcode,
        (ctx) =>
          this.define(
            ctx,
            `${this.asInt32(ctx.node.inputs[0]!)} ${operator} ${this.asInt32(ctx.node.inputs[1]!)}`,
          ),
      ]);
    }
    for (const [opcode, operator] of FLOAT_OPERATORS) {
      entries.push([
        opcode,
        (ctx) =>
          this.define(
            ctx,
            `${this.asDouble(ctx.node.inputs[0]!)} ${operator} ${this.asDouble(ctx.node.inputs[1]!)}`,
          ),
      ]);
    }

    return entries;
  }

  private emitBuiltinCall(ctx: EmitContext): void {
    const name = String(ctx.node.props.name);
    const method = C_BUILTIN_METHODS.get(name);
    const intrinsic = builtinIntrinsicByName(name);
    if (method === undefined || intrinsic === null) {
      throw new Error(`C backend has no helper for admitted builtin ${name}`);
    }
    const operands = ctx.node.inputs.map((input, index) => {
      const expected = builtinOperandScalar(intrinsic.signature.params[index] ?? null);
      if (expected === SCALAR_INT32) return this.asInt32(input);
      if (expected === SCALAR_STRING) return this.nameOf(input);
      return this.asDouble(input);
    });
    if (this.legality.stringBufferOf(ctx.node)?.producer === ctx.node) {
      operands.unshift(this.bufferNameOf(ctx.node), String(this.bufferCapacityOf(ctx.node)));
    }
    this.define(ctx, `${method.helper}(${operands.join(", ")})`);
  }

  private emitKnownCall(ctx: EmitContext): void {
    const callee = cIdentifier(calleeSymbolName(ctx.node)!);
    this.references.add(callee);
    const args = ctx.node.inputs.map((input) => this.nameOf(input)).join(", ");
    if (ctx.node.uses.length === 0) ctx.emit(`${callee}(${args});`);
    else this.define(ctx, `${callee}(${args})`);
  }

  private emitNewArray(ctx: EmitContext): void {
    const element = cTypeOf(this.legality.arrayOf(ctx.node)!.element);
    const elements = ctx.node.inputs.map((input) => this.nameOf(input)).join(", ");
    const count = ctx.node.inputs.length;
    const name = ctx.nameOf(ctx.node);
    ctx.emit(
      count === 0
        ? `${element} ${name}[1] = {0};`
        : `${element} ${name}[${count}] = {${elements}};`,
    );
  }

  private emitLoadElement(ctx: EmitContext): void {
    const array = ctx.node.inputs[0]!;
    const index = ctx.node.inputs[1]!;
    this.define(ctx, `${this.nameOf(array)}[${this.asInt32(index)}]`);
  }

  private emitStoreElement(ctx: EmitContext): void {
    const array = ctx.node.inputs[0]!;
    const index = ctx.node.inputs[1]!;
    const value = ctx.node.inputs[2]!;
    const store = `${this.nameOf(array)}[${this.asInt32(index)}] = ${this.nameOf(value)}`;
    if (ctx.node.uses.length === 0) ctx.emit(`${store};`);
    else this.define(ctx, `(${store})`);
  }

  private emitArrayLength(ctx: EmitContext): void {
    this.define(ctx, String(this.legality.arrayOf(ctx.node.inputs[0]!)!.length));
  }

  private emitNegate(ctx: EmitContext): void {
    const operand = ctx.node.inputs[0]!;
    this.define(
      ctx,
      this.isInt32(ctx.node)
        ? `tera_i32_neg(${this.asInt32(operand)})`
        : `-${this.asDouble(operand)}`,
    );
  }

  private emitLogicalNot(ctx: EmitContext): void {
    this.define(ctx, `${this.nameOf(ctx.node.inputs[0]!)} == 0`);
  }

  private emitCompare(ctx: EmitContext, asDouble: boolean): void {
    const operator = COMPARE_OPERATORS.get(String(ctx.node.props.op));
    if (operator === undefined) {
      throw new Error(`C backend has no lowering for comparison ${String(ctx.node.props.op)}`);
    }
    const left = ctx.node.inputs[0]!;
    const right = ctx.node.inputs[1]!;
    const lhs = asDouble ? this.asDouble(left) : this.nameOf(left);
    const rhs = asDouble ? this.asDouble(right) : this.nameOf(right);
    this.define(ctx, `${lhs} ${operator} ${rhs}`);
  }

  private emitReturn(ctx: EmitContext): void {
    ctx.emit(`return ${this.nameOf(ctx.node.inputs[0]!)};`);
  }

  private emitJump(ctx: EmitContext): void {
    const target = this.successorByProp(ctx.node.block!, "targetBlock");
    ctx.copyEdge(ctx.node.block!, target);
    ctx.emit(`goto ${ctx.labelOf(target)};`);
  }

  private emitBranch(ctx: EmitContext): void {
    const source = ctx.node.block!;
    const trueBlock = this.successorByProp(source, "trueBlock");
    const falseBlock = this.successorByProp(source, "falseBlock");
    ctx.emit(`if (${this.nameOf(ctx.node.inputs[0]!)} != 0) {`);
    ctx.copyEdge(source, trueBlock);
    ctx.emit(`goto ${ctx.labelOf(trueBlock)};`);
    ctx.emit(`} else {`);
    ctx.copyEdge(source, falseBlock);
    ctx.emit(`goto ${ctx.labelOf(falseBlock)};`);
    ctx.emit(`}`);
  }

  private successorByProp(block: CFGBlock, prop: string): CFGBlock {
    const terminator = block.getTerminator()!;
    const targetId = terminator.props[prop];
    for (const successor of block.successors) {
      if (successor.id === targetId) return successor;
    }
    throw new Error(`block ${block.id} has no successor for ${prop}`);
  }

  private copyEdge(from: CFGBlock, to: CFGBlock): void {
    const phis = to.phis.filter((phi) => this.legality.arrayOf(phi) === null);
    if (phis.length === 0) return;
    const predIndex = to.predecessors.indexOf(from);
    if (predIndex < 0) {
      throw new Error(`edge B${from.id}->B${to.id} is not a predecessor edge`);
    }
    const temps: string[] = [];
    for (const phi of phis) {
      const temp = `t${this.tempSeq++}`;
      temps.push(temp);
      this.body.push(
        `${immutableDeclarationOf(this.typeNameOf(phi), temp)} = ${this.nameOf(phi.inputs[predIndex]!)};`,
      );
    }
    for (let i = 0; i < phis.length; i++) {
      this.body.push(`${this.nameOf(phis[i]!)} = ${temps[i]!};`);
    }
  }

  private contextFor(node: CFGInstruction): EmitContext {
    return {
      node,
      nameOf: (value) => this.nameOf(value),
      emit: (line) => this.body.push(line),
      copyEdge: (from, to) => this.copyEdge(from, to),
      labelOf: (block) => this.labelOf(block),
    };
  }

  private nameOf(value: CFGInstruction): string {
    const array = this.legality.arrayOf(value);
    if (array !== null && array.allocation !== value) return this.nameOf(array.allocation);
    return this.names.get(value) ?? `v${value.id}`;
  }

  private labelOf(block: CFGBlock): string {
    return `L${block.id}`;
  }

  private signature(symbol: string): string {
    return prototypeOf(symbol, this.legality.returnScalar, this.legality.parameterScalars);
  }

  private render(signature: string): string {
    const declarations: string[] = [];
    for (const phi of this.blockPhis) {
      declarations.push(`  ${declarationOf(this.typeNameOf(phi), this.nameOf(phi))};`);
    }
    for (const declaration of this.constantDeclarations) {
      declarations.push(`  ${declaration}`);
    }
    const unusedParams = this.graph.parameters
      .filter((param) => param.uses.length === 0)
      .map((param) => `  (void)p${Number(param.props.index)};`);
    const statements = this.body.map((line) =>
      line.endsWith(":;") ? line : `  ${line}`,
    );
    const lines = [...declarations, ...unusedParams, ...statements];
    const bodyText = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    return `${C_SOURCE_PREAMBLE}\n\n${signature} {\n${bodyText}}\n`;
  }
}

function inferTypes(graph: CFGFunction): TypeInference {
  return new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId);
}

export function emitNumericFunction(
  graph: CFGFunction,
  types: TypeInference = inferTypes(graph),
): CEmitResult {
  const legality = analyzeAotLegality(graph, types);
  if (!legality.ok) return { ok: false, reason: legality.reason };
  return new CFunctionEmitter(graph, legality.legality).emit();
}
