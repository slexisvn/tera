import { IR_RETURN, type CFGFunction } from "../ir/index.js";
import { isPendingThrowReturn } from "../builder/throw-recovery.js";
import { declaredTypeOf, type ClassTable } from "../metadata/class-table.js";
import { nominalLatticeType } from "../types/declared.js";
import { joinTypes, typeEquals, TypeKind, type LatticeType } from "../types/lattice.js";
import { aotScalarOf } from "../types/scalar.js";
import type { TypeInference } from "./type-inference.js";

const UNNAMEABLE: ReadonlySet<string> = new Set<string>([
  TypeKind.Any,
  TypeKind.Tagged,
  TypeKind.Never,
  TypeKind.Nullish,
]);

export function returnedLatticeType(
  graph: CFGFunction,
  types: TypeInference,
): LatticeType | null {
  let merged: LatticeType | null = null;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_RETURN || isPendingThrowReturn(node)) continue;
      const returned = node.inputs[0];
      if (returned !== undefined) merged = joinTypes(merged, types.typeOf(returned));
    }
  }
  return merged;
}

/** A name is worth adopting only when reading it back describes the same value. */
function denotes(name: string, returned: LatticeType, classes: ClassTable): boolean {
  const reread = nominalLatticeType(name, classes);
  if (reread.kind === TypeKind.Object || returned.kind === TypeKind.Object) {
    return typeEquals(reread, returned);
  }
  const scalar = aotScalarOf(reread);
  return scalar !== null && scalar === aotScalarOf(returned);
}

/**
 * Names the type a function returns when its source left the annotation out, so
 * callers that need a declared return — array `map`, the native return ABI —
 * can work from what the body actually produces.
 */
export function inferredReturnName(graph: CFGFunction, types: TypeInference): string | null {
  const classes = graph.classes;
  if (classes === null) return null;
  const returned = returnedLatticeType(graph, types);
  if (returned === null || UNNAMEABLE.has(returned.kind)) return null;
  const name = declaredTypeOf(returned, classes);
  return name !== null && denotes(name, returned, classes) ? name : null;
}
