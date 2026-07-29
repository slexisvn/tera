import {
  PACKED_SMI,
  PACKED_DOUBLE,
} from "../../objects/elements/elements-kind.js";
import {
  isSubtype,
  numberType,
  smiType,
  type LatticeType,
} from "../types/lattice.js";
import {
  ROP_EQ,
  ROP_NEQ,
  ROP_LOOSE_EQ,
  ROP_LOOSE_NEQ,
  ROP_LT,
  ROP_GT,
  ROP_LTE,
  ROP_GTE,
} from "../../bytecode/register/ops/bytecode.js";
import type { RegisterConstant } from "../../bytecode/register/ops/bytecode.js";

export const COMPARE_OP_MAP = {
  [ROP_EQ]: "==",
  [ROP_NEQ]: "!=",
  [ROP_LOOSE_EQ]: "loose==",
  [ROP_LOOSE_NEQ]: "loose!=",
  [ROP_LT]: "<",
  [ROP_GT]: ">",
  [ROP_LTE]: "<=",
  [ROP_GTE]: ">=",
};

export type NumericElementRep = "int32" | "float64";
export type NumericFeedbackKind = "smi" | "number" | "generic";

type FeedbackHint = {
  inputType: LatticeType | null | undefined;
};

type NumericFeedback = {
  unaryOp(index: number): FeedbackHint;
  binaryOp(index: number): FeedbackHint;
};

export function constantString(constants: RegisterConstant[], index: number): string {
  const value = constants[index];
  if (typeof value !== "string") {
    throw new Error(`Expected string constant at index ${index}`);
  }
  return value;
}

export function numericPackedElementRep(
  elementsKind: RuntimeValue,
): NumericElementRep | null {
  if (elementsKind === PACKED_SMI) return "int32";
  if (elementsKind === PACKED_DOUBLE) return "float64";
  return null;
}

export function numericFeedbackKind(
  feedback: NumericFeedback | null | undefined,
  index: number,
  op: "unary" | "binary",
): NumericFeedbackKind {
  if (index < 0 || !feedback) return "generic";
  const hint =
    op === "unary" ? feedback.unaryOp(index) : feedback.binaryOp(index);
  const type = hint.inputType;
  if (isSubtype(type, smiType())) return "smi";
  if (isSubtype(type, numberType())) return "number";
  return "generic";
}
