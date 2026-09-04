import { FLOAT64_NULL_BITS, FLOAT64_UNDEFINED_BITS } from "../target/float64.js";
import { cleanType, unionParts } from "../../frontend/checker/type-system.js";
import { builtinTypeEnv, nominalLatticeType, presentTypeName } from "../types/declared.js";
import { declaredTypeNameOf } from "./call-signatures.js";
import { IR_CONSTANT, IR_PHI, type CFGFunction, type CFGInstruction } from "../ir/index.js";
import type { ClassTable } from "./class-table.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { aotScalarOf, isReferenceScalar } from "../types/scalar.js";

export const BOOLEAN_TEXT: readonly [string, string] = ["false", "true"];

export const ABSENCE_COMPARISON = "loose==";
export const NULL_TEXT = "null";
export const UNDEFINED_TEXT = "undefined";

export interface AbsenceValue {
  readonly text: string;
  readonly bits: bigint;
  readonly reference: boolean;
}

const ABSENCE_BY_HELD: ReadonlyMap<unknown, AbsenceValue> = new Map<unknown, AbsenceValue>([
  [null, { text: NULL_TEXT, bits: FLOAT64_NULL_BITS, reference: true }],
  [undefined, { text: UNDEFINED_TEXT, bits: FLOAT64_UNDEFINED_BITS, reference: false }],
]);

export const ABSENCE_VALUES: readonly AbsenceValue[] = [...ABSENCE_BY_HELD.values()];

export function absenceValueOf(held: unknown): AbsenceValue | null {
  return ABSENCE_BY_HELD.get(held) ?? null;
}

export function declaredAbsenceText(source: string | null | undefined): string | null {
  if (source === null || source === undefined) return null;
  const parts = unionParts(cleanType(source), builtinTypeEnv());
  const named = ABSENCE_VALUES.filter((absence) => parts.includes(absence.text));
  return named.length === 1 ? named[0]!.text : null;
}

function joinedAbsenceText(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  seen: Set<CFGInstruction>,
): string | null {
  let shared: string | null = null;
  for (const input of value.inputs) {
    if (seen.has(input)) continue;
    const held = absenceTextOf(input, graph, classes, types, seen);
    if (held === null || (shared !== null && shared !== held)) return null;
    shared = held;
  }
  return shared;
}

function heldAsReference(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): boolean {
  const inferred = aotScalarOf(types.typeOf(value));
  if (inferred !== null && isReferenceScalar(inferred)) return true;
  const declared = declaredTypeNameOf(value, graph, classes, types);
  if (declared === null) return false;
  const present = aotScalarOf(nominalLatticeType(presentTypeName(declared), classes));
  return present !== null && isReferenceScalar(present);
}

export function referenceAbsenceTextOf(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  const word = absenceTextOf(value, graph, classes, types);
  if (word === null) return null;
  return heldAsReference(value, graph, classes, types) ? word : null;
}

export function absenceTextOf(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  seen: Set<CFGInstruction> = new Set<CFGInstruction>(),
): string | null {
  if (seen.has(value)) return null;
  seen.add(value);
  if (value.type === IR_CONSTANT) return absenceValueOf(value.props.value)?.text ?? null;
  const declared = declaredAbsenceText(declaredTypeNameOf(value, graph, classes, types));
  if (declared !== null) return declared;
  return value.type === IR_PHI ? joinedAbsenceText(value, graph, classes, types, seen) : null;
}
