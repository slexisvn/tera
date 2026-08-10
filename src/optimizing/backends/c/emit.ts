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
  IR_GENERIC_GET_PROP,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_GENERIC_CALL,
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
import { latticeFromDeclaredType } from "../../types/declared.js";
import {
  builtinMethodIntrinsicByName,
  qualifiedMethodName,
} from "../../metadata/builtin-methods.js";
import { joinTypes, TypeKind, type LatticeType } from "../../types/lattice.js";
import {
  cElementType,
  cScalarType,
  declarationOf,
  C_DOUBLE,
  C_INT32,
  C_STRING,
  type CScalarType,
} from "./ctype.js";

export const C_HEADER_PREAMBLE =
  "#include <stdint.h>\n#include <string.h>\n#include <math.h>";
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
}`;

const C_BUILTIN_METHODS = new Map<string, CBuiltinMethod>([
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
]);

const C_BUILTIN_SUPPORT = [...C_BUILTIN_METHODS.values()]
  .map((method) => method.definition)
  .join("\n\n");

export const C_SOURCE_PREAMBLE = `${C_HEADER_PREAMBLE}\n\n${C_RUNTIME_SUPPORT}\n\n${C_BUILTIN_SUPPORT}`;

export type CEmitResult =
  | {
      readonly ok: true;
      readonly symbol: string;
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

const ARRAY_OPS = new Set<string>([
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
]);

const SKIPPED_IN_BLOCK = new Set<string>([IR_PARAMETER, IR_PHI, IR_CONSTANT]);

const C_KEYWORDS = [
  "auto", "break", "case", "char", "const", "continue", "default", "do",
  "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline",
  "int", "long", "register", "restrict", "return", "short", "signed", "sizeof",
  "static", "struct", "switch", "typedef", "union", "unsigned", "void",
  "volatile", "while",
];

const C_LIBRARY_NAMES = [
  "main", "printf", "strlen", "trunc", "fmod", "isfinite", "memcpy",
];

const RESERVED_C_IDENTIFIERS = new Set<string>([
  ...C_KEYWORDS,
  ...C_LIBRARY_NAMES,
  ...INT32_HELPERS.values(),
  ...[...C_BUILTIN_METHODS.values()].map((method) => method.helper),
  "tera_i32_neg",
  "tera_to_i32",
]);

const RESERVED_PREFIX = "tera_";

const ASCII_LIMIT = 0x7f;

function formatDouble(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

export function cIdentifier(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  const identifier = /^[A-Za-z_]/.test(sanitized) ? sanitized : `fn_${sanitized}`;
  return RESERVED_C_IDENTIFIERS.has(identifier)
    ? `${RESERVED_PREFIX}${identifier}`
    : identifier;
}

function cStringLiteral(value: string): string | null {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code > ASCII_LIMIT) return null;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function calleeSymbol(node: CFGInstruction): string | null {
  const target = node.props.target as { name?: unknown } | undefined;
  return typeof target?.name === "string" ? cIdentifier(target.name) : null;
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
  fail(reason: string): void;
}

class CFunctionEmitter {
  private readonly names = new Map<CFGInstruction, string>();
  private readonly blockPhis: CFGInstruction[] = [];
  private readonly constants: CFGInstruction[] = [];
  private readonly constantDeclarations: string[] = [];
  private readonly references = new Set<string>();
  private readonly arrayLength = new Map<CFGInstruction, number>();
  private readonly arrayAlias = new Map<CFGInstruction, CFGInstruction>();
  private readonly body: string[] = [];
  private readonly dispatch = buildDispatch<string, EmitContext>(this.handlers());
  private tempSeq = 0;
  private returnCount = 0;
  private failure: string | null = null;

  constructor(
    private readonly graph: CFGFunction,
    private readonly types: TypeInference,
  ) {}

  emit(): CEmitResult {
    if (this.graph.bailout !== null) return this.bail(`graph bailed: ${this.graph.bailout}`);
    this.graph.rebuildUses();
    const entry = this.graph.entry;
    if (entry === null) return this.bail("function has no entry block");
    if (entry !== this.graph.blocks[0]) return this.bail("entry is not the first block");
    if (entry.phis.length > 0) return this.bail("entry block has phis");

    this.recordArrays();
    if (this.failure !== null) return this.bail(this.failure);
    this.recordConstants();
    this.assignNames();
    this.declareConstants();
    if (this.failure !== null) return this.bail(this.failure);

    for (const block of this.graph.blocks) {
      if (this.failure !== null) return this.bail(this.failure);
      this.emitBlock(block);
    }
    if (this.failure !== null) return this.bail(this.failure);
    if (this.returnCount === 0) return this.bail("function has no return");

    const returnType = this.returnType();
    if (returnType === null) return this.bail("function has an unsupported return type");

    const symbol = cIdentifier(this.graph.name);
    const signature = this.signature(symbol, returnType);
    if (signature === null) return this.bail("function has an unsupported parameter type");
    return {
      ok: true,
      symbol,
      prototype: `${signature};`,
      source: this.render(signature),
      headerPreamble: C_HEADER_PREAMBLE,
      sourcePreamble: C_SOURCE_PREAMBLE,
      translationUnitPreamble: `${C_RUNTIME_SUPPORT}\n\n${C_BUILTIN_SUPPORT}`,
      references: [...this.references],
    };
  }

  private typeOf(value: CFGInstruction): LatticeType {
    return this.types.typeOf(value);
  }

  private scalarOf(value: CFGInstruction): CScalarType | null {
    return cScalarType(this.typeOf(value));
  }

  private isInt32(value: CFGInstruction): boolean {
    return this.scalarOf(value) === C_INT32;
  }

  private returnType(): CScalarType | null {
    const declared = this.graph.declaredSignature?.returns;
    if (declared !== null && declared !== undefined) {
      const scalar = cScalarType(latticeFromDeclaredType(declared));
      if (scalar !== null) return scalar;
    }
    let merged: LatticeType | null = null;
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        const returned = node.type === IR_RETURN ? node.inputs[0] : undefined;
        if (returned !== undefined) merged = joinTypes(merged, this.typeOf(returned));
      }
    }
    return merged === null ? C_DOUBLE : cScalarType(merged);
  }

  private assignNames(): void {
    for (const param of this.graph.parameters) {
      this.names.set(param, `p${Number(param.props.index)}`);
    }
    let phiSeq = 0;
    let valueSeq = 0;
    for (const constant of this.constants) {
      this.names.set(constant, `v${valueSeq++}`);
    }
    for (const block of this.graph.blocks) {
      for (const phi of block.phis) {
        if (this.arrayAlias.has(phi)) continue;
        this.names.set(phi, `b${phiSeq++}`);
        this.blockPhis.push(phi);
      }
      for (const node of block.nodes) {
        if (!this.names.has(node)) this.names.set(node, `v${valueSeq++}`);
      }
    }
  }

  private recordConstants(): void {
    const seen = new Set<CFGInstruction>();
    const visit = (value: CFGInstruction | null | undefined): void => {
      if (!value || value.type !== IR_CONSTANT || seen.has(value)) return;
      seen.add(value);
      this.constants.push(value);
    };
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        visit(node);
        for (const input of node.inputs) visit(input);
      }
    }
  }

  private declareConstants(): void {
    for (const constant of this.constants) {
      const declaration = this.constantDeclaration(constant);
      if (declaration === null) return;
      this.constantDeclarations.push(declaration);
    }
  }

  private recordArrays(): void {
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_NEW_ARRAY) continue;
        this.arrayLength.set(node, node.inputs.length);
        if (!this.recordArrayUses(node)) return;
      }
    }
  }

  private recordArrayUses(array: CFGInstruction): boolean {
    const aliases = new Set<CFGInstruction>([array]);
    const pending: CFGInstruction[] = [array];
    while (pending.length > 0) {
      for (const use of pending.pop()!.uses) {
        if (use.type !== IR_PHI || aliases.has(use)) continue;
        aliases.add(use);
        pending.push(use);
      }
    }

    for (const value of aliases) {
      if (value.type === IR_PHI && !value.inputs.every((input) => aliases.has(input))) {
        this.failure = `array escapes to ${IR_PHI}`;
        return false;
      }
      for (const use of value.uses) {
        if (use.type === IR_PHI) continue;
        if (!ARRAY_OPS.has(use.type) || !aliases.has(use.inputs[0]!)) {
          this.failure = `array escapes to ${use.type}`;
          return false;
        }
      }
    }

    for (const value of aliases) {
      if (value !== array) this.arrayAlias.set(value, array);
    }
    return true;
  }

  private arrayOf(value: CFGInstruction): CFGInstruction {
    return this.arrayAlias.get(value) ?? value;
  }

  private emitBlock(block: CFGBlock): void {
    if (block.predecessors.length > 0) this.body.push(`${this.labelOf(block)}:;`);

    let terminated = false;
    for (const node of block.nodes) {
      if (this.failure !== null) return;
      if (SKIPPED_IN_BLOCK.has(node.type)) continue;
      const handled = this.dispatch(node.type, this.contextFor(node));
      if (!handled) {
        this.failure = `unsupported opcode ${node.type}`;
        return;
      }
      if (node.type === IR_RETURN || node.type === IR_JUMP || node.type === IR_BRANCH) {
        terminated = true;
      }
    }
    if (this.failure === null && !terminated && this.returnCount === 0) {
      this.failure = "function has no return";
    } else if (this.failure === null && !terminated) {
      this.failure = `block ${block.id} has no terminator`;
    }
  }

  private define(ctx: EmitContext, expression: string): void {
    const scalar = this.scalarOf(ctx.node);
    if (scalar === null) {
      ctx.fail(`value has an unsupported type in ${ctx.node.type}`);
      return;
    }
    ctx.emit(`const ${declarationOf(scalar, ctx.nameOf(ctx.node))} = ${expression};`);
  }

  private asDouble(value: CFGInstruction): string {
    return `(double)${this.nameOf(value)}`;
  }

  private asInt32(value: CFGInstruction): string {
    return this.isInt32(value) ? this.nameOf(value) : `tera_to_i32(${this.nameOf(value)})`;
  }

  private handlers(): Array<readonly [string, (ctx: EmitContext) => void]> {
    const entries: Array<readonly [string, (ctx: EmitContext) => void]> = [];

    entries.push([IR_GENERIC_GET_PROP, (ctx) => this.emitMember(ctx)]);
    entries.push([IR_GENERIC_CALL, (ctx) => ctx.fail("unsupported generic call")]);
    entries.push([IR_CALL_BUILTIN, (ctx) => this.emitBuiltinCall(ctx)]);
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
    entries.push([IR_LOAD_GLOBAL, (ctx) => this.emitGlobal(ctx)]);
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

  private constantDeclaration(node: CFGInstruction): string | null {
    const value = node.props.value;
    const name = this.nameOf(node);
    if (typeof value === "string") {
      const literal = cStringLiteral(value);
      if (literal === null) {
        this.failure = "string constant is not representable as ASCII";
        return null;
      }
      return `${declarationOf(C_STRING, name)} = ${literal};`;
    }
    const scalar = this.scalarOf(node);
    if (scalar === null) {
      this.failure = `value has an unsupported type in ${node.type}`;
      return null;
    }
    const expression = this.constantExpression(node, value);
    if (expression === null) return null;
    return `const ${declarationOf(scalar, name)} = ${expression};`;
  }

  private constantExpression(node: CFGInstruction, value: unknown): string | null {
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.failure = `unsupported constant ${String(value)}`;
      return null;
    }
    return this.isInt32(node) ? String(value | 0) : formatDouble(value);
  }

  private emitMember(ctx: EmitContext): void {
    ctx.fail(`unsupported property ${String(ctx.node.props.propName)}`);
  }

  private emitBuiltinCall(ctx: EmitContext): void {
    const name = String(ctx.node.props.name);
    const method = C_BUILTIN_METHODS.get(name);
    const intrinsic = builtinMethodIntrinsicByName(name);
    if (method === undefined || intrinsic === null) {
      ctx.fail(`unsupported builtin ${name}`);
      return;
    }
    const operands: string[] = [];
    for (let index = 0; index < ctx.node.inputs.length; index++) {
      const operand = this.builtinOperand(
        ctx.node.inputs[index]!,
        intrinsic.signature.params[index] ?? null,
      );
      if (operand === null) {
        ctx.fail(`${name} has an unsupported argument type`);
        return;
      }
      operands.push(operand);
    }
    this.define(ctx, `${method.helper}(${operands.join(", ")})`);
  }

  private builtinOperand(input: CFGInstruction, declared: string | null): string | null {
    const expected = cScalarType(latticeFromDeclaredType(declared));
    if (expected === C_INT32) return this.asInt32(input);
    if (expected === C_DOUBLE) return this.asDouble(input);
    if (expected === C_STRING && this.scalarOf(input) === C_STRING) {
      return this.nameOf(input);
    }
    return null;
  }

  private emitKnownCall(ctx: EmitContext): void {
    const callee = calleeSymbol(ctx.node);
    if (callee === null) {
      ctx.fail("call to a function without a resolvable name");
      return;
    }
    this.references.add(callee);
    const args = ctx.node.inputs.map((input) => this.nameOf(input)).join(", ");
    if (ctx.node.uses.length === 0) ctx.emit(`${callee}(${args});`);
    else this.define(ctx, `${callee}(${args})`);
  }

  private emitNewArray(ctx: EmitContext): void {
    const element = cElementType(this.typeOf(ctx.node));
    if (element === null || element === C_STRING) {
      ctx.fail("array has an unsupported element type");
      return;
    }
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
    const length = this.arrayLength.get(this.arrayOf(ctx.node.inputs[0]!));
    if (length === undefined) {
      ctx.fail("array length of an unsupported array");
      return;
    }
    this.define(ctx, String(length));
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
    const operand = ctx.node.inputs[0]!;
    this.define(ctx, `${this.nameOf(operand)} == 0`);
  }

  private emitCompare(ctx: EmitContext, asDouble: boolean): void {
    const operator = COMPARE_OPERATORS.get(String(ctx.node.props.op));
    if (operator === undefined) {
      ctx.fail(`unsupported comparison ${String(ctx.node.props.op)}`);
      return;
    }
    const left = ctx.node.inputs[0]!;
    const right = ctx.node.inputs[1]!;
    const lhs = asDouble ? this.asDouble(left) : this.nameOf(left);
    const rhs = asDouble ? this.asDouble(right) : this.nameOf(right);
    this.define(ctx, `${lhs} ${operator} ${rhs}`);
  }

  private emitGlobal(ctx: EmitContext): void {
    if (ctx.node.uses.length > 0) ctx.fail("load of a global value");
  }

  private emitReturn(ctx: EmitContext): void {
    const returned = ctx.node.inputs[0];
    if (returned === undefined) {
      ctx.fail("return without a value");
      return;
    }
    this.returnCount++;
    ctx.emit(`return ${this.nameOf(returned)};`);
  }

  private emitJump(ctx: EmitContext): void {
    const target = this.successorByProp(ctx.node.block!, "targetBlock");
    if (target === null) {
      ctx.fail("jump has no target block");
      return;
    }
    ctx.copyEdge(ctx.node.block!, target);
    ctx.emit(`goto ${ctx.labelOf(target)};`);
  }

  private emitBranch(ctx: EmitContext): void {
    const source = ctx.node.block!;
    const trueBlock = this.successorByProp(source, "trueBlock");
    const falseBlock = this.successorByProp(source, "falseBlock");
    if (trueBlock === null || falseBlock === null) {
      ctx.fail("branch has an unresolved successor");
      return;
    }
    ctx.emit(`if (${this.nameOf(ctx.node.inputs[0]!)} != 0) {`);
    ctx.copyEdge(source, trueBlock);
    ctx.emit(`goto ${ctx.labelOf(trueBlock)};`);
    ctx.emit(`} else {`);
    ctx.copyEdge(source, falseBlock);
    ctx.emit(`goto ${ctx.labelOf(falseBlock)};`);
    ctx.emit(`}`);
  }

  private successorByProp(block: CFGBlock, prop: string): CFGBlock | null {
    const terminator = block.getTerminator();
    if (terminator === null) return null;
    const targetId = terminator.props[prop];
    if (typeof targetId !== "number") return null;
    for (const successor of block.successors) {
      if (successor.id === targetId) return successor;
    }
    return null;
  }

  private copyEdge(from: CFGBlock, to: CFGBlock): void {
    const phis = to.phis.filter((phi) => !this.arrayAlias.has(phi));
    if (phis.length === 0) return;
    const predIndex = to.predecessors.indexOf(from);
    if (predIndex < 0) {
      this.failure = `edge B${from.id}->B${to.id} is not a predecessor edge`;
      return;
    }
    const temps: string[] = [];
    for (const phi of phis) {
      const scalar = this.scalarOf(phi);
      if (scalar === null) {
        this.failure = `phi has an unsupported type`;
        return;
      }
      const temp = `t${this.tempSeq++}`;
      temps.push(temp);
      this.body.push(
        `const ${declarationOf(scalar, temp)} = ${this.nameOf(phi.inputs[predIndex]!)};`,
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
      fail: (reason) => {
        if (this.failure === null) this.failure = reason;
      },
    };
  }

  private nameOf(value: CFGInstruction): string {
    const array = this.arrayAlias.get(value);
    if (array !== undefined) return this.nameOf(array);
    return this.names.get(value) ?? `v${value.id}`;
  }

  private labelOf(block: CFGBlock): string {
    return `L${block.id}`;
  }

  private signature(symbol: string, returnType: CScalarType): string | null {
    const params: string[] = [];
    for (const param of this.graph.parameters) {
      const scalar = this.scalarOf(param);
      if (scalar === null) return null;
      params.push(declarationOf(scalar, `p${Number(param.props.index)}`));
    }
    return `${returnType} ${symbol}(${params.length > 0 ? params.join(", ") : "void"})`;
  }

  private render(signature: string): string {
    const declarations: string[] = [];
    for (const phi of this.blockPhis) {
      const scalar = this.scalarOf(phi) ?? C_DOUBLE;
      declarations.push(`  ${declarationOf(scalar, this.nameOf(phi))};`);
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

  private bail(reason: string): CEmitResult {
    return { ok: false, reason };
  }
}

function inferTypes(graph: CFGFunction): TypeInference {
  return new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId);
}

export function emitNumericFunction(
  graph: CFGFunction,
  types: TypeInference = inferTypes(graph),
): CEmitResult {
  return new CFunctionEmitter(graph, types).emit();
}
