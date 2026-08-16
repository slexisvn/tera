import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  isTerminator,
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
  IR_FLOAT64_COMPARE,
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
  IR_CALL_KNOWN_FUNCTION,
  IR_CALL_BUILTIN,
  IR_NEW_ARRAY,
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_GENERIC_CALL,
  IR_GENERIC_ADD,
  IR_GENERIC_COMPARE,
  IR_LOAD_FIELD,
  IR_LOAD_TEXT,
  IR_NEW_OBJECT,
  IR_RUNTIME_BASE,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
  IR_LOAD_GLOBAL,
  heapElementScalarOf,
} from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import { computeValueLiveness } from "./value-liveness.js";
import type { CallReachability } from "../metadata/call-graph.js";
import { NAMED_ARGUMENTS_PROP } from "../metadata/call-signatures.js";
import { nominalLatticeType } from "../types/declared.js";
import {
  aotElementScalarOf,
  aotScalarOf,
  isReferenceScalar,
  isStorableScalar,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_VOID,
  TEXT_STORAGE_BYTES,
  type AotScalar,
} from "../types/scalar.js";
import { anyType, joinTypes, type LatticeType } from "../types/lattice.js";
import type { DeclaredSignature } from "../types/signature.js";
import {
  ANY_SCALAR,
  builtinAcceptsArity,
  builtinIntrinsicByName,
  builtinParameterAt,
  INPUT_BUILTIN,
  PRINT_BUILTIN,
  qualifiedMethodName,
  THROW_BUILTIN,
} from "../metadata/builtin-methods.js";
import { typeInferenceAnalysisId, type TypeInference } from "./type-inference.js";
import {
  forwardsPendingThrow,
  isPendingThrowReturn,
  takesPendingThrow,
} from "../builder/throw-recovery.js";

export const AOT_OPCODES: ReadonlySet<string> = new Set<string>([
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
  IR_GENERIC_COMPARE,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_FLOAT64_COMPARE,
  IR_NEG,
  IR_NOT,
  IR_CALL_KNOWN_FUNCTION,
  IR_CALL_BUILTIN,
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_LOAD_FIELD,
  IR_STORE_FIELD,
  IR_LOAD_TEXT,
  IR_STORE_TEXT,
  IR_NEW_OBJECT,
  IR_RUNTIME_BASE,
  IR_LOAD_GLOBAL,
  IR_RETURN,
  IR_JUMP,
  IR_BRANCH,
]);

export const AOT_CHAR_AT = qualifiedMethodName("string", "char_at");
export const AOT_INT_TO_STRING = qualifiedMethodName("int", "to_string");
export const AOT_FLOAT_TO_STRING = qualifiedMethodName("float", "to_string");

export const AOT_STRING_BUILTINS: ReadonlySet<string> = new Set<string>([
  AOT_CHAR_AT,
  AOT_INT_TO_STRING,
  AOT_FLOAT_TO_STRING,
]);

export const AOT_BUILTINS: ReadonlySet<string> = new Set<string>([
  PRINT_BUILTIN,
  INPUT_BUILTIN,
  THROW_BUILTIN,
  qualifiedMethodName("Math", "abs"),
  qualifiedMethodName("Math", "floor"),
  qualifiedMethodName("Math", "ceil"),
  qualifiedMethodName("Math", "sqrt"),
  qualifiedMethodName("Math", "trunc"),
  qualifiedMethodName("Math", "round"),
  qualifiedMethodName("Math", "min"),
  qualifiedMethodName("Math", "max"),
  qualifiedMethodName("string", "char_code_at"),
  qualifiedMethodName("string", "length"),
  ...AOT_STRING_BUILTINS,
]);

const ARRAY_OPS: ReadonlySet<string> = new Set<string>([
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
]);

const STATEMENT_WHEN_UNUSED: ReadonlySet<string> = new Set<string>([
  IR_CALL_KNOWN_FUNCTION,
  IR_STORE_ELEMENT,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
  IR_GENERIC_SET_INDEX,
]);

function keepsString(use: CFGInstruction): string {
  if (use.type === IR_STORE_FIELD) {
    const field = use.props.propName;
    return typeof field === "string" ? `stores it in ${field}` : "stores it in a field";
  }
  if (use.type === IR_STORE_ELEMENT || use.type === IR_GENERIC_SET_INDEX) {
    return "stores it in an array";
  }
  if (use.type === IR_CALL_KNOWN_FUNCTION) {
    const callee = calleeSymbolName(use);
    return callee === null ? "passes it to a function" : `passes it to ${callee}`;
  }
  return `keeps it in ${use.type}`;
}

function isConstantText(value: CFGInstruction | undefined): boolean {
  return value?.type === IR_CONSTANT && typeof value.props.value === "string";
}

/**
 * `Promise.resolve` and friends read a member off a value the runtime installs, which
 * a compiled program does not carry. Naming it beats reporting an anonymous global.
 */
function globalValueReason(node: CFGInstruction): string {
  const owner = node.props.name;
  if (typeof owner !== "string") return "load of a global value";
  const read = node.uses.find((use) => use.type === IR_GENERIC_GET_PROP);
  const member = read?.props.propName;
  if (typeof member !== "string") return `load of the global value ${owner}`;
  return (
    `${owner}.${member} is part of the runtime rather than of the program, so there is ` +
    `nothing to compile for it; write the same thing with async and await, or keep this ` +
    `part interpreted`
  );
}

function isStatement(node: CFGInstruction): boolean {
  if (STATEMENT_WHEN_UNUSED.has(node.type)) return true;
  if (node.type !== IR_CALL_BUILTIN) return false;
  return builtinIntrinsicByName(String(node.props.name))?.pure === false;
}

const REJECTIONS = new Map<string, (node: CFGInstruction) => string>([
  [IR_NEW_ARRAY, () => "array has an unsupported element type"],
  [IR_GENERIC_GET_PROP, (node) => `unsupported property ${String(node.props.propName)}`],
  [IR_GENERIC_CALL, () => "unsupported generic call"],
]);

export const AOT_PRINTABLE: ReadonlySet<AotScalar> = new Set<AotScalar>([
  SCALAR_INT32,
  SCALAR_FLOAT64,
  SCALAR_STRING,
]);

const ASCII_LIMIT = 0x7f;
const TEXT_CHARACTERS = TEXT_STORAGE_BYTES - 1;

export interface AotStringBuffer {
  readonly producer: CFGInstruction;
  readonly capacity: number;
}

export interface StringEscapeSummary {
  readonly retains: ReadonlySet<number>;
  readonly returnsBuffer: boolean;
}

export interface StringEscapeModel {
  summaryOf(name: string): StringEscapeSummary | null;
  refills(callee: string, owner: string): boolean;
  storesText(callee: string): boolean;
  producesText(callee: string): boolean;
  readonly throwsBuffer: boolean;
}

export interface StringBufferWalk {
  readonly aliases: ReadonlySet<CFGInstruction>;
  readonly escape: CFGInstruction | null;
  readonly returned: boolean;
  readonly phis: number;
}

export class StringBufferRules {
  constructor(
    private readonly types: TypeInference,
    private readonly model: StringEscapeModel | null,
  ) {}

  isStringValue(value: CFGInstruction): boolean {
    return aotScalarOf(this.types.typeOf(value)) === SCALAR_STRING;
  }

  buildsString(node: CFGInstruction): boolean {
    if (node.type === IR_GENERIC_ADD) {
      return this.isStringValue(node) && node.inputs.every((input) => this.isStringValue(input));
    }
    return node.type === IR_CALL_BUILTIN && AOT_STRING_BUILTINS.has(String(node.props.name));
  }

  fillsString(node: CFGInstruction): boolean {
    return node.type === IR_CALL_BUILTIN && String(node.props.name) === INPUT_BUILTIN;
  }

  ownsBuffer(node: CFGInstruction): boolean {
    return this.buildsString(node) || this.fillsString(node);
  }

  borrowsBuffer(node: CFGInstruction): boolean {
    if (node.type === IR_LOAD_TEXT) return true;
    if (takesPendingThrow(node)) return this.model?.throwsBuffer === true;
    if (node.type !== IR_CALL_KNOWN_FUNCTION || !this.isStringValue(node)) return false;
    const summary = this.summaryOf(node);
    return summary === null || summary.returnsBuffer;
  }

  readsString(node: CFGInstruction): boolean {
    if (node.type === IR_GENERIC_COMPARE) return true;
    return node.type === IR_CALL_BUILTIN && AOT_BUILTINS.has(String(node.props.name));
  }

  copiesString(node: CFGInstruction, value: CFGInstruction): boolean {
    return node.type === IR_STORE_TEXT && node.inputs[1] === value;
  }

  lendsString(node: CFGInstruction, value: CFGInstruction): boolean {
    if (node.type !== IR_CALL_KNOWN_FUNCTION) return false;
    const summary = this.summaryOf(node);
    if (summary === null) return false;
    return node.inputs.every((input, index) => input !== value || !summary.retains.has(index));
  }

  walk(seed: CFGInstruction): StringBufferWalk {
    const aliases = new Set<CFGInstruction>([seed]);
    const pending: CFGInstruction[] = [seed];
    let phis = 0;
    while (pending.length > 0) {
      for (const use of pending.pop()!.uses) {
        if (use.type !== IR_PHI || aliases.has(use)) continue;
        aliases.add(use);
        pending.push(use);
        phis++;
      }
    }

    let escape: CFGInstruction | null = null;
    let returned = false;
    for (const value of aliases) {
      for (const use of value.uses) {
        if (use.type === IR_PHI) continue;
        if (use.type === IR_RETURN) {
          returned = true;
          continue;
        }
        if (this.buildsString(use) || this.readsString(use)) continue;
        if (this.copiesString(use, value) || this.lendsString(use, value)) continue;
        if (forwardsPendingThrow(use)) continue;
        escape ??= use;
      }
    }
    return { aliases, escape, returned, phis };
  }

  private summaryOf(node: CFGInstruction): StringEscapeSummary | null {
    const name = calleeSymbolName(node);
    return name === null ? null : this.model?.summaryOf(name) ?? null;
  }
}

export interface StringEscapeUnit {
  readonly graph: CFGFunction;
  readonly types: TypeInference;
}

const NO_ESCAPES: StringEscapeSummary = { retains: new Set(), returnsBuffer: false };

function summarizeUnit(unit: StringEscapeUnit, model: StringEscapeModel): StringEscapeSummary {
  const rules = new StringBufferRules(unit.types, model);
  const retains = new Set<number>();
  let returnsBuffer = false;
  for (const block of unit.graph.blocks) {
    for (const node of block.nodes) {
      if (!rules.ownsBuffer(node) && !rules.borrowsBuffer(node)) continue;
      if (rules.walk(node).returned) returnsBuffer = true;
    }
  }
  unit.graph.parameters.forEach((param, index) => {
    if (!rules.isStringValue(param)) return;
    const walk = rules.walk(param);
    if (walk.escape !== null) retains.add(index);
    if (walk.returned) returnsBuffer = true;
  });
  return { retains, returnsBuffer };
}

function sameSummary(left: StringEscapeSummary, right: StringEscapeSummary): boolean {
  if (left.returnsBuffer !== right.returnsBuffer) return false;
  if (left.retains.size !== right.retains.size) return false;
  for (const index of right.retains) {
    if (!left.retains.has(index)) return false;
  }
  return true;
}

export function summarizeStringEscapes(
  units: readonly StringEscapeUnit[],
  reachability: CallReachability,
): StringEscapeModel {
  const summaries = new Map<string, StringEscapeSummary>();
  const byName = new Map<string, StringEscapeUnit>();
  const callers = new Map<string, Set<string>>();
  for (const unit of units) {
    summaries.set(unit.graph.name, NO_ESCAPES);
    byName.set(unit.graph.name, unit);
  }
  for (const unit of units) {
    for (const callee of reachability.callees(unit.graph.name)) {
      const group = callers.get(callee);
      if (group === undefined) callers.set(callee, new Set([unit.graph.name]));
      else group.add(unit.graph.name);
    }
  }

  const writers = new Set<string>();
  const producers = new Set<string>();
  let throwsBuffer = false;
  for (const unit of units) {
    const rules = new StringBufferRules(unit.types, null);
    const nodes = unit.graph.blocks.flatMap((block) => block.nodes);
    if (nodes.some((node) => node.type === IR_STORE_TEXT)) writers.add(unit.graph.name);
    if (nodes.some((node) => rules.ownsBuffer(node))) producers.add(unit.graph.name);
    throwsBuffer ||= nodes.some(
      (node) => forwardsPendingThrow(node) && rules.ownsBuffer(node.inputs[1]!),
    );
  }
  const writesText = new Map<string, boolean>();
  const buildsText = new Map<string, boolean>();
  const reaches = (group: ReadonlySet<string>, callee: string): boolean =>
    group.has(callee) || [...group].some((name) => reachability.reaches(callee, name));

  const model: StringEscapeModel = {
    summaryOf: (name) => summaries.get(name) ?? null,
    refills: (callee, owner) => reachability.overlaps(callee, owner),
    throwsBuffer,
    storesText: (callee) => {
      const cached = writesText.get(callee);
      if (cached !== undefined) return cached;
      const writes = reaches(writers, callee);
      writesText.set(callee, writes);
      return writes;
    },
    producesText: (callee) => {
      const cached = buildsText.get(callee);
      if (cached !== undefined) return cached;
      const builds = reaches(producers, callee);
      buildsText.set(callee, builds);
      return builds;
    },
  };

  const pending = [...byName.keys()];
  const queued = new Set(pending);
  while (pending.length > 0) {
    const name = pending.pop()!;
    queued.delete(name);
    const next = summarizeUnit(byName.get(name)!, model);
    if (sameSummary(summaries.get(name)!, next)) continue;
    summaries.set(name, next);
    for (const caller of callers.get(name) ?? []) {
      if (queued.has(caller)) continue;
      queued.add(caller);
      pending.push(caller);
    }
  }
  return model;
}

export interface AotLegality {
  readonly returnScalar: AotScalar;
  readonly declaredReturn: boolean;
  readonly parameterScalars: readonly AotScalar[];
  readonly constants: readonly CFGInstruction[];
  readonly stringBuffers: readonly AotStringBuffer[];
  scalarOf(value: CFGInstruction): AotScalar;
  stringBufferOf(value: CFGInstruction): AotStringBuffer | null;
}

export type AotLegalityResult =
  | { readonly ok: true; readonly legality: AotLegality }
  | { readonly ok: false; readonly reason: string };

export function calleeSymbolName(node: CFGInstruction): string | null {
  const target = node.props.target as { name?: unknown } | undefined;
  return typeof target?.name === "string" ? target.name : null;
}

export function calleeDeclaredSignature(node: CFGInstruction): DeclaredSignature | null {
  const target = node.props.target as
    | { declaredSignature?: DeclaredSignature | null }
    | undefined;
  return target?.declaredSignature ?? null;
}

export function isAsciiRepresentable(value: string): boolean {
  for (const character of value) {
    if (character.codePointAt(0)! > ASCII_LIMIT) return false;
  }
  return true;
}

export function builtinOperandScalar(declared: string | null): AotScalar | null {
  return aotScalarOf(nominalLatticeType(declared, null));
}

class LegalityAnalyzer implements AotLegality {
  private readonly scalars = new Map<CFGInstruction, AotScalar>();
  private readonly bufferByValue = new Map<CFGInstruction, AotStringBuffer>();
  private readonly borrowedFrom = new Map<CFGInstruction, CFGInstruction>();
  private readonly rules: StringBufferRules;
  private readonly seenConstants = new Set<CFGInstruction>();
  readonly constants: CFGInstruction[] = [];
  readonly stringBuffers: AotStringBuffer[] = [];
  returnScalar: AotScalar = SCALAR_FLOAT64;
  declaredReturn = false;
  parameterScalars: AotScalar[] = [];
  private voidReturn = false;
  private failure: string | null = null;

  constructor(
    private readonly graph: CFGFunction,
    private readonly types: TypeInference,
  ) {
    this.rules = new StringBufferRules(types, graph.stringEscapes);
  }

  analyze(): AotLegalityResult {
    if (this.graph.bailout !== null) {
      return this.bail(`graph bailed: ${this.graph.bailout}`);
    }
    this.graph.rebuildUses();
    const entry = this.graph.entry;
    if (entry === null) return this.bail("function has no entry block");
    if (entry !== this.graph.blocks[0]) return this.bail("entry is not the first block");
    if (entry.phis.length > 0) return this.bail("entry block has phis");

    this.voidReturn = aotScalarOf(this.returnedType() ?? anyType()) === SCALAR_VOID;
    this.collectStringBuffers();
    if (this.failure !== null) return this.bail(this.failure);
    this.collectConstants();
    if (this.failure !== null) return this.bail(this.failure);
    this.checkBlocks();
    if (this.failure !== null) return this.bail(this.failure);
    this.checkSignature();
    if (this.failure !== null) return this.bail(this.failure);

    return { ok: true, legality: this };
  }

  scalarOf(value: CFGInstruction): AotScalar {
    const scalar = this.scalars.get(value) ?? aotScalarOf(this.types.typeOf(value));
    if (scalar === null) {
      throw new Error(`legality admitted v${value.id} without a scalar type`);
    }
    return scalar;
  }

  stringBufferOf(value: CFGInstruction): AotStringBuffer | null {
    return this.bufferByValue.get(value) ?? null;
  }

  private fail(reason: string): void {
    if (this.failure === null) this.failure = reason;
  }

  private bail(reason: string): AotLegalityResult {
    return { ok: false, reason };
  }

  private require(value: CFGInstruction, context: string): AotScalar | null {
    const cached = this.scalars.get(value);
    if (cached !== undefined) return cached;
    const scalar =
      value.type === IR_RUNTIME_BASE ? SCALAR_POINTER : aotScalarOf(this.types.typeOf(value));
    if (scalar === null) {
      this.fail(`value has an unsupported type in ${context}`);
      return null;
    }
    this.scalars.set(value, scalar);
    return scalar;
  }

  private requireStorable(value: CFGInstruction, context: string): AotScalar | null {
    const scalar = this.require(value, context);
    if (scalar === null) return null;
    if (isStorableScalar(scalar) !== null) return scalar;
    this.fail(`value has no representation in ${context}`);
    return null;
  }

  private isStringValue(value: CFGInstruction): boolean {
    return this.rules.isStringValue(value);
  }

  private collectStringBuffers(): void {
    const owned: CFGInstruction[] = [];
    const borrowed: CFGInstruction[] = [];
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (this.rules.ownsBuffer(node)) owned.push(node);
        else if (this.rules.borrowsBuffer(node)) borrowed.push(node);
      }
    }
    if (owned.length === 0 && borrowed.length === 0) return;

    for (const producer of owned) {
      const model: AotStringBuffer = { producer, capacity: TEXT_STORAGE_BYTES };
      if (!this.bindStringBufferAliases(model)) return;
      this.stringBuffers.push(model);
    }
    for (const origin of borrowed) {
      if (!this.bindBorrowedAliases(origin)) return;
    }

    for (const buffer of this.stringBuffers) {
      for (const input of buffer.producer.inputs.slice(1)) {
        if (this.bufferByValue.get(input) === buffer) {
          this.fail("string buffer is used as a trailing operand of its own producer");
          return;
        }
      }
    }
    if (owned.length > 0) this.checkBufferReentrancy();
    if (this.failure === null) this.checkBorrowedLifetimes();
  }

  private bindBorrowedAliases(origin: CFGInstruction): boolean {
    const walk = this.rules.walk(origin);
    if (walk.escape !== null) {
      this.fail(this.escapeReason(origin, walk.escape));
      return false;
    }
    for (const value of walk.aliases) this.borrowedFrom.set(value, origin);
    return true;
  }

  private checkBorrowedLifetimes(): void {
    if (this.borrowedFrom.size === 0) return;
    const liveness = computeValueLiveness(this.graph);
    for (const block of this.graph.blocks) {
      const live = new Set(liveness.liveOut(block));
      for (let at = block.nodes.length - 1; at >= 0; at--) {
        const node = block.nodes[at]!;
        this.checkInvalidation(node, live);
        if (this.failure !== null) return;
        live.delete(node);
        if (node.type === IR_PHI) continue;
        for (const input of node.inputs) live.add(input);
      }
    }
  }

  private checkInvalidation(node: CFGInstruction, liveAfter: ReadonlySet<CFGInstruction>): void {
    if (node.type !== IR_CALL_KNOWN_FUNCTION && node.type !== IR_STORE_TEXT) return;
    for (const value of liveAfter) {
      const origin = this.borrowedFrom.get(value);
      if (origin === undefined || origin === node) continue;
      const overwrites = this.invalidates(node, origin);
      if (overwrites === null) continue;
      this.fail(
        `${this.graph.name} keeps ${this.borrowedName(origin)} across ${overwrites}, which ` +
          `can overwrite it; a borrowed string lives only until the storage behind it is ` +
          `written again, so use it before that point, copy it into an object field, or keep ` +
          `this part interpreted`,
      );
      return;
    }
  }

  private invalidates(node: CFGInstruction, origin: CFGInstruction): string | null {
    const model = this.graph.stringEscapes;
    if (model === null) return null;
    if (node.type === IR_STORE_TEXT) {
      const field = node.props.propName;
      return typeof field === "string" ? `a write to ${field}` : "a write to a field";
    }
    const callee = calleeSymbolName(node);
    if (callee === null) return null;
    if (takesPendingThrow(origin)) {
      return model.producesText(callee) || model.storesText(callee) ? `a call to ${callee}` : null;
    }
    const owner = calleeSymbolName(origin);
    if (owner !== null && model.refills(callee, owner)) return `a call to ${callee}`;
    return model.storesText(callee) ? `a call to ${callee}` : null;
  }

  private borrowedName(origin: CFGInstruction): string {
    if (takesPendingThrow(origin)) return "the value it caught";
    if (origin.type === IR_LOAD_TEXT) {
      const field = origin.props.propName;
      return typeof field === "string" ? `the string it read from ${field}` : "a string it read";
    }
    const owner = calleeSymbolName(origin);
    return owner === null ? "a borrowed string" : `the string ${owner} returned`;
  }

  private escapeReason(origin: CFGInstruction, use: CFGInstruction): string {
    return (
      `${this.graph.name} ${this.producesString(origin)} and then ${keepsString(use)}; that ` +
      `string lives only until the next one is produced there, so it can be printed, built ` +
      `into another string, or copied into an object field, but not kept; use it where it is ` +
      `produced, or keep this part interpreted`
    );
  }

  private producesString(origin: CFGInstruction): string {
    if (this.rules.fillsString(origin)) return "reads a line";
    if (this.rules.ownsBuffer(origin)) return "builds a string";
    return `keeps the string ${calleeSymbolName(origin) ?? "a call"} returned`;
  }

  private checkBufferReentrancy(): void {
    if (!this.graph.reentrant) return;
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_CALL_KNOWN_FUNCTION) continue;
        this.fail(
          `string building cannot cross a call in ${this.graph.name} because it can re-enter itself`,
        );
        return;
      }
    }
  }

  private bindStringBufferAliases(model: AotStringBuffer): boolean {
    const walk = this.rules.walk(model.producer);
    if (walk.phis > 1) {
      this.fail("string buffer has more than one loop-carried alias");
      return false;
    }
    if (walk.escape !== null) {
      this.fail(this.escapeReason(model.producer, walk.escape));
      return false;
    }

    for (const value of walk.aliases) this.bufferByValue.set(value, model);
    return true;
  }

  private collectConstants(): void {
    const visit = (value: CFGInstruction | undefined): void => {
      if (value === undefined || value.type !== IR_CONSTANT) return;
      if (this.seenConstants.has(value)) return;
      this.seenConstants.add(value);
      this.checkConstant(value);
      if (this.scalars.get(value) !== SCALAR_VOID) this.constants.push(value);
    };
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        visit(node);
        for (const input of node.inputs) visit(input);
      }
      for (const phi of block.phis) {
        for (const input of phi.inputs) visit(input);
      }
    }
  }

  private checkConstant(node: CFGInstruction): void {
    const value = node.props.value;
    if (typeof value === "string") {
      if (!isAsciiRepresentable(value)) {
        this.fail("string constant is not representable as ASCII");
      } else if (value.length > TEXT_CHARACTERS) {
        this.fail(
          `string constant is longer than the ${TEXT_CHARACTERS} characters a compiled ` +
            `string holds; shorten it, or keep this part interpreted`,
        );
      } else {
        this.scalars.set(node, SCALAR_STRING);
      }
      return;
    }
    const scalar = this.require(node, node.type);
    if (scalar === null || scalar === SCALAR_VOID) return;
    if (typeof value === "boolean") return;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail(`unsupported constant ${String(value)}`);
    }
  }

  private checkBlocks(): void {
    let returns = 0;
    for (const block of this.graph.blocks) {
      for (const phi of block.phis) this.requireStorable(phi, IR_PHI);
      for (const node of block.nodes) {
        if (node.type === IR_RETURN) returns++;
        this.checkNode(node);
        if (this.failure !== null) return;
      }
      if (block.getTerminator() !== null) continue;
      this.fail(returns === 0 ? "function has no return" : `block ${block.id} has no terminator`);
      return;
    }
    if (returns === 0) this.fail("function has no return");
  }

  private checkNode(node: CFGInstruction): void {
    if (node.type === IR_PARAMETER || node.type === IR_PHI || node.type === IR_CONSTANT) {
      return;
    }
    const rejection = REJECTIONS.get(node.type);
    if (rejection !== undefined) {
      this.fail(rejection(node));
      return;
    }
    if (node.props[NAMED_ARGUMENTS_PROP] !== undefined) {
      this.fail("call has named arguments that do not match the callee parameters");
      return;
    }
    if (!AOT_OPCODES.has(node.type) && this.bufferByValue.get(node)?.producer !== node) {
      this.fail(`unsupported opcode ${node.type}`);
      return;
    }
    if (node.type === IR_LOAD_GLOBAL) {
      if (node.uses.length > 0) this.fail(globalValueReason(node));
      return;
    }
    if (node.type === IR_RUNTIME_BASE) {
      this.scalars.set(node, SCALAR_POINTER);
      return;
    }
    if (node.type === IR_CALL_KNOWN_FUNCTION) {
      const name = calleeSymbolName(node);
      if (name === null) {
        this.fail("call to a function without a resolvable name");
        return;
      }
      const declared = calleeDeclaredSignature(node);
      if (declared?.variadic === true) {
        this.fail(`call to ${name}, which takes a variable number of arguments`);
        return;
      }
      if (declared !== null && node.inputs.length !== declared.params.length) {
        this.fail(`call to ${name} passes ${node.inputs.length} of ${declared.params.length} arguments`);
        return;
      }
    }
    if (node.type === IR_CALL_BUILTIN) {
      this.checkBuiltin(node);
      if (this.failure !== null) return;
    }
    if (node.type === IR_GENERIC_COMPARE && !this.checkStringCompare(node)) return;
    if (node.type === IR_RETURN && node.inputs[0] === undefined) {
      this.fail("return without a value");
      return;
    }
    if (ARRAY_OPS.has(node.type)) {
      const element = heapElementScalarOf(node);
      if (element === null) {
        this.fail(`${node.type} on a value the compiler cannot see the elements of`);
        return;
      }
      this.checkHeapElement(node, element);
      return;
    }
    const discards = node.type === IR_RETURN && this.voidReturn;
    for (const input of node.inputs) {
      const admitted = discards
        ? this.require(input, node.type)
        : this.requireStorable(input, node.type);
      if (admitted === null) return;
    }
    if (isTerminator(node.type)) return;
    if (node.uses.length === 0 && isStatement(node)) return;
    this.require(node, node.type);
  }

  private checkHeapElement(node: CFGInstruction, element: AotScalar): void {
    this.scalars.set(node.inputs[0]!, SCALAR_POINTER);
    if (this.require(node.inputs[1]!, node.type) !== SCALAR_INT32) {
      this.fail(`${node.type} is indexed by a value that is not an integer`);
      return;
    }
    const stored = node.inputs[2];
    if (stored !== undefined) {
      const value = this.require(stored, node.type);
      if (value === null) return;
      if (value !== element && (isReferenceScalar(value) || isReferenceScalar(element))) {
        this.fail("array has an unsupported element type");
        return;
      }
    }
    this.scalars.set(node, element);
  }

  private checkStringCompare(node: CFGInstruction): boolean {
    const strings = node.inputs.every(
      (input) => aotScalarOf(this.types.typeOf(input)) === SCALAR_STRING,
    );
    if (strings) return true;
    this.fail(
      `${node.type} compares values the compiler cannot compare natively; annotate the ` +
        `operands, or keep this part interpreted`,
    );
    return false;
  }

  private checkBuiltin(node: CFGInstruction): void {
    const name = String(node.props.name);
    const intrinsic = builtinIntrinsicByName(name);
    if (intrinsic === null || !AOT_BUILTINS.has(name)) {
      this.fail(`unsupported builtin ${name}`);
      return;
    }
    if (!builtinAcceptsArity(intrinsic, node.inputs.length)) {
      this.fail(`${name} has an unsupported argument count`);
      return;
    }
    for (let index = 0; index < node.inputs.length; index++) {
      const declared = builtinParameterAt(intrinsic, index);
      const actual = this.require(node.inputs[index]!, node.type);
      if (actual === null) return;
      if (declared === ANY_SCALAR) {
        if (name === PRINT_BUILTIN && !AOT_PRINTABLE.has(actual)) {
          this.fail(`${name} cannot format a ${actual} value`);
          return;
        }
        continue;
      }
      const expected = builtinOperandScalar(declared);
      const stringMismatch =
        (expected === SCALAR_STRING || actual === SCALAR_STRING) && expected !== actual;
      if (expected === null || stringMismatch) {
        this.fail(`${name} has an unsupported argument type`);
        return;
      }
    }
  }

  private checkSignature(): void {
    const returnScalar = this.inferReturnScalar();
    if (returnScalar === null) {
      this.fail("function has an unsupported return type");
      return;
    }
    if (returnScalar !== SCALAR_STRING && this.returnsAString()) {
      this.fail("function returns a string but its return type is not a string");
      return;
    }
    this.returnScalar = returnScalar;
    for (const param of this.graph.parameters) {
      const scalar = isStorableScalar(aotScalarOf(this.types.typeOf(param)));
      if (scalar === null) {
        this.fail("function has an unsupported parameter type");
        return;
      }
      this.scalars.set(param, scalar);
      this.parameterScalars.push(scalar);
    }
  }

  private returnsAString(): boolean {
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_RETURN) continue;
        const returned = node.inputs[0];
        if (returned !== undefined && this.isStringValue(returned)) return true;
      }
    }
    return false;
  }

  private returnedType(): LatticeType | null {
    let merged: LatticeType | null = null;
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_RETURN || isPendingThrowReturn(node)) continue;
        const returned = node.inputs[0];
        if (returned !== undefined) merged = joinTypes(merged, this.types.typeOf(returned));
      }
    }
    return merged;
  }

  private inferReturnScalar(): AotScalar | null {
    if (this.voidReturn) return SCALAR_VOID;
    const returned = this.returnedType();
    const declared = this.graph.declaredSignature?.returns;
    if (declared !== null && declared !== undefined) {
      const scalar = aotScalarOf(nominalLatticeType(declared, this.graph.classes));
      if (scalar !== null) {
        this.declaredReturn = true;
        return scalar;
      }
    }
    return returned === null ? SCALAR_FLOAT64 : aotScalarOf(returned);
  }
}

export function analyzeAotLegality(
  graph: CFGFunction,
  types: TypeInference,
): AotLegalityResult {
  return new LegalityAnalyzer(graph, types).analyze();
}

export const aotLegalityAnalysisId = analysisId<AotLegalityResult>("aot-legality");

export const aotLegalityAnalysis: AnalysisPass<CFGFunction, AotLegalityResult> = {
  id: aotLegalityAnalysisId,
  run: (graph, analyses) =>
    analyzeAotLegality(graph, analyses.get(typeInferenceAnalysisId)),
};
