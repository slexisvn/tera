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
  IR_GENERIC_DELETE_PROP,
  IR_NEW_ARRAY,
  IR_ARRAY_RESERVE,
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
  textCapacityOf,
  IR_LOAD_GLOBAL,
  heapElementScalarOf,
} from "../ir/index.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import {
  declaredAotScalar,
  isLiteralShapeName,
  sameFieldLayout,
  shapeForDeclared,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  VALUE_CLASS_PROP,
  type ClassTable,
} from "../metadata/class-table.js";

export function isAbsenceConstant(value: CFGInstruction | undefined): boolean {
  return value !== undefined && value.type === IR_CONSTANT && value.props.value === null;
}

export function int32ConstantOf(
  value: CFGInstruction | undefined,
  scalar: AotScalar | null,
): number | null {
  if (value === undefined || value.type !== IR_CONSTANT || scalar !== SCALAR_INT32) return null;
  const held = value.props.value;
  if (typeof held !== "number" || !Number.isInteger(held)) return null;
  return held === (held | 0) ? held : null;
}
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import { UnionFind } from "../infra/union-find.js";
import { computeValueLiveness } from "./value-liveness.js";
import type { CallReachability } from "../metadata/call-graph.js";
import {
  calleeDeclaredSignature,
  calleeSymbolName,
  declaredTypeAt,
  NAMED_ARGUMENTS_PROP,
} from "../metadata/call-signatures.js";
import { declaredAcceptsNull, nominalLatticeType } from "../types/declared.js";
import {
  aotElementScalarOf,
  aotScalarOf,
  isNumericScalar,
  isReferenceScalar,
  isStorableScalar,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_CODE,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_TEXT,
  SCALAR_VOID,
  VALUE_SCALAR_PROP,
  type AotScalar,
} from "../types/scalar.js";
import { anyType, joinTypes, TypeKind, type LatticeType } from "../types/lattice.js";
import {
  functionSignatureOf,
  isUnwritten,
  parameterLabelOf,
  type DeclaredSignature,
} from "../types/signature.js";
import {
  ANY_SCALAR,
  builtinAcceptsArity,
  builtinIntrinsicByName,
  builtinParameterAt,
  BUILTIN_METHOD_NAMES,
  GLOBAL_BUILTIN_NAMES,
  INPUT_BUILTIN,
  PRINT_BUILTIN,
  qualifiedMethodName,
  STRING_PRODUCING_BUILTINS,
  THROW_BUILTIN,
} from "../metadata/builtin-methods.js";
import { typeInferenceAnalysisId, type TypeInference } from "./type-inference.js";
import { SPREAD_ARGUMENTS_PROP } from "../passes/spread-calls.js";
import {
  arrayModelForDeclaredType,
  arrayModelOf,
  type ArrayModel,
} from "../passes/array-shapes.js";
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
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_LOAD_FIELD,
  IR_STORE_FIELD,
  IR_LOAD_TEXT,
  IR_STORE_TEXT,
  IR_NEW_OBJECT,
  IR_ARRAY_RESERVE,
  IR_RUNTIME_BASE,
  IR_LOAD_GLOBAL,
  IR_RETURN,
  IR_JUMP,
  IR_BRANCH,
]);

export const AOT_CHAR_AT = qualifiedMethodName("string", "char_at");
export const AOT_INT_TO_STRING = qualifiedMethodName("int", "to_string");
export const AOT_FLOAT_TO_STRING = qualifiedMethodName("float", "to_string");

export const AOT_STRING_BUILTINS: ReadonlySet<string> = STRING_PRODUCING_BUILTINS;

export const AOT_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...GLOBAL_BUILTIN_NAMES,
  ...BUILTIN_METHOD_NAMES,
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

function allocated(value: CFGInstruction | undefined): boolean {
  return value !== undefined && value.type === IR_NEW_OBJECT;
}

const TOUCHES_TEXT: ReadonlySet<string> = new Set<string>([IR_LOAD_TEXT, IR_STORE_TEXT]);

function filledOnce(held: CFGInstruction): boolean {
  let stores = 0;
  for (const use of held.uses) {
    if (use.type === IR_PHI) continue;
    if (!TOUCHES_TEXT.has(use.type) || use.inputs[0] !== held) return false;
    if (use.type === IR_STORE_TEXT) stores += 1;
  }
  return stores === 1;
}

export function holdsOwnText(
  value: CFGInstruction | undefined,
  seen: Set<CFGInstruction> = new Set(),
): boolean {
  if (value === undefined) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (value.type === IR_PHI) {
    return value.inputs.length > 0 && value.inputs.every((input) => holdsOwnText(input, seen));
  }
  return allocated(value) && filledOnce(value);
}

function privateStorage(origin: CFGInstruction): boolean {
  return origin.type === IR_LOAD_TEXT && holdsOwnText(origin.inputs[0]);
}

function writesElsewhere(store: CFGInstruction, origin: CFGInstruction): boolean {
  const written = store.inputs[0];
  if (written === undefined) return false;
  const borrowed = origin.type === IR_LOAD_TEXT ? origin.inputs[0] : null;
  if (borrowed === null || borrowed === undefined) return allocated(written);
  if (written === borrowed) return store.props.offset !== origin.props.offset;
  return allocated(written) && allocated(borrowed);
}

function isConstantText(value: CFGInstruction | undefined): boolean {
  return value?.type === IR_CONSTANT && typeof value.props.value === "string";
}

export const SPREAD_CALL_REASON =
  "a call spreads an array into a function whose argument count the compiler cannot " +
  "tell, so it does not know how many elements to take; call a function with declared " +
  "parameters, pass the arguments one by one, or keep this part interpreted";

const PROMISE_GLOBAL = "Promise";
const JSON_GLOBAL = "JSON";
const PARSE_MEMBER = "parse";

const MEMBER_ADVICE: ReadonlyMap<string, string> = new Map<string, string>([
  [
    `${JSON_GLOBAL}.${PARSE_MEMBER}`,
    "it answers a value whose shape is only known once the text is read, and a compiled " +
      "value has a fixed set of fields; give the result a declared object type whose " +
      "fields are numbers, text, booleans, other declared object types, or arrays of " +
      "those, or keep this part interpreted",
  ],
]);

function globalValueReason(node: CFGInstruction, classes: ClassTable | null): string {
  const owner = node.props.name;
  if (typeof owner !== "string") return "load of a global value";
  const read = node.uses.find((use) => use.type === IR_GENERIC_GET_PROP);
  const member = read?.props.propName;
  if (typeof member !== "string") return `load of the global value ${owner}`;
  if (classes !== null && classes.shapeOf(owner) !== null) {
    return (
      `${owner}.${member} is a value the compiler could not lay out; give it a type the ` +
      `compiler can shape, or keep this part interpreted`
    );
  }
  const spelled = MEMBER_ADVICE.get(`${owner}.${member}`);
  if (spelled !== undefined) return `${owner}.${member} does not compile: ${spelled}`;
  const advice =
    owner === PROMISE_GLOBAL
      ? "write the same thing with async and await, or keep this part interpreted"
      : "keep this part interpreted";
  return (
    `${owner}.${member} is part of the runtime rather than of the program, so there is ` +
    `nothing to compile for it; ${advice}`
  );
}

function memberCalledWith(node: CFGInstruction): string | null {
  const call = node.uses.find((use) => use.type === IR_GENERIC_CALL);
  const callee = call?.inputs[0];
  if (callee?.type !== IR_GENERIC_GET_PROP) return null;
  const member = callee.props.propName;
  return typeof member === "string" ? member : null;
}

export const CODE_TARGET_PROP = "codeTarget";

export function callThroughArguments(node: CFGInstruction): readonly CFGInstruction[] {
  return node.inputs.slice(node.props.isMethod === true ? 2 : 1);
}

export function codeSymbolOf(node: CFGInstruction): string | null {
  const named = node.props[CODE_TARGET_PROP];
  return typeof named === "string" ? named : null;
}

function functionValueReason(node: CFGInstruction, passed: string): string {
  const member = memberCalledWith(node);
  if (member === null) {
    return `${passed} is used as a value, which the compiler cannot represent`;
  }
  const known = MEMBER_REASONS.get(member);
  if (known !== undefined) return known;
  return (
    `${member} is called with ${passed}, which the compiler could not lower into a loop; ` +
    `pass a function declared at the top level whose parameters the member can fill, or ` +
    `keep this part interpreted`
  );
}

function isStatement(node: CFGInstruction): boolean {
  if (STATEMENT_WHEN_UNUSED.has(node.type)) return true;
  if (node.type !== IR_CALL_BUILTIN) return false;
  return builtinIntrinsicByName(String(node.props.name))?.pure === false;
}

const NEEDS_A_HASH_TABLE =
  "is a hash table the compiler has no native shape for; use an object with the keys " +
  "spelled out, an array, or keep this part interpreted";

const MEMBER_REASONS: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "sort",
    "sort without a comparator orders elements as text, which the compiler can only do " +
      "for numbers and text; pass a comparator that returns a number, or keep this part " +
      "interpreted",
  ],
  [
    "split",
    "split compiles when its separator is one spelled-out character; pass a literal " +
      "such as \",\", or keep this part interpreted",
  ],
  ["set", `set ${NEEDS_A_HASH_TABLE}`],
  ["add", `add ${NEEDS_A_HASH_TABLE}`],
  ["get", `get ${NEEDS_A_HASH_TABLE}`],
  ["has", `has ${NEEDS_A_HASH_TABLE}`],
]);

const REJECTIONS = new Map<string, (node: CFGInstruction) => string>([
  [IR_NEW_ARRAY, () => "array literal has no element type the compiler could pin down"],
  [
    IR_GENERIC_DELETE_PROP,
    () =>
      "delete removes a property at run time, and a compiled object holds a fixed set " +
      "of fields; use a Map and its delete method, or keep this part interpreted",
  ],
  [
    IR_GENERIC_GET_PROP,
    (node) =>
      MEMBER_REASONS.get(String(node.props.propName)) ??
      `unsupported property ${String(node.props.propName)}`,
  ],
  [IR_GENERIC_CALL, () => "unsupported generic call"],
]);

export const AOT_PRINTABLE: ReadonlySet<AotScalar> = new Set<AotScalar>([
  SCALAR_INT32,
  SCALAR_FLOAT64,
  SCALAR_STRING,
]);

const EQUALITY_OPERATORS: ReadonlySet<string> = new Set<string>([
  "==",
  "!=",
  "loose==",
  "loose!=",
]);

const ASCII_LIMIT = 0x7f;

export interface AotStringBuffer {
  readonly producer: CFGInstruction;
  readonly producers: ReadonlySet<CFGInstruction>;
  readonly capacity: number;
}

export interface StringEscapeSummary {
  readonly retains: ReadonlySet<number>;
  readonly returnsBuffer: boolean;
}

export interface StringEscapeModel {
  summaryOf(name: string): StringEscapeSummary | null;
  refills(callee: string, owner: string): boolean;
  reenters(callee: string, owner: string): boolean;
  storesText(callee: string): boolean;
  producesText(callee: string): boolean;
  readonly throwsBuffer: boolean;
}

function mergedProducers(
  owned: readonly CFGInstruction[],
  walk: (producer: CFGInstruction) => StringBufferWalk,
): CFGInstruction[][] {
  const walked = new Map<CFGInstruction, StringBufferWalk>();
  for (const producer of owned) walked.set(producer, walk(producer));

  const groups: CFGInstruction[][] = [];
  const shared = new UnionFind<CFGInstruction>();
  const ownerOfAlias = new Map<CFGInstruction, CFGInstruction>();
  for (const producer of owned) {
    if (walked.get(producer)!.phis > 1) continue;
    groups.push([producer]);
  }
  for (const [producer, reached] of walked) {
    if (reached.phis <= 1) continue;
    shared.makeSet(producer);
    for (const alias of reached.aliases) {
      const met = ownerOfAlias.get(alias);
      if (met === undefined) ownerOfAlias.set(alias, producer);
      else shared.union(producer, met);
    }
  }

  const byRoot = new Map<CFGInstruction, CFGInstruction[]>();
  for (const [producer, reached] of walked) {
    if (reached.phis <= 1) continue;
    const root = shared.find(producer);
    const group = byRoot.get(root);
    if (group === undefined) byRoot.set(root, [producer]);
    else group.push(producer);
  }
  return [...groups, ...byRoot.values()];
}

export function mergedTextInputs(
  carried: Iterable<CFGInstruction>,
  inside: ReadonlySet<CFGInstruction>,
): CFGInstruction[] {
  const outside = new Set<CFGInstruction>();
  for (const phi of carried) {
    for (const input of phi.inputs) {
      if (inside.has(input) || isConstantText(input)) continue;
      outside.add(input);
    }
  }
  return [...outside];
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
    if (node.type === IR_STORE_TEXT) return node.inputs[1] === value;
    if (node.type !== IR_STORE_ELEMENT && node.type !== IR_GENERIC_SET_INDEX) return false;
    return node.inputs[2] === value && heapElementScalarOf(node) === SCALAR_TEXT;
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
    reenters: (callee, owner) => reachability.reaches(callee, owner),
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
  absenceComparesAsNumber(node: CFGInstruction): boolean;
  comparesReferences(node: CFGInstruction): boolean;
  stringBufferOf(value: CFGInstruction): AotStringBuffer | null;
  codeSignatureOf(value: CFGInstruction | undefined): DeclaredSignature | null;
}

export type AotLegalityResult =
  | { readonly ok: true; readonly legality: AotLegality }
  | { readonly ok: false; readonly reason: string };

export function isRootedPointer(legality: AotLegality, value: CFGInstruction): boolean {
  if (value.type === IR_RUNTIME_BASE) return false;
  if (value.uses.length === 0) return false;
  return legality.scalarOf(value) === SCALAR_POINTER;
}

export function rootSlotsOf(
  legality: AotLegality,
  values: Iterable<CFGInstruction>,
): Map<CFGInstruction, number> {
  const slots = new Map<CFGInstruction, number>();
  for (const value of values) {
    if (!isRootedPointer(legality, value) || slots.has(value)) continue;
    slots.set(value, slots.size);
  }
  return slots;
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

function elementsAgree(held: ArrayModel, asked: ArrayModel): boolean {
  if (held.element !== asked.element) return false;
  if (held.elementShape === null || asked.elementShape === null) return true;
  return sameFieldLayout(held.elementShape, asked.elementShape);
}

function arrayCrossingOf(node: CFGInstruction): string {
  if (node.type === IR_RETURN) return "returns";
  if (node.type === IR_CALL_KNOWN_FUNCTION) {
    return `call to ${calleeSymbolName(node) ?? "a function"} passes`;
  }
  return "stores";
}

export function undeclaredParameterOf(graph: CFGFunction): number | null {
  const declared = graph.declaredSignature;
  for (const parameter of graph.parameters) {
    const index = Number(parameter.props.index);
    if (isUnwritten(declared?.params[index])) return index;
  }
  return null;
}

export function undeclaredParameterReason(
  signature: DeclaredSignature | null,
  index: number,
): string {
  const { name, gathered } = parameterLabelOf(signature, index);
  if (name === null) {
    return (
      `parameter #${index + 1} has no declared type; declare it, or keep this part interpreted`
    );
  }
  return gathered
    ? `rest parameter '${name}' has no declared type; declare the type its arguments have ` +
        `(for example '...${name}: int'), or keep this part interpreted`
    : `parameter '${name}' has no declared type; declare it (for example '${name}: int'), ` +
        `or keep this part interpreted`;
}

class LegalityAnalyzer implements AotLegality {
  private readonly scalars = new Map<CFGInstruction, AotScalar>();
  private readonly bufferByValue = new Map<CFGInstruction, AotStringBuffer>();
  private readonly borrowedFrom = new Map<CFGInstruction, CFGInstruction>();
  private readonly privateStorage = new Map<CFGInstruction, boolean>();
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

    this.voidReturn = this.inferVoidReturn();
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

  private laidOutScalarOf(value: CFGInstruction): AotScalar | null {
    const built = value.props[VALUE_SCALAR_PROP];
    if (typeof built === "string") return built as AotScalar;
    if (value.type !== IR_LOAD_FIELD) return null;
    const carried = value.props[FIELD_SCALAR_PROP];
    return typeof carried === "string" && carried !== SCALAR_TEXT
      ? (carried as AotScalar)
      : null;
  }

  private require(value: CFGInstruction, context: string): AotScalar | null {
    const cached = this.scalars.get(value);
    if (cached !== undefined) return cached;
    const scalar =
      value.type === IR_RUNTIME_BASE
        ? SCALAR_POINTER
        : this.laidOutScalarOf(value) ??
          this.answeredScalarOf(value) ??
          aotScalarOf(this.types.typeOf(value)) ??
          this.mergedReferenceOf(value);
    if (scalar === null) {
      this.fail(`value has an unsupported type in ${context}`);
      return null;
    }
    this.scalars.set(value, scalar);
    return scalar;
  }

  private mergedReferenceOf(value: CFGInstruction): AotScalar | null {
    if (value.type !== IR_PHI || value.inputs.length === 0) return null;
    if (this.types.typeOf(value).kind !== TypeKind.Object) return null;
    const merged = value.inputs.map((input) => this.comparedScalarOf(input));
    return merged.every((scalar) => scalar === SCALAR_POINTER) ? SCALAR_POINTER : null;
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

    for (const group of mergedProducers(owned, (producer) => this.rules.walk(producer))) {
      const model: AotStringBuffer = {
        producer: group[0]!,
        producers: new Set(group),
        capacity: this.graph.textBufferBytes,
      };
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
    this.checkStringLifetimes();
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

  private checkStringLifetimes(): void {
    if (this.borrowedFrom.size === 0 && this.bufferByValue.size === 0) return;
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

  private buildsHere(node: CFGInstruction): boolean {
    return this.bufferByValue.get(node)?.producers.has(node) === true;
  }

  private exposedAt(
    node: CFGInstruction,
    liveAfter: ReadonlySet<CFGInstruction>,
  ): Iterable<CFGInstruction> {
    return this.buildsHere(node) ? new Set([...liveAfter, ...node.inputs]) : liveAfter;
  }

  private stringOriginOf(value: CFGInstruction): CFGInstruction | null {
    return this.borrowedFrom.get(value) ?? this.bufferByValue.get(value)?.producer ?? null;
  }

  private overwritesSameBuffer(
    node: CFGInstruction,
    liveAfter: ReadonlySet<CFGInstruction>,
  ): boolean {
    const model = this.bufferByValue.get(node);
    if (model === undefined || !model.producers.has(node)) return false;
    for (const value of liveAfter) {
      if (value === node || node.inputs.includes(value)) continue;
      if (this.bufferByValue.get(value) === model) return true;
    }
    return false;
  }

  private checkInvalidation(node: CFGInstruction, liveAfter: ReadonlySet<CFGInstruction>): void {
    if (this.overwritesSameBuffer(node, liveAfter)) {
      this.fail(
        `${this.graph.name} builds two strings into the same storage while both are still ` +
          `in use; a string lives only until the storage behind it is written again, so use ` +
          `each where it is built, copy it into an object field, or keep this part interpreted`,
      );
      return;
    }
    if (
      !this.buildsHere(node) &&
      node.type !== IR_CALL_KNOWN_FUNCTION &&
      node.type !== IR_STORE_TEXT
    ) {
      return;
    }
    for (const value of this.exposedAt(node, liveAfter)) {
      const origin = this.stringOriginOf(value);
      if (origin === null || origin === node) continue;
      const overwrites = this.invalidates(node, origin);
      if (overwrites === null) continue;
      this.fail(
        `${this.graph.name} keeps ${this.borrowedName(origin)} across ${overwrites}, which ` +
          `can overwrite it; a string lives only until the storage behind it is ` +
          `written again, so use it before that point, copy it into an object field, or keep ` +
          `this part interpreted`,
      );
      return;
    }
  }

  private argumentsMatchShapes(
    node: CFGInstruction,
    declared: DeclaredSignature,
    name: string,
  ): boolean {
    const classes = this.graph.classes;
    if (classes === null) return true;
    for (const [at, param] of declared.params.entries()) {
      const asked = shapeForDeclared(classes, param);
      if (asked === null || !isLiteralShapeName(asked.name)) continue;
      const held = this.shapeIdOfValue(node.inputs[at]!);
      if (held === null || held === asked.id) continue;
      this.fail(
        `call to ${name} passes an object laid out differently from the ` +
          `${parameterLabelOf(declared, at).name ?? `argument ${at + 1}`} it declares; give the ` +
          `object the declared type where it is written, or keep this part interpreted`,
      );
      return false;
    }
    return true;
  }

  private arraysMatchDeclarations(node: CFGInstruction): boolean {
    const classes = this.graph.classes;
    if (classes === null) return true;
    for (const [at, input] of node.inputs.entries()) {
      const declared = declaredTypeAt(node, at, this.graph, classes, this.types);
      const asked = arrayModelForDeclaredType(declared, classes);
      if (asked === null) continue;
      const held = arrayModelOf(input, this.graph, classes, this.types);
      if (held === null || elementsAgree(held, asked)) continue;
      this.fail(
        `${arrayCrossingOf(node)} an array of ${held.declaredType} where ${declared} is ` +
          `declared, and the two are laid out differently; build the array with the declared ` +
          `element type, or keep this part interpreted`,
      );
      return false;
    }
    return true;
  }

  private shapeIdOfValue(value: CFGInstruction): number | null {
    const carried = value.props[VALUE_CLASS_PROP];
    if (typeof carried === "number") return carried;
    const held = this.types.typeOf(value);
    return held.kind === TypeKind.Object && typeof held.map === "number" ? held.map : null;
  }

  private borrowsPrivateStorage(origin: CFGInstruction): boolean {
    let held = this.privateStorage.get(origin);
    if (held === undefined) {
      held = privateStorage(origin);
      this.privateStorage.set(origin, held);
    }
    return held;
  }

  private reentersFrom(node: CFGInstruction): boolean {
    const model = this.graph.stringEscapes;
    const callee = calleeSymbolName(node);
    return model !== null && callee !== null && model.reenters(callee, this.graph.name);
  }

  private invalidates(node: CFGInstruction, origin: CFGInstruction): string | null {
    const model = this.graph.stringEscapes;
    if (model === null) return null;
    if (this.rules.ownsBuffer(origin)) {
      if (node.type !== IR_CALL_KNOWN_FUNCTION || !this.reentersFrom(node)) return null;
      return `a call to ${calleeSymbolName(node)}`;
    }
    if (this.borrowsPrivateStorage(origin)) return null;
    if (this.buildsHere(node)) {
      const owner = calleeSymbolName(origin);
      return owner !== null && model.reenters(owner, this.graph.name)
        ? `more string building in ${this.graph.name}`
        : null;
    }
    if (node.type === IR_STORE_TEXT) {
      if (writesElsewhere(node, origin)) return null;
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
    if (this.rules.ownsBuffer(origin)) return "the string it built";
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

  private namesOneBuffer(model: AotStringBuffer, aliases: ReadonlySet<CFGInstruction>): boolean {
    const carried: CFGInstruction[] = [];
    for (const value of aliases) if (value.type === IR_PHI) carried.push(value);
    if (model.producers.size === 1 && carried.length <= 1) return true;
    return mergedTextInputs(carried, aliases).length === 0;
  }

  private bindStringBufferAliases(model: AotStringBuffer): boolean {
    const aliases = new Set<CFGInstruction>();
    for (const producer of model.producers) {
      const walk = this.rules.walk(producer);
      if (walk.escape !== null) {
        this.fail(this.escapeReason(producer, walk.escape));
        return false;
      }
      for (const value of walk.aliases) aliases.add(value);
    }
    if (!this.namesOneBuffer(model, aliases)) {
      this.fail("string buffer has more than one loop-carried alias");
      return false;
    }

    for (const value of aliases) {
      if (!this.bufferByValue.has(value)) this.bufferByValue.set(value, model);
    }
    return true;
  }

  private absenceScalarOf(node: CFGInstruction): AotScalar {
    for (const use of node.uses) {
      if (this.readsAbsenceAsNumber(use, node)) return SCALAR_FLOAT64;
    }
    return SCALAR_POINTER;
  }

  private passedAsNumber(use: CFGInstruction, absence: CFGInstruction): boolean {
    const declared = calleeDeclaredSignature(use)?.params[use.inputs.indexOf(absence)] ?? null;
    return declaredAotScalar(declared, this.graph.classes) === SCALAR_FLOAT64;
  }

  private readsAbsenceAsNumber(use: CFGInstruction, absence: CFGInstruction): boolean {
    if (use.type === IR_STORE_FIELD) return use.props[FIELD_SCALAR_PROP] === SCALAR_FLOAT64;
    if (use.type === IR_STORE_ELEMENT) return heapElementScalarOf(use) === SCALAR_FLOAT64;
    if (use.type === IR_RETURN) return this.declaredReturnScalar() === SCALAR_FLOAT64;
    if (use.type === IR_CALL_KNOWN_FUNCTION) return this.passedAsNumber(use, absence);
    return use.inputs.some((input) => {
      if (input === absence) return false;
      const scalar = this.numericScalarOf(input);
      return scalar !== null && isNumericScalar(scalar);
    });
  }

  private numericScalarOf(value: CFGInstruction): AotScalar | null {
    if (isAbsenceConstant(value)) return null;
    return (
      this.laidOutScalarOf(value) ??
      this.answeredScalarOf(value) ??
      aotScalarOf(this.types.typeOf(value))
    );
  }

  private inferVoidReturn(): boolean {
    const declared = this.graph.declaredSignature?.returns;
    if (!isUnwritten(declared)) return this.declaredReturnScalar() === SCALAR_VOID;
    return aotScalarOf(this.returnedType() ?? anyType()) === SCALAR_VOID;
  }

  absenceComparesAsNumber(node: CFGInstruction): boolean {
    const present = node.inputs.find((input) => !isAbsenceConstant(input));
    return present !== undefined && this.comparedScalarOf(present) === SCALAR_FLOAT64;
  }

  private declaredReturnScalar(): AotScalar | null {
    return declaredAotScalar(this.graph.declaredSignature?.returns, this.graph.classes);
  }

  private answeredScalarOf(value: CFGInstruction): AotScalar | null {
    const returns = calleeDeclaredSignature(value)?.returns;
    if (typeof returns !== "string") return null;
    const declared = declaredAotScalar(returns, this.graph.classes);
    if (declared === SCALAR_CODE) return declared;
    return declaredAcceptsNull(returns) ? declared : null;
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

  codeSignatureOf(value: CFGInstruction | undefined): DeclaredSignature | null {
    if (value === undefined) return null;
    if (value.type === IR_CONSTANT) {
      const compiled = compiledFunctionConstant(value.props.value);
      return compiled?.declaredSignature ?? null;
    }
    if (value.type === IR_CALL_KNOWN_FUNCTION) {
      const answered = calleeDeclaredSignature(value)?.returns;
      return typeof answered === "string" ? functionSignatureOf(answered) : null;
    }
    if (value.type === IR_LOAD_GLOBAL) {
      const named = codeSymbolOf(value);
      const target = named === null ? null : this.graph.calleeSignatures?.get(named) ?? null;
      if (target !== null) return target;
    }
    const declared =
      value.type === IR_PARAMETER
        ? this.graph.declaredSignature?.params[Number(value.props.index)] ?? null
        : value.props[FIELD_TYPE_PROP];
    return typeof declared === "string" ? functionSignatureOf(declared) : null;
  }

  private checkCallThrough(node: CFGInstruction): boolean {
    const callee = node.inputs[0];
    if (callee === undefined) return false;
    if (this.scalarOf(callee) !== SCALAR_CODE) return false;
    const signature = this.codeSignatureOf(callee);
    if (signature === null) {
      this.fail("call through a function value whose type the compiler cannot tell");
      return true;
    }
    const args = callThroughArguments(node);
    if (signature.params.length !== args.length) {
      this.fail(
        `call through a function value passes ${args.length} of ${signature.params.length} arguments`,
      );
      return true;
    }
    const returns = declaredAotScalar(signature.returns, this.graph.classes);
    if (returns === null) {
      this.fail("call through a function value answers a type the compiler cannot lay out");
      return true;
    }
    this.scalars.set(node, returns);
    return true;
  }

  private checkTextStore(node: CFGInstruction): boolean {
    const stored = node.inputs[1];
    if (!isConstantText(stored)) return false;
    const text = String(stored!.props.value);
    const capacity = textCapacityOf(node);
    if (text.length < capacity) return false;
    const field = node.props.propName;
    const where = typeof field === "string" ? field : "a field";
    this.fail(
      `${this.graph.name} stores a string of ${text.length} characters in ${where}, which ` +
        `holds ${capacity - 1}; shorten it, or keep this part interpreted`,
    );
    return true;
  }

  private checkConstant(node: CFGInstruction): void {
    const value = node.props.value;
    if (typeof value === "string") {
      if (!isAsciiRepresentable(value)) {
        this.fail("string constant is not representable as ASCII");
      } else if (value.length >= this.graph.textBufferBytes) {
        this.fail(
          `string constant is longer than the ${this.graph.textBufferBytes - 1} characters a ` +
            `compiled string holds; raise it with --text-size, or keep this part interpreted`,
        );
      } else {
        this.scalars.set(node, SCALAR_STRING);
      }
      return;
    }
    if (value === null) {
      this.scalars.set(node, this.absenceScalarOf(node));
      return;
    }
    if (codeSymbolOf(node) !== null) {
      this.scalars.set(node, SCALAR_CODE);
      return;
    }
    const compiled = compiledFunctionConstant(value);
    if (compiled !== null) {
      this.fail(functionValueReason(node, compiled.name ?? "a function"));
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
    if (node.type === IR_GENERIC_CALL && this.checkCallThrough(node)) return;
    const rejection = REJECTIONS.get(node.type);
    if (rejection !== undefined) {
      this.fail(rejection(node));
      return;
    }
    if (node.props[NAMED_ARGUMENTS_PROP] !== undefined) {
      this.fail("call has named arguments that do not match the callee parameters");
      return;
    }
    const emitted = this.graph.emits ?? AOT_OPCODES;
    if (!emitted.has(node.type) && !this.buildsHere(node)) {
      this.fail(`unsupported opcode ${node.type}`);
      return;
    }
    if (node.type === IR_LOAD_GLOBAL) {
      if (codeSymbolOf(node) !== null) {
        this.scalars.set(node, SCALAR_CODE);
        return;
      }
      if (node.uses.length > 0) this.fail(globalValueReason(node, this.graph.classes));
      return;
    }
    if (node.type === IR_RUNTIME_BASE) {
      this.scalars.set(node, SCALAR_POINTER);
      return;
    }
    if (node.type === IR_STORE_TEXT && this.checkTextStore(node)) return;
    if (!this.arraysMatchDeclarations(node)) return;
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
      if (declared !== null && !this.argumentsMatchShapes(node, declared, name)) return;
    }
    if (node.type === IR_CALL_BUILTIN) {
      this.checkBuiltin(node);
      if (this.failure !== null) return;
    }
    if (node.props[SPREAD_ARGUMENTS_PROP] === true) {
      this.fail(SPREAD_CALL_REASON);
      return;
    }
    if (node.type === IR_GENERIC_COMPARE && !this.checkStringCompare(node)) return;
    if (node.type === IR_FLOAT64_COMPARE && this.comparesReferences(node)) {
      if (!EQUALITY_OPERATORS.has(String(node.props.op))) {
        this.fail("references can only be compared for equality");
        return;
      }
      this.scalars.set(node, SCALAR_INT32);
    }
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
    const index = this.require(node.inputs[1]!, node.type);
    if (index === null) return;
    if (!isNumericScalar(index)) {
      this.fail(`${node.type} is indexed by a value that is not a number`);
      return;
    }
    const stored = node.inputs[2];
    if (stored !== undefined) {
      const value = this.require(stored, node.type);
      if (value === null) return;
      const copiesText = element === SCALAR_TEXT && value === SCALAR_STRING;
      if (!copiesText && value !== element && (isReferenceScalar(value) || isReferenceScalar(element))) {
        this.fail("array has an unsupported element type");
        return;
      }
    }
    this.scalars.set(node, element === SCALAR_TEXT ? SCALAR_STRING : element);
  }

  private comparedScalarOf(value: CFGInstruction): AotScalar | null {
    return (
      this.scalars.get(value) ??
      this.laidOutScalarOf(value) ??
      this.answeredScalarOf(value) ??
      aotScalarOf(this.types.typeOf(value))
    );
  }

  comparesReferences(node: CFGInstruction): boolean {
    return node.inputs.every((input) => this.comparedScalarOf(input) === SCALAR_POINTER);
  }

  comparesAbsentNumber(node: CFGInstruction): boolean {
    if (!EQUALITY_OPERATORS.has(String(node.props.op))) return false;
    if (!node.inputs.some((input) => isAbsenceConstant(input))) return false;
    return node.inputs.every((input) => this.comparedScalarOf(input) === SCALAR_FLOAT64);
  }

  comparesAbsentReference(node: CFGInstruction): boolean {
    if (!EQUALITY_OPERATORS.has(String(node.props.op))) return false;
    const absent = node.inputs.find((input) => isAbsenceConstant(input));
    if (absent === undefined) return false;
    const present = node.inputs.find((input) => input !== absent);
    const scalar = present === undefined ? null : this.comparedScalarOf(present);
    return scalar !== null && isReferenceScalar(scalar);
  }

  private checkStringCompare(node: CFGInstruction): boolean {
    if (this.comparesAbsentReference(node)) {
      this.scalars.set(node, SCALAR_INT32);
      return true;
    }
    const strings = node.inputs.every(
      (input) => this.comparedScalarOf(input) === SCALAR_STRING,
    );
    if (strings) return true;
    if (this.comparesReferences(node) && EQUALITY_OPERATORS.has(String(node.props.op))) {
      this.scalars.set(node, SCALAR_INT32);
      return true;
    }
    if (this.comparesAbsentNumber(node)) {
      this.scalars.set(node, SCALAR_INT32);
      return true;
    }
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
      const answered = this.scalars.has(node.inputs[index]!);
      const actual = this.require(node.inputs[index]!, node.type);
      if (actual === null) return;
      if (declared === ANY_SCALAR) {
        if (name !== PRINT_BUILTIN) continue;
        if (!answered && this.types.typeOf(node.inputs[index]!).kind === TypeKind.Any) {
          this.fail(
            `${name} is given a value whose type the compiler cannot tell; annotate the ` +
              `function it comes from, or keep this part interpreted`,
          );
          return;
        }
        if (!AOT_PRINTABLE.has(actual)) {
          this.fail(`${name} cannot format a ${actual} value`);
          return;
        }
        continue;
      }
      const expected = builtinOperandScalar(declared);
      const stringMismatch =
        (expected === SCALAR_STRING || actual === SCALAR_STRING) && expected !== actual;
      if (expected === null || stringMismatch) {
        this.fail(
          `${name} is given a ${actual} where it takes ${expected ?? declared}, which the ` +
            `compiler cannot pass; keep this part interpreted`,
        );
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
    this.returnScalar = returnScalar;
    this.checkReturnScalarAgreement();
    if (this.failure !== null) return;
    const undeclared = undeclaredParameterOf(this.graph);
    if (undeclared !== null) {
      this.fail(undeclaredParameterReason(this.graph.declaredSignature, undeclared));
      return;
    }
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

  private returnedScalarOf(returned: CFGInstruction): AotScalar | null {
    if (returned.type === IR_CONSTANT) {
      const value = returned.props.value;
      if (typeof value === "string") return SCALAR_STRING;
      if (value === null) return null;
      return value === 0 ? null : SCALAR_FLOAT64;
    }
    return this.scalars.get(returned) ?? aotScalarOf(this.types.typeOf(returned));
  }

  private answersAbsenceUndeclared(returned: CFGInstruction): boolean {
    if (!isAbsenceConstant(returned)) return false;
    const declared = this.graph.declaredSignature?.returns;
    if (isUnwritten(declared) || declaredAcceptsNull(declared)) return false;
    return !isReferenceScalar(this.returnScalar);
  }

  private checkReturnScalarAgreement(): void {
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_RETURN || isPendingThrowReturn(node)) continue;
        const returned = node.inputs[0];
        if (returned === undefined) continue;
        if (this.answersAbsenceUndeclared(returned)) {
          this.fail(
            `function answers null where its return type has no null; declare the ` +
              `return type as one that can be null, or keep this part interpreted`,
          );
          return;
        }
        const scalar = this.returnedScalarOf(returned);
        if (scalar === null || scalar === this.returnScalar) continue;
        if (!isReferenceScalar(scalar) && !isReferenceScalar(this.returnScalar)) continue;
        this.fail(
          scalar === SCALAR_STRING
            ? "function returns a string but its return type is not a string"
            : "function returns a value that does not match its return type",
        );
        return;
      }
    }
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
      const nullable = declaredAcceptsNull(declared);
      const scalar = this.declaredReturnScalar();
      if (nullable && scalar === null) {
        this.fail(
          `${declared} is a string that can also be null, which has no compiled ` +
            `representation; return a reference type or a plain string, or keep this ` +
            `part interpreted`,
        );
        return null;
      }
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
