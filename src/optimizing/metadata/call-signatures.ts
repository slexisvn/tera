import {
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_GENERIC_SET_PROP,
  IR_LOAD_GLOBAL,
  IR_RETURN,
  IR_STORE_FIELD,
  type CFGFunction,
  type CFGInstruction,
  type IRMetadataValue,
} from "../ir/index.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import { TypeKind } from "../types/lattice.js";
import type { DeclaredDefault, DeclaredSignature } from "../types/signature.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { ClassShape, ClassTable } from "./class-table.js";
import { FIELD_TYPE_PROP, VALUE_CLASS_PROP } from "./class-table.js";

interface CallTarget {
  readonly name?: unknown;
  readonly declaredSignature?: DeclaredSignature | null;
}

export const CALLEE_SYMBOL_PROP = "calleeSymbol";

export function genericCalleeName(node: CFGInstruction): string | null {
  const renamed = node.props[CALLEE_SYMBOL_PROP];
  if (typeof renamed === "string") return renamed;
  const callee = node.inputs[0];
  if (callee === undefined) return null;
  if (callee.type === IR_LOAD_GLOBAL) {
    const name = callee.props.name;
    return typeof name === "string" ? name : null;
  }
  if (callee.type !== IR_CONSTANT) return null;
  return compiledFunctionConstant(callee.props.value)?.name ?? null;
}

export function calleeSymbolName(node: CFGInstruction): string | null {
  const target = node.props.target as CallTarget | undefined;
  return typeof target?.name === "string" ? target.name : null;
}

export function calleeDeclaredSignature(node: CFGInstruction): DeclaredSignature | null {
  const target = node.props.target as CallTarget | undefined;
  return target?.declaredSignature ?? null;
}

export function calleeNameOf(node: CFGInstruction): string | null {
  if (node.type === IR_GENERIC_CALL) return genericCalleeName(node);
  return node.type === IR_CALL_KNOWN_FUNCTION ? calleeSymbolName(node) : null;
}

export function stampCalleeSignatures(
  graph: CFGFunction,
  signatures: ReadonlyMap<string, DeclaredSignature>,
): number {
  let resolved = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const name = calleeNameOf(node);
      if (name === null) continue;
      const target = node.props.target as CallTarget | undefined;
      const declared = signatures.get(name);
      if (declared === undefined) {
        continue;
      }
      if (target?.declaredSignature === declared) continue;
      node.props.target = { ...target, name, declaredSignature: declared } as unknown as IRMetadataValue;
      resolved++;
    }
  }
  return resolved;
}

const RETURNED_INPUT = 0;
const STORED_INPUT = 1;
const CALLEE_INPUT = 1;

const STORES_MEMBER: ReadonlySet<string> = new Set<string>([
  IR_STORE_FIELD,
  IR_GENERIC_SET_PROP,
]);

export function shapeHeldBy(
  value: CFGInstruction | undefined,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  if (value === undefined) return null;
  const carried = value.props[VALUE_CLASS_PROP];
  if (typeof carried === "number") return classes.shapeById(carried);
  const type = types.typeOf(value);
  if (type.kind !== TypeKind.Object || typeof type.map !== "number") return null;
  return classes.shapeById(type.map);
}

export function memberDeclaredType(
  owner: CFGInstruction | undefined,
  member: unknown,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  if (typeof member !== "string") return null;
  return shapeHeldBy(owner, classes, types)?.fields.get(member)?.declaredType ?? null;
}

function parameterIndexOf(call: CFGInstruction, at: number): number {
  if (call.type === IR_CALL_KNOWN_FUNCTION) return at;
  if (call.props.isMethod === true || at < CALLEE_INPUT) return -1;
  return at - CALLEE_INPUT;
}

export type CalleeSignatures = (call: CFGInstruction) => DeclaredSignature | null;

export function declaredTypeAt(
  use: CFGInstruction,
  at: number,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  signatureOf: CalleeSignatures = calleeDeclaredSignature,
): string | null {
  if (use.type === IR_RETURN) {
    return at === RETURNED_INPUT ? graph.declaredSignature?.returns ?? null : null;
  }
  if (use.type === IR_CALL_KNOWN_FUNCTION || use.type === IR_GENERIC_CALL) {
    const parameter = parameterIndexOf(use, at);
    return parameter < 0 ? null : signatureOf(use)?.params[parameter] ?? null;
  }
  if (!STORES_MEMBER.has(use.type) || at !== STORED_INPUT) return null;
  const carried = use.props[FIELD_TYPE_PROP];
  if (typeof carried === "string") return carried;
  return memberDeclaredType(use.inputs[0], use.props.propName, classes, types);
}

export const NAMED_ARGUMENTS_PROP = "namedArguments";

export function carryNamedArguments(from: CFGInstruction, to: CFGInstruction): void {
  const supplied = from.props[NAMED_ARGUMENTS_PROP];
  if (supplied !== undefined) to.props[NAMED_ARGUMENTS_PROP] = supplied;
}

export function declaredDefaultsByName(
  signature: DeclaredSignature,
): ReadonlyMap<string, DeclaredDefault> {
  const byName = new Map<string, DeclaredDefault>();
  const names = signature.names ?? [];
  const defaults = signature.defaults ?? [];
  names.forEach((name, index) => {
    const value = defaults[index];
    if (value !== undefined) byName.set(name, value);
  });
  return byName;
}
