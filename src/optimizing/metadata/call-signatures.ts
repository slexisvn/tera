import {
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_LOAD_GLOBAL,
  type CFGFunction,
  type CFGInstruction,
  type IRMetadataValue,
} from "../ir/index.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import type { DeclaredDefault, DeclaredSignature } from "../types/signature.js";

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

function calleeNameOf(node: CFGInstruction): string | null {
  if (node.type === IR_GENERIC_CALL) return genericCalleeName(node);
  if (node.type !== IR_CALL_KNOWN_FUNCTION) return null;
  const target = node.props.target as CallTarget | undefined;
  return typeof target?.name === "string" ? target.name : null;
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
