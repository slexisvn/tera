import type { CFGInstruction, IRMetadataValue } from "./index.js";
import { CLASS_ID_PROP, FIELD_TYPE_PROP } from "../metadata/class-table.js";
import {
  builtinMemberType,
  type BuiltinMemberType,
} from "../types/declared.js";
import {
  ELEMENT_REP_FLOAT64,
  ELEMENT_REP_INT32,
  elementsKindFor,
  latticeFromElementRep,
  latticeFromElementsKind,
} from "../types/elements.js";
import {
  anyType,
  arrayType,
  booleanType,
  doubleType,
  joinTypes,
  narrowType,
  neverType,
  numberType,
  objectType,
  smiType,
  stringType,
  typeFromConstant,
  TypeKind,
  type LatticeType,
} from "../types/lattice.js";

export const IR_PARAMETER = "Parameter";
export const IR_CONSTANT = "Constant";
export const IR_CHECK_MAP = "CheckMap";
export const IR_CHECK_SMI = "CheckSmi";
export const IR_CHECK_NUMBER = "CheckNumber";
export const IR_CHECK_CALL_TARGET = "CheckCallTarget";
export const IR_CALL_KNOWN_FUNCTION = "CallKnownFunction";
export const IR_INT32_ADD = "Int32Add";
export const IR_INT32_SUB = "Int32Sub";
export const IR_INT32_MUL = "Int32Mul";
export const IR_INT32_DIV = "Int32Div";
export const IR_INT32_MOD = "Int32Mod";
export const IR_FLOAT64_ADD = "Float64Add";
export const IR_FLOAT64_SUB = "Float64Sub";
export const IR_FLOAT64_MUL = "Float64Mul";
export const IR_FLOAT64_DIV = "Float64Div";
export const IR_INT32_COMPARE = "Int32Compare";
export const IR_FLOAT64_COMPARE = "Float64Compare";
export const IR_LOAD_FIELD = "LoadField";
export const IR_STORE_FIELD = "StoreField";
export const IR_LOAD_TEXT = "LoadText";
export const IR_STORE_TEXT = "StoreText";
export const IR_GENERIC_ADD = "GenericAdd";
export const IR_GENERIC_SUB = "GenericSub";
export const IR_GENERIC_MUL = "GenericMul";
export const IR_GENERIC_DIV = "GenericDiv";
export const IR_GENERIC_MOD = "GenericMod";
export const IR_GENERIC_COMPARE = "GenericCompare";
export const IR_CHECK_ARRAY = "CheckArray";
export const IR_CHECK_ELEMENTS_KIND = "CheckElementsKind";
export const IR_CHECK_BOUNDS = "CheckBounds";
export const IR_LOAD_ARRAY_LENGTH = "LoadArrayLength";
export const IR_LOAD_ELEMENT = "LoadElement";
export const IR_STORE_ELEMENT = "StoreElement";
export const IR_POLYMORPHIC_LOAD = "PolymorphicLoad";
export const IR_POLYMORPHIC_STORE = "PolymorphicStore";
export const IR_GENERIC_GET_PROP = "GenericGetProp";
export const IR_GENERIC_SET_PROP = "GenericSetProp";
export const IR_GENERIC_DELETE_PROP = "GenericDeleteProp";
export const IR_GENERIC_CALL = "GenericCall";
export const IR_LOAD_LOCAL = "LoadLocal";
export const IR_STORE_LOCAL = "StoreLocal";
export const IR_LOAD_CONTEXT_SLOT = "LoadContextSlot";
export const IR_STORE_CONTEXT_SLOT = "StoreContextSlot";
export const IR_LOAD_GLOBAL = "LoadGlobal";
export const IR_STORE_GLOBAL = "StoreGlobal";
export const IR_BRANCH = "Branch";
export const IR_JUMP = "Jump";
export const IR_RETURN = "Return";
export const IR_DEOPTIMIZE = "Deoptimize";
export const IR_PHI = "Phi";
export const IR_BOX = "Box";
export const IR_UNBOX = "Unbox";
export const IR_LOAD_CONST = "LoadConst";
export const IR_CALL_BUILTIN = "CallBuiltin";
export const IR_CALL_INTRINSIC = "CallIntrinsic";
export const IR_NEW_OBJECT = "NewObject";
export const IR_RUNTIME_BASE = "RuntimeBase";
export const IR_AWAIT = "Await";
export const IR_ITERATOR_INIT = "IteratorInit";
export const IR_ITERATOR_NEXT = "IteratorNext";
export const IR_ITERATOR_DONE = "IteratorDone";
export const IR_ITERATOR_VALUE = "IteratorValue";
export const IR_NEW_ARRAY = "NewArray";
export const IR_ARRAY_RESERVE = "ArrayReserve";
export const IR_MAKE_CLOSURE = "MakeClosure";
export const IR_TYPEOF = "TypeOf";
export const IR_NOT = "Not";
export const IR_NEG = "Neg";
export const IR_GENERIC_GET_INDEX = "GenericGetIndex";
export const IR_GENERIC_SET_INDEX = "GenericSetIndex";
export const IR_INT32_SHL = "Int32Shl";
export const IR_INT32_SHR = "Int32Shr";
export const IR_INT32_USHR = "Int32Ushr";
export const IR_INT32_AND = "Int32And";
export const IR_INT32_OR = "Int32Or";
export const IR_INT32_XOR = "Int32Xor";
export const IR_INT32_NOT = "Int32Not";
export const IR_FLOAT64_POW = "Float64Pow";
export const IR_GENERIC_BITAND = "GenericBitwiseAnd";
export const IR_GENERIC_BITOR = "GenericBitwiseOr";
export const IR_GENERIC_BITXOR = "GenericBitwiseXor";
export const IR_GENERIC_SHL = "GenericShiftLeft";
export const IR_GENERIC_SHR = "GenericShiftRight";
export const IR_GENERIC_USHR = "GenericShiftRightLogical";
export const IR_GENERIC_POW = "GenericPow";
export const IR_GENERIC_BITNOT = "GenericBitwiseNot";
export const IR_GENERIC_INSTANCEOF = "GenericInstanceOf";
export const IR_GENERIC_IN = "GenericIn";
export const IR_DISPATCH_MAP = "DispatchMap";
export const IR_MEGAMORPHIC_LOAD = "MegamorphicLoad";
export const IR_MEGAMORPHIC_STORE = "MegamorphicStore";
export const IR_NEW_REGEX = "NewRegex";
export const IR_CHECK_PRIMITIVE = "CheckPrimitive";

export const MEMORY_NONE = "none";
export const MEMORY_IMMUTABLE = "immutable";
export const MEMORY_HEAP = "heap";
export const MEMORY_GLOBALS = "globals";
export const MEMORY_CONTEXT = "context";
export const MEMORY_FRAME = "frame";
export const MEMORY_ANY = "any";

export type MemoryKind =
  | typeof MEMORY_NONE
  | typeof MEMORY_IMMUTABLE
  | typeof MEMORY_HEAP
  | typeof MEMORY_GLOBALS
  | typeof MEMORY_CONTEXT
  | typeof MEMORY_FRAME
  | typeof MEMORY_ANY;

export const DEOPT_NEVER = "never";
export const DEOPT_ALWAYS = "always";
export const DEOPT_ON_OVERFLOW = "onOverflow";

export type DeoptMode =
  | typeof DEOPT_NEVER
  | typeof DEOPT_ALWAYS
  | typeof DEOPT_ON_OVERFLOW;

export const RESULT_NONE = "none";
export const RESULT_INT32 = "int32";
export const RESULT_FLOAT64 = "float64";
export const RESULT_BOOL = "bool";
export const RESULT_TAGGED_NUMBER = "taggedNumber";
export const RESULT_HANDLE = "handle";
export const RESULT_CONTEXTUAL = "contextual";

export type ResultClass =
  | typeof RESULT_NONE
  | typeof RESULT_INT32
  | typeof RESULT_FLOAT64
  | typeof RESULT_BOOL
  | typeof RESULT_TAGGED_NUMBER
  | typeof RESULT_HANDLE
  | typeof RESULT_CONTEXTUAL;

export const ACCESS_NONE = "none";
export const ACCESS_SLOT = "slot";
export const ACCESS_ELEMENT = "element";
export const ACCESS_PROPERTY = "property";
export const ACCESS_GLOBAL = "global";

export type MemoryAccessKind =
  | typeof ACCESS_NONE
  | typeof ACCESS_SLOT
  | typeof ACCESS_ELEMENT
  | typeof ACCESS_PROPERTY
  | typeof ACCESS_GLOBAL;

export const OVERLOAD_NONE = "none";
export const OVERLOAD_NUMERIC = "numeric";
export const OVERLOAD_POLYMORPHIC = "polymorphic";

export type OverloadKind =
  | typeof OVERLOAD_NONE
  | typeof OVERLOAD_NUMERIC
  | typeof OVERLOAD_POLYMORPHIC;

export const SPECULATION_NONE = "none";
export const SPECULATION_BASE_GUARD = "baseGuard";
export const SPECULATION_NATIVE_GUARD = "nativeGuard";

export type SpeculationRole =
  | typeof SPECULATION_NONE
  | typeof SPECULATION_BASE_GUARD
  | typeof SPECULATION_NATIVE_GUARD;

export interface OperationEffects {
  readonly reads: MemoryKind;
  readonly writes: MemoryKind;
  readonly allocates: boolean;
  readonly deopt: DeoptMode;
}

export type Arity =
  | { readonly kind: "fixed"; readonly count: number }
  | { readonly kind: "variadic"; readonly least: number };

export interface TransferNode {
  readonly type: string;
  readonly props: CFGInstruction["props"];
  readonly inputs: readonly CFGInstruction[];
  readonly uses: readonly CFGInstruction[];
}

export interface TypeContext {
  typeOf(value: CFGInstruction): LatticeType;
  returnTypeOf(node: TransferNode): LatticeType;
  declaredTypeOf?(declared: string): LatticeType;
}

export type Transfer = (node: TransferNode, context: TypeContext) => LatticeType;

export interface OperationSpec {
  readonly effects: OperationEffects | ((node: CFGInstruction) => OperationEffects);
  readonly terminator: boolean;
  readonly pinned: boolean;
  readonly removableWhenUnused: boolean;
  readonly forwardsPointerIdentity: boolean;
  readonly arity: Arity;
  readonly result: ResultClass;
  readonly operands: ResultClass;
  readonly overload: OverloadKind;
  readonly access: MemoryAccessKind;
  readonly opaqueMemory: boolean;
  readonly speculation: SpeculationRole;
  readonly transfer: Transfer;
}

function effects(
  reads: MemoryKind,
  writes: MemoryKind,
  allocates: boolean,
  deopt: DeoptMode,
): OperationEffects {
  return { reads, writes, allocates, deopt };
}

const PURE = effects(MEMORY_NONE, MEMORY_NONE, false, DEOPT_NEVER);
const PURE_OVERFLOWING = effects(MEMORY_NONE, MEMORY_NONE, false, DEOPT_ON_OVERFLOW);
const GUARD = effects(MEMORY_HEAP, MEMORY_NONE, false, DEOPT_ALWAYS);
const CONTROL_GUARD = effects(MEMORY_NONE, MEMORY_NONE, false, DEOPT_ALWAYS);
const READS_HEAP = effects(MEMORY_HEAP, MEMORY_NONE, false, DEOPT_NEVER);
const READS_HEAP_DEOPTS = effects(MEMORY_HEAP, MEMORY_NONE, false, DEOPT_ALWAYS);
const WRITES_HEAP = effects(MEMORY_NONE, MEMORY_HEAP, false, DEOPT_NEVER);
const WRITES_HEAP_DEOPTS = effects(MEMORY_NONE, MEMORY_HEAP, false, DEOPT_ALWAYS);
const READS_GLOBALS = effects(MEMORY_GLOBALS, MEMORY_NONE, false, DEOPT_NEVER);
const WRITES_GLOBALS = effects(MEMORY_NONE, MEMORY_GLOBALS, false, DEOPT_NEVER);
const READS_CONTEXT_DEOPTS = effects(MEMORY_CONTEXT, MEMORY_NONE, false, DEOPT_ALWAYS);
const WRITES_CONTEXT_DEOPTS = effects(MEMORY_NONE, MEMORY_CONTEXT, false, DEOPT_ALWAYS);
const READS_FRAME = effects(MEMORY_FRAME, MEMORY_NONE, false, DEOPT_NEVER);
const WRITES_FRAME = effects(MEMORY_NONE, MEMORY_FRAME, false, DEOPT_NEVER);
const ALLOCATES = effects(MEMORY_NONE, MEMORY_NONE, true, DEOPT_ALWAYS);
const UNKNOWN_CALL = effects(MEMORY_ANY, MEMORY_ANY, true, DEOPT_ALWAYS);
const CONTROL = effects(MEMORY_NONE, MEMORY_NONE, false, DEOPT_NEVER);

const DECLARED_WRITE = effects(MEMORY_HEAP, MEMORY_ANY, false, DEOPT_ALWAYS);
const DECLARED_ALLOCATE = effects(MEMORY_NONE, MEMORY_NONE, true, DEOPT_ALWAYS);
const IMMUTABLE_READ = effects(MEMORY_IMMUTABLE, MEMORY_NONE, false, DEOPT_NEVER);

const DECLARED_EFFECT_RESULTS: readonly (readonly [string, OperationEffects])[] = [
  ["unknown", UNKNOWN_CALL],
  ["io", UNKNOWN_CALL],
  ["write", DECLARED_WRITE],
  ["reactive-write", DECLARED_WRITE],
  ["schedule", DECLARED_WRITE],
  ["allocate", DECLARED_ALLOCATE],
  ["reactive-read", UNKNOWN_CALL],
  ["read", READS_HEAP],
  ["immutable-read", IMMUTABLE_READ],
  ["pure", PURE],
];

const DECLARED_EFFECT_CACHE = new WeakMap<object, OperationEffects>();

function resolveDeclaredEffects(declared: readonly IRMetadataValue[]): OperationEffects {
  for (const [name, result] of DECLARED_EFFECT_RESULTS) {
    if (declared.includes(name)) return result;
  }
  return UNKNOWN_CALL;
}

export function effectsForDeclaredEffects(
  declared: IRMetadataValue | undefined,
): OperationEffects {
  if (!Array.isArray(declared)) return UNKNOWN_CALL;
  const cached = DECLARED_EFFECT_CACHE.get(declared);
  if (cached !== undefined) return cached;
  const resolved = resolveDeclaredEffects(declared);
  DECLARED_EFFECT_CACHE.set(declared, resolved);
  return resolved;
}

export function isReadOnlyDeclaredEffects(declared: readonly string[]): boolean {
  const resolved = effectsForDeclaredEffects([...declared]);
  return resolved.reads !== MEMORY_NONE && resolved.writes === MEMORY_NONE && !resolved.allocates;
}

function declaredCallEffects(node: CFGInstruction): OperationEffects {
  return effectsForDeclaredEffects(node.props.declaredEffects);
}

function dispatchMapEffects(node: CFGInstruction): OperationEffects {
  return node.props.isStore === true ? WRITES_HEAP_DEOPTS : READS_HEAP_DEOPTS;
}

const NUMERIC_KINDS = new Set<string>([TypeKind.Smi, TypeKind.Double, TypeKind.Number]);

const UNBOX_RESULTS = new Map<string, LatticeType>([
  [ELEMENT_REP_INT32, smiType()],
  [ELEMENT_REP_FLOAT64, doubleType()],
  ["bool", booleanType()],
]);

function isNumeric(type: LatticeType): boolean {
  return NUMERIC_KINDS.has(type.kind);
}

function inputType(node: TransferNode, index: number, context: TypeContext): LatticeType {
  const input = node.inputs[index];
  return input === undefined ? anyType() : context.typeOf(input);
}

function constant(result: LatticeType): Transfer {
  return () => result;
}

const ANY: Transfer = () => anyType();

export const SETTLED_TYPE_PROP = "settledType";

const allocatedObjectType: Transfer = (node) => {
  const classId = node.props[CLASS_ID_PROP];
  return objectType(typeof classId === "number" ? classId : null);
};

const declaredPropTransfer =
  (prop: string): Transfer =>
  (node, context) => {
    const declared = node.props[prop];
    if (typeof declared !== "string" || context.declaredTypeOf === undefined) return anyType();
    return context.declaredTypeOf(declared);
  };

const fieldTypeTransfer = declaredPropTransfer(FIELD_TYPE_PROP);
const settledTypeTransfer = declaredPropTransfer(SETTLED_TYPE_PROP);

const PRIMITIVE_TYPES = new Map<string, LatticeType>([
  ["string", stringType()],
  ["boolean", booleanType()],
  ["smi", smiType()],
  ["double", doubleType()],
  ["number", numberType()],
]);

export function primitiveTypeNamed(name: string): LatticeType {
  return PRIMITIVE_TYPES.get(name) ?? anyType();
}

export function isGuardablePrimitive(name: string): boolean {
  return PRIMITIVE_TYPES.has(name);
}

function guardTransfer(fact: (node: TransferNode) => LatticeType): Transfer {
  return (node, context) => narrowType(inputType(node, 0, context), fact(node));
}

function arithmeticTransfer(node: TransferNode, context: TypeContext): LatticeType {
  const left = inputType(node, 0, context);
  const right = inputType(node, 1, context);
  if (left.kind === TypeKind.Smi && right.kind === TypeKind.Smi) return smiType();
  if (isNumeric(left) && isNumeric(right)) return numberType();
  return anyType();
}

function additionTransfer(node: TransferNode, context: TypeContext): LatticeType {
  const left = inputType(node, 0, context);
  const right = inputType(node, 1, context);
  if (left.kind === TypeKind.String || right.kind === TypeKind.String) return stringType();
  return arithmeticTransfer(node, context);
}

function divisionTransfer(node: TransferNode, context: TypeContext): LatticeType {
  const left = inputType(node, 0, context);
  const right = inputType(node, 1, context);
  return isNumeric(left) && isNumeric(right) ? numberType() : anyType();
}

function negationTransfer(node: TransferNode, context: TypeContext): LatticeType {
  const operand = inputType(node, 0, context);
  if (operand.kind === TypeKind.Smi) return smiType();
  return isNumeric(operand) ? numberType() : anyType();
}

function phiTransfer(node: TransferNode, context: TypeContext): LatticeType {
  let merged: LatticeType | null = null;
  for (const input of node.inputs) merged = joinTypes(merged, context.typeOf(input));
  return merged ?? neverType();
}

export function storedElementValue(
  store: CFGInstruction,
  array: TransferNode,
): CFGInstruction | null {
  if (!isElementStore(store.type) || store.inputs[0] !== array) return null;
  return store.inputs[2] ?? null;
}

function newArrayTransfer(node: TransferNode, context: TypeContext): LatticeType {
  let merged: LatticeType | null = null;
  for (const input of node.inputs) merged = joinTypes(merged, context.typeOf(input));
  for (const use of node.uses) {
    const stored = storedElementValue(use, node);
    if (stored !== null) merged = joinTypes(merged, context.typeOf(stored));
  }
  return arrayType(merged === null ? null : elementsKindFor(merged));
}

function loadElementTransfer(node: TransferNode, context: TypeContext): LatticeType {
  const declared = latticeFromElementRep(node.props.elementRep);
  if (declared !== null) return declared;
  const container = inputType(node, 0, context);
  if (container.kind !== TypeKind.Array) return anyType();
  return latticeFromElementsKind(container.elementsKind);
}

function memberOf(node: TransferNode, context: TypeContext): BuiltinMemberType | null {
  const receiver = node.inputs[0];
  if (receiver === undefined) return null;
  return builtinMemberType(context.typeOf(receiver), String(node.props.propName));
}

function memberTransfer(node: TransferNode, context: TypeContext): LatticeType {
  const member = memberOf(node, context);
  return member !== null && member.getter ? member.type : anyType();
}

function callTransfer(node: TransferNode, context: TypeContext): LatticeType {
  const callee = node.inputs[0];
  if (callee !== undefined && callee.type === IR_GENERIC_GET_PROP) {
    const member = memberOf(callee, context);
    if (member !== null && !member.getter) return member.type;
  }
  return context.returnTypeOf(node);
}

function declaredReturnTransfer(node: TransferNode, context: TypeContext): LatticeType {
  return context.returnTypeOf(node);
}

function boxTransfer(node: TransferNode, context: TypeContext): LatticeType {
  return node.props.toType === "handle" ? anyType() : inputType(node, 0, context);
}

function unboxTransfer(node: TransferNode): LatticeType {
  return UNBOX_RESULTS.get(String(node.props.toType)) ?? anyType();
}

function passthroughTransfer(node: TransferNode, context: TypeContext): LatticeType {
  return inputType(node, 0, context);
}

const fixed = (count: number): Arity => ({ kind: "fixed", count });
const variadic = (least: number): Arity => ({ kind: "variadic", least });

const NO_INPUTS = fixed(0);
const ONE_INPUT = fixed(1);
const TWO_INPUTS = fixed(2);
const THREE_INPUTS = fixed(3);

function pureValue(arity: Arity, result: ResultClass, transfer: Transfer): OperationSpec {
  return {
    effects: PURE,
    terminator: false,
    pinned: false,
    removableWhenUnused: true,
    forwardsPointerIdentity: false,
    arity,
    result,
    operands: RESULT_NONE,
    overload: OVERLOAD_NONE,
    access: ACCESS_NONE,
    opaqueMemory: false,
    speculation: SPECULATION_NONE,
    transfer,
  };
}

function binaryInt32(): OperationSpec {
  return { ...pureValue(TWO_INPUTS, RESULT_INT32, constant(smiType())), operands: RESULT_INT32 };
}

function binaryFloat64(): OperationSpec {
  return { ...pureValue(TWO_INPUTS, RESULT_FLOAT64, constant(doubleType())), operands: RESULT_FLOAT64 };
}

function overflowingInt32(): OperationSpec {
  return { ...binaryInt32(), effects: PURE_OVERFLOWING };
}

function guard(
  arity: Arity,
  result: ResultClass,
  transfer: Transfer,
  speculation: SpeculationRole,
  forwardsPointerIdentity = false,
): OperationSpec {
  return {
    effects: GUARD,
    terminator: false,
    pinned: false,
    removableWhenUnused: false,
    forwardsPointerIdentity,
    arity,
    result,
    operands: RESULT_NONE,
    overload: OVERLOAD_NONE,
    access: ACCESS_NONE,
    opaqueMemory: false,
    speculation,
    transfer,
  };
}

function memoryOp(
  operationEffects: OperationSpec["effects"],
  arity: Arity,
  result: ResultClass,
  transfer: Transfer,
  removableWhenUnused: boolean,
): OperationSpec {
  return {
    effects: operationEffects,
    terminator: false,
    pinned: false,
    removableWhenUnused,
    forwardsPointerIdentity: false,
    arity,
    result,
    operands: RESULT_NONE,
    overload: OVERLOAD_NONE,
    access: ACCESS_NONE,
    opaqueMemory: false,
    speculation: SPECULATION_NONE,
    transfer,
  };
}

function load(
  operationEffects: OperationSpec["effects"],
  arity: Arity,
  result: ResultClass,
  transfer: Transfer,
): OperationSpec {
  return memoryOp(operationEffects, arity, result, transfer, true);
}

function store(
  operationEffects: OperationSpec["effects"],
  arity: Arity,
): OperationSpec {
  return memoryOp(operationEffects, arity, RESULT_NONE, ANY, false);
}

function call(arity: Arity, result: ResultClass, transfer: Transfer): OperationSpec {
  return memoryOp(declaredCallEffects, arity, result, transfer, true);
}

function allocation(arity: Arity, result: ResultClass, transfer: Transfer): OperationSpec {
  return memoryOp(ALLOCATES, arity, result, transfer, false);
}

function terminator(
  arity: Arity,
  operands: ResultClass = RESULT_NONE,
): OperationSpec {
  return {
    effects: CONTROL,
    terminator: true,
    pinned: false,
    removableWhenUnused: false,
    forwardsPointerIdentity: false,
    arity,
    result: RESULT_NONE,
    operands,
    overload: OVERLOAD_NONE,
    access: ACCESS_NONE,
    opaqueMemory: false,
    speculation: SPECULATION_NONE,
    transfer: ANY,
  };
}

function pinned(arity: Arity, result: ResultClass, transfer: Transfer): OperationSpec {
  return { ...pureValue(arity, result, transfer), pinned: true };
}

export type Opcode =
  | typeof IR_PARAMETER
  | typeof IR_CONSTANT
  | typeof IR_CHECK_MAP
  | typeof IR_CHECK_SMI
  | typeof IR_CHECK_NUMBER
  | typeof IR_CHECK_CALL_TARGET
  | typeof IR_CALL_KNOWN_FUNCTION
  | typeof IR_INT32_ADD
  | typeof IR_INT32_SUB
  | typeof IR_INT32_MUL
  | typeof IR_INT32_DIV
  | typeof IR_INT32_MOD
  | typeof IR_FLOAT64_ADD
  | typeof IR_FLOAT64_SUB
  | typeof IR_FLOAT64_MUL
  | typeof IR_FLOAT64_DIV
  | typeof IR_INT32_COMPARE
  | typeof IR_FLOAT64_COMPARE
  | typeof IR_LOAD_FIELD
  | typeof IR_STORE_FIELD
  | typeof IR_LOAD_TEXT
  | typeof IR_STORE_TEXT
  | typeof IR_GENERIC_ADD
  | typeof IR_GENERIC_SUB
  | typeof IR_GENERIC_MUL
  | typeof IR_GENERIC_DIV
  | typeof IR_GENERIC_MOD
  | typeof IR_GENERIC_COMPARE
  | typeof IR_CHECK_ARRAY
  | typeof IR_CHECK_ELEMENTS_KIND
  | typeof IR_CHECK_BOUNDS
  | typeof IR_LOAD_ARRAY_LENGTH
  | typeof IR_LOAD_ELEMENT
  | typeof IR_STORE_ELEMENT
  | typeof IR_POLYMORPHIC_LOAD
  | typeof IR_POLYMORPHIC_STORE
  | typeof IR_GENERIC_GET_PROP
  | typeof IR_GENERIC_SET_PROP
  | typeof IR_GENERIC_DELETE_PROP
  | typeof IR_GENERIC_CALL
  | typeof IR_LOAD_LOCAL
  | typeof IR_STORE_LOCAL
  | typeof IR_LOAD_CONTEXT_SLOT
  | typeof IR_STORE_CONTEXT_SLOT
  | typeof IR_LOAD_GLOBAL
  | typeof IR_STORE_GLOBAL
  | typeof IR_BRANCH
  | typeof IR_JUMP
  | typeof IR_RETURN
  | typeof IR_DEOPTIMIZE
  | typeof IR_PHI
  | typeof IR_BOX
  | typeof IR_UNBOX
  | typeof IR_LOAD_CONST
  | typeof IR_CALL_BUILTIN
  | typeof IR_CALL_INTRINSIC
  | typeof IR_NEW_OBJECT
  | typeof IR_RUNTIME_BASE
  | typeof IR_AWAIT
  | typeof IR_ITERATOR_INIT
  | typeof IR_ITERATOR_NEXT
  | typeof IR_ITERATOR_DONE
  | typeof IR_ITERATOR_VALUE
  | typeof IR_NEW_ARRAY
  | typeof IR_ARRAY_RESERVE
  | typeof IR_MAKE_CLOSURE
  | typeof IR_TYPEOF
  | typeof IR_NOT
  | typeof IR_NEG
  | typeof IR_GENERIC_GET_INDEX
  | typeof IR_GENERIC_SET_INDEX
  | typeof IR_INT32_SHL
  | typeof IR_INT32_SHR
  | typeof IR_INT32_USHR
  | typeof IR_INT32_AND
  | typeof IR_INT32_OR
  | typeof IR_INT32_XOR
  | typeof IR_INT32_NOT
  | typeof IR_FLOAT64_POW
  | typeof IR_GENERIC_BITAND
  | typeof IR_GENERIC_BITOR
  | typeof IR_GENERIC_BITXOR
  | typeof IR_GENERIC_SHL
  | typeof IR_GENERIC_SHR
  | typeof IR_GENERIC_USHR
  | typeof IR_GENERIC_POW
  | typeof IR_GENERIC_BITNOT
  | typeof IR_GENERIC_INSTANCEOF
  | typeof IR_GENERIC_IN
  | typeof IR_DISPATCH_MAP
  | typeof IR_MEGAMORPHIC_LOAD
  | typeof IR_MEGAMORPHIC_STORE
  | typeof IR_NEW_REGEX
  | typeof IR_CHECK_PRIMITIVE;

export const OPERATIONS = {
  [IR_PARAMETER]: pinned(NO_INPUTS, RESULT_HANDLE, ANY),
  [IR_PHI]: pinned(variadic(0), RESULT_CONTEXTUAL, phiTransfer),
  [IR_CONSTANT]: pureValue(NO_INPUTS, RESULT_CONTEXTUAL, (node) =>
    typeFromConstant(node.props.value),
  ),
  [IR_LOAD_CONST]: pureValue(NO_INPUTS, RESULT_HANDLE, ANY),

  [IR_CHECK_MAP]: guard(
    ONE_INPUT,
    RESULT_CONTEXTUAL,
    guardTransfer((node) => objectType(node.props.expectedMapId ?? null)),
    SPECULATION_NONE,
    true,
  ),
  [IR_CHECK_SMI]: guard(
    ONE_INPUT,
    RESULT_CONTEXTUAL,
    guardTransfer(() => smiType()),
    SPECULATION_BASE_GUARD,
  ),
  [IR_CHECK_NUMBER]: guard(
    ONE_INPUT,
    RESULT_CONTEXTUAL,
    guardTransfer(() => numberType()),
    SPECULATION_BASE_GUARD,
  ),
  [IR_CHECK_CALL_TARGET]: guard(
    ONE_INPUT,
    RESULT_BOOL,
    constant(booleanType()),
    SPECULATION_NATIVE_GUARD,
  ),
  [IR_CHECK_ARRAY]: guard(
    ONE_INPUT,
    RESULT_CONTEXTUAL,
    guardTransfer(() => arrayType(null)),
    SPECULATION_NATIVE_GUARD,
    true,
  ),
  [IR_CHECK_ELEMENTS_KIND]: guard(
    ONE_INPUT,
    RESULT_CONTEXTUAL,
    guardTransfer((node) => arrayType(node.props.elementsKind ?? null)),
    SPECULATION_NATIVE_GUARD,
    true,
  ),
  [IR_CHECK_PRIMITIVE]: guard(
    ONE_INPUT,
    RESULT_CONTEXTUAL,
    guardTransfer((node) => primitiveTypeNamed(String(node.props.primitive))),
    SPECULATION_BASE_GUARD,
  ),
  [IR_CHECK_BOUNDS]: guard(
    TWO_INPUTS,
    RESULT_CONTEXTUAL,
    passthroughTransfer,
    SPECULATION_NATIVE_GUARD,
  ),

  [IR_INT32_ADD]: overflowingInt32(),
  [IR_INT32_SUB]: overflowingInt32(),
  [IR_INT32_MUL]: overflowingInt32(),
  [IR_INT32_DIV]: binaryInt32(),
  [IR_INT32_MOD]: binaryInt32(),
  [IR_INT32_SHL]: binaryInt32(),
  [IR_INT32_SHR]: binaryInt32(),
  [IR_INT32_AND]: binaryInt32(),
  [IR_INT32_OR]: binaryInt32(),
  [IR_INT32_XOR]: binaryInt32(),
  [IR_INT32_NOT]: { ...pureValue(ONE_INPUT, RESULT_INT32, constant(smiType())), operands: RESULT_INT32 },
  [IR_INT32_USHR]: { ...pureValue(TWO_INPUTS, RESULT_TAGGED_NUMBER, constant(numberType())), operands: RESULT_INT32 },
  [IR_INT32_COMPARE]: { ...pureValue(TWO_INPUTS, RESULT_BOOL, constant(booleanType())), operands: RESULT_INT32 },

  [IR_FLOAT64_ADD]: binaryFloat64(),
  [IR_FLOAT64_SUB]: binaryFloat64(),
  [IR_FLOAT64_MUL]: binaryFloat64(),
  [IR_FLOAT64_DIV]: binaryFloat64(),
  [IR_FLOAT64_POW]: binaryFloat64(),
  [IR_FLOAT64_COMPARE]: { ...pureValue(TWO_INPUTS, RESULT_BOOL, constant(booleanType())), operands: RESULT_FLOAT64 },

  [IR_GENERIC_ADD]: { ...pureValue(TWO_INPUTS, RESULT_CONTEXTUAL, additionTransfer), overload: OVERLOAD_POLYMORPHIC },
  [IR_GENERIC_SUB]: { ...pureValue(TWO_INPUTS, RESULT_CONTEXTUAL, arithmeticTransfer), overload: OVERLOAD_NUMERIC },
  [IR_GENERIC_MUL]: { ...pureValue(TWO_INPUTS, RESULT_CONTEXTUAL, arithmeticTransfer), overload: OVERLOAD_NUMERIC },
  [IR_GENERIC_DIV]: { ...pureValue(TWO_INPUTS, RESULT_CONTEXTUAL, divisionTransfer), overload: OVERLOAD_NUMERIC },
  [IR_GENERIC_POW]: { ...pureValue(TWO_INPUTS, RESULT_CONTEXTUAL, arithmeticTransfer), overload: OVERLOAD_NUMERIC },
  [IR_GENERIC_MOD]: pureValue(TWO_INPUTS, RESULT_TAGGED_NUMBER, arithmeticTransfer),
  [IR_GENERIC_USHR]: pureValue(TWO_INPUTS, RESULT_TAGGED_NUMBER, constant(numberType())),
  [IR_GENERIC_COMPARE]: pureValue(TWO_INPUTS, RESULT_BOOL, constant(booleanType())),
  [IR_GENERIC_BITAND]: pureValue(TWO_INPUTS, RESULT_INT32, constant(smiType())),
  [IR_GENERIC_BITOR]: pureValue(TWO_INPUTS, RESULT_INT32, constant(smiType())),
  [IR_GENERIC_BITXOR]: pureValue(TWO_INPUTS, RESULT_INT32, constant(smiType())),
  [IR_GENERIC_SHL]: pureValue(TWO_INPUTS, RESULT_INT32, constant(smiType())),
  [IR_GENERIC_SHR]: pureValue(TWO_INPUTS, RESULT_INT32, constant(smiType())),
  [IR_GENERIC_BITNOT]: pureValue(ONE_INPUT, RESULT_INT32, constant(smiType())),
  [IR_GENERIC_INSTANCEOF]: pureValue(TWO_INPUTS, RESULT_CONTEXTUAL, constant(booleanType())),
  [IR_GENERIC_IN]: pureValue(TWO_INPUTS, RESULT_CONTEXTUAL, constant(booleanType())),

  [IR_TYPEOF]: pureValue(ONE_INPUT, RESULT_HANDLE, constant(stringType())),
  [IR_NOT]: pureValue(ONE_INPUT, RESULT_BOOL, constant(booleanType())),
  [IR_NEG]: pureValue(ONE_INPUT, RESULT_CONTEXTUAL, negationTransfer),
  [IR_BOX]: { ...pureValue(ONE_INPUT, RESULT_CONTEXTUAL, boxTransfer), speculation: SPECULATION_NATIVE_GUARD },
  [IR_UNBOX]: { ...pureValue(ONE_INPUT, RESULT_CONTEXTUAL, unboxTransfer), speculation: SPECULATION_NATIVE_GUARD },

  [IR_LOAD_FIELD]: {
    ...load(READS_HEAP, ONE_INPUT, RESULT_CONTEXTUAL, fieldTypeTransfer),
    access: ACCESS_SLOT,
  },
  [IR_STORE_FIELD]: { ...store(WRITES_HEAP, TWO_INPUTS), access: ACCESS_SLOT },
  [IR_LOAD_TEXT]: pureValue(ONE_INPUT, RESULT_HANDLE, constant(stringType())),
  [IR_STORE_TEXT]: store(WRITES_HEAP, TWO_INPUTS),
  [IR_LOAD_ELEMENT]: { ...load(READS_HEAP, TWO_INPUTS, RESULT_CONTEXTUAL, loadElementTransfer), access: ACCESS_ELEMENT },
  [IR_STORE_ELEMENT]: { ...store(WRITES_HEAP, THREE_INPUTS), access: ACCESS_ELEMENT },
  [IR_LOAD_ARRAY_LENGTH]: load(READS_HEAP, ONE_INPUT, RESULT_INT32, constant(smiType())),
  [IR_POLYMORPHIC_LOAD]: { ...load(READS_HEAP_DEOPTS, ONE_INPUT, RESULT_CONTEXTUAL, ANY), opaqueMemory: true },
  [IR_POLYMORPHIC_STORE]: { ...store(WRITES_HEAP_DEOPTS, TWO_INPUTS), opaqueMemory: true },
  [IR_MEGAMORPHIC_LOAD]: { ...load(READS_HEAP_DEOPTS, ONE_INPUT, RESULT_HANDLE, ANY), opaqueMemory: true },
  [IR_MEGAMORPHIC_STORE]: { ...store(WRITES_HEAP_DEOPTS, TWO_INPUTS), opaqueMemory: true },
  [IR_DISPATCH_MAP]: { ...load(dispatchMapEffects, variadic(1), RESULT_HANDLE, ANY), opaqueMemory: true },

  [IR_GENERIC_GET_PROP]: { ...load(READS_HEAP, ONE_INPUT, RESULT_HANDLE, memberTransfer), access: ACCESS_PROPERTY, opaqueMemory: true },
  [IR_GENERIC_SET_PROP]: { ...store(WRITES_HEAP, TWO_INPUTS), access: ACCESS_PROPERTY, opaqueMemory: true },
  [IR_GENERIC_DELETE_PROP]: {
    ...memoryOp(WRITES_HEAP, variadic(1), RESULT_BOOL, constant(booleanType()), false),
    access: ACCESS_PROPERTY,
    opaqueMemory: true,
  },
  [IR_GENERIC_GET_INDEX]: { ...load(READS_HEAP, TWO_INPUTS, RESULT_HANDLE, loadElementTransfer), access: ACCESS_PROPERTY, opaqueMemory: true },
  [IR_GENERIC_SET_INDEX]: { ...store(WRITES_HEAP, THREE_INPUTS), access: ACCESS_PROPERTY, opaqueMemory: true },

  [IR_LOAD_GLOBAL]: { ...load(READS_GLOBALS, NO_INPUTS, RESULT_HANDLE, ANY), access: ACCESS_GLOBAL },
  [IR_STORE_GLOBAL]: { ...store(WRITES_GLOBALS, ONE_INPUT), access: ACCESS_GLOBAL },
  [IR_LOAD_LOCAL]: pinned(NO_INPUTS, RESULT_HANDLE, ANY),
  [IR_STORE_LOCAL]: store(WRITES_FRAME, ONE_INPUT),
  [IR_LOAD_CONTEXT_SLOT]: load(READS_CONTEXT_DEOPTS, NO_INPUTS, RESULT_HANDLE, ANY),
  [IR_STORE_CONTEXT_SLOT]: { ...store(WRITES_CONTEXT_DEOPTS, ONE_INPUT), opaqueMemory: true },

  [IR_GENERIC_CALL]: call(variadic(1), RESULT_CONTEXTUAL, callTransfer),
  [IR_CALL_KNOWN_FUNCTION]: call(variadic(0), RESULT_CONTEXTUAL, declaredReturnTransfer),
  [IR_CALL_BUILTIN]: call(variadic(0), RESULT_HANDLE, declaredReturnTransfer),
  [IR_CALL_INTRINSIC]: call(variadic(0), RESULT_HANDLE, declaredReturnTransfer),

  [IR_NEW_OBJECT]: allocation(NO_INPUTS, RESULT_HANDLE, allocatedObjectType),
  [IR_RUNTIME_BASE]: pureValue(NO_INPUTS, RESULT_HANDLE, constant(objectType())),
  [IR_AWAIT]: memoryOp(WRITES_HEAP, ONE_INPUT, RESULT_HANDLE, settledTypeTransfer, false),
  [IR_ITERATOR_INIT]: pureValue(ONE_INPUT, RESULT_INT32, constant(smiType())),
  [IR_ITERATOR_NEXT]: pureValue(ONE_INPUT, RESULT_INT32, constant(smiType())),
  [IR_ITERATOR_DONE]: pureValue(ONE_INPUT, RESULT_BOOL, constant(booleanType())),
  [IR_ITERATOR_VALUE]: pureValue(ONE_INPUT, RESULT_HANDLE, ANY),
  [IR_NEW_ARRAY]: allocation(variadic(0), RESULT_HANDLE, newArrayTransfer),
  [IR_ARRAY_RESERVE]: { ...allocation(ONE_INPUT, RESULT_HANDLE, allocatedObjectType), opaqueMemory: true },
  [IR_NEW_REGEX]: allocation(NO_INPUTS, RESULT_HANDLE, constant(objectType())),
  [IR_MAKE_CLOSURE]: { ...allocation(NO_INPUTS, RESULT_HANDLE, constant(objectType())), opaqueMemory: true },

  [IR_BRANCH]: terminator(ONE_INPUT, RESULT_BOOL),
  [IR_JUMP]: terminator(NO_INPUTS),
  [IR_RETURN]: terminator(ONE_INPUT, RESULT_CONTEXTUAL),
  [IR_DEOPTIMIZE]: { ...terminator(NO_INPUTS), effects: CONTROL_GUARD },
} as const satisfies Record<Opcode, OperationSpec>;


export const ALL_OPCODES = Object.keys(OPERATIONS) as readonly Opcode[];

const UNKNOWN_OPERATION: OperationSpec = memoryOp(
  UNKNOWN_CALL,
  variadic(0),
  RESULT_HANDLE,
  ANY,
  false,
);

const OPERATION_BY_OPCODE: ReadonlyMap<string, OperationSpec> = new Map(
  Object.entries(OPERATIONS as Record<string, OperationSpec>),
);

export function isOpcode(opcode: string): opcode is Opcode {
  return OPERATION_BY_OPCODE.has(opcode);
}

export function operationOf(opcode: string): OperationSpec {
  return OPERATION_BY_OPCODE.get(opcode) ?? UNKNOWN_OPERATION;
}

export function effectsOf(node: CFGInstruction): OperationEffects {
  const spec = operationOf(node.type);
  return typeof spec.effects === "function" ? spec.effects(node) : spec.effects;
}

export function isTerminator(opcode: string): boolean {
  return operationOf(opcode).terminator;
}

export function isPinned(opcode: string): boolean {
  return operationOf(opcode).pinned;
}

export function isElementStore(opcode: string): boolean {
  return opcode === IR_STORE_ELEMENT || opcode === IR_GENERIC_SET_INDEX;
}

export function resultClassOf(opcode: string): ResultClass {
  return operationOf(opcode).result;
}

export function operandClassOf(opcode: string): ResultClass {
  return operationOf(opcode).operands;
}

export function overloadOf(opcode: string): OverloadKind {
  return operationOf(opcode).overload;
}

export function memoryAccessOf(opcode: string): MemoryAccessKind {
  return operationOf(opcode).access;
}

export function hasOpaqueMemoryEffect(opcode: string): boolean {
  return operationOf(opcode).opaqueMemory;
}

export function speculationRoleOf(opcode: string): SpeculationRole {
  return operationOf(opcode).speculation;
}

export function arityOf(opcode: string): Arity {
  return operationOf(opcode).arity;
}

export function transferOf(opcode: string): Transfer {
  return operationOf(opcode).transfer;
}

export function transferType(node: CFGInstruction, context: TypeContext): LatticeType {
  return operationOf(node.type).transfer(node, context);
}

const UNCONSTRAINED_CONTEXT: TypeContext = {
  typeOf: () => anyType(),
  returnTypeOf: () => anyType(),
};

function probeOf(opcode: Opcode): TransferNode {
  return { type: opcode, props: {}, inputs: [], uses: [] };
}

const ALWAYS_BOOLEAN: ReadonlySet<string> = new Set(
  ALL_OPCODES.filter(
    (opcode) =>
      transferOf(opcode)(probeOf(opcode), UNCONSTRAINED_CONTEXT).kind === TypeKind.Boolean,
  ),
);

export function alwaysProducesBoolean(opcode: string): boolean {
  return ALWAYS_BOOLEAN.has(opcode);
}

const RESOLVABLE_ACCESS: ReadonlySet<MemoryAccessKind> = new Set<MemoryAccessKind>([
  ACCESS_SLOT,
  ACCESS_ELEMENT,
  ACCESS_GLOBAL,
]);

function staticEffectsOf(spec: OperationSpec): OperationEffects | null {
  return typeof spec.effects === "function" ? null : spec.effects;
}

export function isTrackedLoad(opcode: string): boolean {
  const spec = operationOf(opcode);
  const current = staticEffectsOf(spec);
  return (
    current !== null && RESOLVABLE_ACCESS.has(spec.access) && current.reads !== MEMORY_NONE
  );
}

export function isTrackedStore(opcode: string): boolean {
  const spec = operationOf(opcode);
  const current = staticEffectsOf(spec);
  return (
    current !== null && RESOLVABLE_ACCESS.has(spec.access) && current.writes !== MEMORY_NONE
  );
}

export function isOpaquePropertyAccess(opcode: string): boolean {
  return operationOf(opcode).access === ACCESS_PROPERTY;
}

export function isRematerializable(opcode: string): boolean {
  const spec = operationOf(opcode);
  const current = staticEffectsOf(spec);
  return (
    current !== null &&
    !spec.pinned &&
    spec.arity.kind === "fixed" &&
    spec.arity.count === 0 &&
    current.reads === MEMORY_NONE &&
    current.writes === MEMORY_NONE &&
    !current.allocates &&
    current.deopt === DEOPT_NEVER
  );
}

export function isAllocationSite(opcode: string): boolean {
  const current = staticEffectsOf(operationOf(opcode));
  return (
    current !== null &&
    current.allocates &&
    current.reads === MEMORY_NONE &&
    current.writes === MEMORY_NONE
  );
}

export function readsMemory(node: CFGInstruction): boolean {
  return effectsOf(node).reads !== MEMORY_NONE;
}

export function readsMutableMemory(node: CFGInstruction): boolean {
  const reads = effectsOf(node).reads;
  return reads !== MEMORY_NONE && reads !== MEMORY_IMMUTABLE;
}

export function writesMemory(node: CFGInstruction): boolean {
  return effectsOf(node).writes !== MEMORY_NONE;
}

export function clobbersAllMemory(node: CFGInstruction): boolean {
  const current = effectsOf(node);
  return current.reads === MEMORY_ANY && current.writes === MEMORY_ANY;
}

export function allocates(node: CFGInstruction): boolean {
  return effectsOf(node).allocates;
}

export function canDeoptimize(node: CFGInstruction): boolean {
  const deopt = effectsOf(node).deopt;
  if (deopt === DEOPT_ALWAYS) return true;
  return deopt === DEOPT_ON_OVERFLOW && node.props.noOverflow !== true;
}

export function isEffectFree(node: CFGInstruction): boolean {
  const spec = operationOf(node.type);
  if (spec.terminator) return false;
  const current = effectsOf(node);
  return (
    current.reads === MEMORY_NONE &&
    current.writes === MEMORY_NONE &&
    !current.allocates &&
    current.deopt !== DEOPT_ALWAYS
  );
}

export function isReadOnly(node: CFGInstruction): boolean {
  const spec = operationOf(node.type);
  if (spec.terminator || !spec.removableWhenUnused) return false;
  const current = effectsOf(node);
  return current.reads !== MEMORY_NONE && current.writes === MEMORY_NONE && !current.allocates;
}

export function isGuard(node: CFGInstruction): boolean {
  const spec = operationOf(node.type);
  if (spec.terminator || spec.removableWhenUnused) return false;
  const current = effectsOf(node);
  return current.writes === MEMORY_NONE && !current.allocates;
}

export function forwardsPointerIdentity(opcode: string): boolean {
  return operationOf(opcode).forwardsPointerIdentity;
}

export function hasObservableEffect(node: CFGInstruction): boolean {
  const spec = operationOf(node.type);
  if (spec.terminator || !spec.removableWhenUnused) return true;
  const current = effectsOf(node);
  return current.writes !== MEMORY_NONE || current.allocates;
}

export function isMovable(node: CFGInstruction): boolean {
  const spec = operationOf(node.type);
  if (spec.pinned || spec.terminator) return false;
  const current = effectsOf(node);
  return current.writes === MEMORY_NONE && !current.allocates;
}

export const TYPED_ARITHMETIC_OPS: readonly string[] = [
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_INT32_COMPARE,
  IR_FLOAT64_COMPARE,
];

export const GENERIC_ARITHMETIC_OPS: readonly string[] = [
  IR_GENERIC_ADD,
  IR_GENERIC_SUB,
  IR_GENERIC_MUL,
  IR_GENERIC_DIV,
  IR_GENERIC_MOD,
  IR_GENERIC_COMPARE,
  IR_GENERIC_POW,
];

export const GENERIC_BITWISE_OPS: readonly string[] = [
  IR_GENERIC_BITAND,
  IR_GENERIC_BITOR,
  IR_GENERIC_BITXOR,
  IR_GENERIC_SHL,
  IR_GENERIC_SHR,
  IR_GENERIC_USHR,
  IR_GENERIC_BITNOT,
];

export const GENERIC_RELATIONAL_OPS: readonly string[] = [
  IR_GENERIC_INSTANCEOF,
  IR_GENERIC_IN,
];

export const GENERIC_PROPERTY_OPS: readonly string[] = [
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_PROP,
  IR_GENERIC_DELETE_PROP,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
];

export const GENERIC_VALUE_OPS: readonly string[] = [
  ...GENERIC_ARITHMETIC_OPS,
  ...GENERIC_BITWISE_OPS,
  ...GENERIC_RELATIONAL_OPS,
];
