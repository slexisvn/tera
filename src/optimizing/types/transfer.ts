import * as ir from "../ir/index.js";
import { builtinMemberType, type BuiltinMemberType } from "./declared.js";
import {
  ELEMENT_REP_FLOAT64,
  ELEMENT_REP_INT32,
  elementsKindFor,
  latticeFromElementRep,
  latticeFromElementsKind,
} from "./elements.js";
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
} from "./lattice.js";

export interface TypeContext {
  typeOf(value: ir.CFGInstruction): LatticeType;
  returnTypeOf(node: ir.CFGInstruction): LatticeType;
}

type Transfer = (node: ir.CFGInstruction, context: TypeContext) => LatticeType;

const INT32_RESULTS = [
  ir.IR_INT32_ADD,
  ir.IR_INT32_SUB,
  ir.IR_INT32_MUL,
  ir.IR_INT32_DIV,
  ir.IR_INT32_MOD,
  ir.IR_INT32_SHL,
  ir.IR_INT32_SHR,
  ir.IR_INT32_AND,
  ir.IR_INT32_OR,
  ir.IR_INT32_XOR,
  ir.IR_INT32_NOT,
  ir.IR_GENERIC_BITAND,
  ir.IR_GENERIC_BITOR,
  ir.IR_GENERIC_BITXOR,
  ir.IR_GENERIC_BITNOT,
  ir.IR_GENERIC_SHL,
  ir.IR_GENERIC_SHR,
  ir.IR_LOAD_ARRAY_LENGTH,
];

const DOUBLE_RESULTS = [
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_SUB,
  ir.IR_FLOAT64_MUL,
  ir.IR_FLOAT64_DIV,
  ir.IR_FLOAT64_POW,
];

const BOOLEAN_RESULTS = [
  ir.IR_INT32_COMPARE,
  ir.IR_FLOAT64_COMPARE,
  ir.IR_GENERIC_COMPARE,
  ir.IR_NOT,
  ir.IR_GENERIC_IN,
  ir.IR_GENERIC_INSTANCEOF,
  ir.IR_CHECK_CALL_TARGET,
];

const OBJECT_RESULTS = [
  ir.IR_NEW_OBJECT,
  ir.IR_NEW_REGEX,
  ir.IR_MAKE_CLOSURE,
];

const CALL_RESULTS = [
  ir.IR_CALL_KNOWN_FUNCTION,
  ir.IR_CALL_BUILTIN,
  ir.IR_CALL_INTRINSIC,
];

const NUMERIC_KINDS = new Set<string>([
  TypeKind.Smi,
  TypeKind.Double,
  TypeKind.Number,
]);

const UNBOX_RESULTS = new Map<string, LatticeType>([
  [ELEMENT_REP_INT32, smiType()],
  [ELEMENT_REP_FLOAT64, doubleType()],
  ["bool", booleanType()],
]);

function isNumeric(type: LatticeType): boolean {
  return NUMERIC_KINDS.has(type.kind);
}

function inputType(node: ir.CFGInstruction, index: number, context: TypeContext): LatticeType {
  const input = node.inputs[index];
  return input === undefined ? anyType() : context.typeOf(input);
}

function constant(result: LatticeType): Transfer {
  return () => result;
}

function guardTransfer(fact: (node: ir.CFGInstruction) => LatticeType): Transfer {
  return (node, context) => narrowType(inputType(node, 0, context), fact(node));
}

function arithmeticTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const left = inputType(node, 0, context);
  const right = inputType(node, 1, context);
  if (left.kind === TypeKind.Smi && right.kind === TypeKind.Smi) return smiType();
  if (isNumeric(left) && isNumeric(right)) return numberType();
  return anyType();
}

function additionTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const left = inputType(node, 0, context);
  const right = inputType(node, 1, context);
  if (left.kind === TypeKind.String || right.kind === TypeKind.String) return stringType();
  return arithmeticTransfer(node, context);
}

function divisionTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const left = inputType(node, 0, context);
  const right = inputType(node, 1, context);
  return isNumeric(left) && isNumeric(right) ? numberType() : anyType();
}

function negationTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const operand = inputType(node, 0, context);
  if (operand.kind === TypeKind.Smi) return smiType();
  return isNumeric(operand) ? numberType() : anyType();
}

function phiTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  let merged: LatticeType | null = null;
  for (const input of node.inputs) merged = joinTypes(merged, context.typeOf(input));
  return merged ?? neverType();
}

export const ELEMENT_STORES = new Set<string>([
  ir.IR_STORE_ELEMENT,
  ir.IR_GENERIC_SET_INDEX,
]);

export function storedElementValue(
  store: ir.CFGInstruction,
  array: ir.CFGInstruction,
): ir.CFGInstruction | null {
  if (!ELEMENT_STORES.has(store.type) || store.inputs[0] !== array) return null;
  return store.inputs[2] ?? null;
}

function newArrayTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  let merged: LatticeType | null = null;
  for (const input of node.inputs) merged = joinTypes(merged, context.typeOf(input));
  for (const use of node.uses) {
    const stored = storedElementValue(use, node);
    if (stored !== null) merged = joinTypes(merged, context.typeOf(stored));
  }
  return arrayType(merged === null ? null : elementsKindFor(merged));
}

function loadElementTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const declared = latticeFromElementRep(node.props.elementRep);
  if (declared !== null) return declared;
  const container = inputType(node, 0, context);
  if (container.kind !== TypeKind.Array) return anyType();
  return latticeFromElementsKind(container.elementsKind);
}

function memberOf(
  node: ir.CFGInstruction,
  context: TypeContext,
): BuiltinMemberType | null {
  const receiver = node.inputs[0];
  if (receiver === undefined) return null;
  return builtinMemberType(context.typeOf(receiver), String(node.props.propName));
}

function memberTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const member = memberOf(node, context);
  return member !== null && member.getter ? member.type : anyType();
}

function callTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const callee = node.inputs[0];
  if (callee !== undefined && callee.type === ir.IR_GENERIC_GET_PROP) {
    const member = memberOf(callee, context);
    if (member !== null && !member.getter) return member.type;
  }
  return context.returnTypeOf(node);
}

function boxTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  return node.props.toType === "handle" ? anyType() : inputType(node, 0, context);
}

function unboxTransfer(node: ir.CFGInstruction): LatticeType {
  return UNBOX_RESULTS.get(String(node.props.toType)) ?? anyType();
}

function passthroughTransfer(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  return inputType(node, 0, context);
}

function buildTransfers(): Map<string, Transfer> {
  const transfers = new Map<string, Transfer>();
  const register = (opcodes: readonly string[], transfer: Transfer): void => {
    for (const opcode of opcodes) transfers.set(opcode, transfer);
  };

  register(INT32_RESULTS, constant(smiType()));
  register(DOUBLE_RESULTS, constant(doubleType()));
  register(BOOLEAN_RESULTS, constant(booleanType()));
  register(OBJECT_RESULTS, constant(objectType()));
  register([ir.IR_TYPEOF], constant(stringType()));
  register([ir.IR_GENERIC_USHR], constant(numberType()));

  register([ir.IR_CONSTANT], (node) => typeFromConstant(node.props.value));
  register([ir.IR_PHI], phiTransfer);
  register([ir.IR_NEG], negationTransfer);
  register([ir.IR_GENERIC_ADD], additionTransfer);
  register(
    [ir.IR_GENERIC_SUB, ir.IR_GENERIC_MUL, ir.IR_GENERIC_MOD, ir.IR_GENERIC_POW],
    arithmeticTransfer,
  );
  register([ir.IR_GENERIC_DIV], divisionTransfer);
  register([ir.IR_NEW_ARRAY], newArrayTransfer);
  register([ir.IR_LOAD_ELEMENT, ir.IR_GENERIC_GET_INDEX], loadElementTransfer);
  register([ir.IR_BOX], boxTransfer);
  register([ir.IR_UNBOX], unboxTransfer);
  register([ir.IR_CHECK_BOUNDS], passthroughTransfer);
  register(CALL_RESULTS, (node, context) => context.returnTypeOf(node));
  register([ir.IR_GENERIC_CALL], callTransfer);
  register([ir.IR_GENERIC_GET_PROP], memberTransfer);

  register([ir.IR_CHECK_SMI], guardTransfer(() => smiType()));
  register([ir.IR_CHECK_NUMBER], guardTransfer(() => numberType()));
  register([ir.IR_CHECK_ARRAY], guardTransfer(() => arrayType(null)));
  register(
    [ir.IR_CHECK_MAP],
    guardTransfer((node) => objectType(node.props.expectedMapId ?? null)),
  );
  register(
    [ir.IR_CHECK_ELEMENTS_KIND],
    guardTransfer((node) => arrayType(node.props.elementsKind ?? null)),
  );

  return transfers;
}

const TRANSFERS = buildTransfers();

export function transferType(node: ir.CFGInstruction, context: TypeContext): LatticeType {
  const transfer = TRANSFERS.get(node.type);
  return transfer === undefined ? anyType() : transfer(node, context);
}

export function hasTransfer(opcode: string): boolean {
  return TRANSFERS.has(opcode);
}
