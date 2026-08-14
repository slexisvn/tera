import * as ir from "../../ir/index.js";
import {
  DEOPT_ARRAY_CHECK_FAILED,
  DEOPT_BOUNDS_CHECK_FAILED,
  DEOPT_DIVISION_BY_ZERO,
  DEOPT_MINUS_ZERO,
  DEOPT_ELEMENTS_KIND_CHECK_FAILED,
  DEOPT_GUARD_FAILURE,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_OVERFLOW,
  DEOPT_RUNTIME_STUB_FAILURE,
  DEOPT_SMI_CHECK_FAILED,
  DEOPT_WRONG_CALL_TARGET,
} from "../../../deopt/deoptimizer.js";
import { metadataString as metadataStringOrNull } from "../../ir/metadata.js";

const DEOPT_REASON_LIST = [
  DEOPT_GUARD_FAILURE,
  DEOPT_SMI_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_ARRAY_CHECK_FAILED,
  DEOPT_ELEMENTS_KIND_CHECK_FAILED,
  DEOPT_BOUNDS_CHECK_FAILED,
  DEOPT_OVERFLOW,
  DEOPT_DIVISION_BY_ZERO,
  DEOPT_MINUS_ZERO,
  DEOPT_WRONG_CALL_TARGET,
  DEOPT_RUNTIME_STUB_FAILURE,
];

type DeoptReason = (typeof DEOPT_REASON_LIST)[number];
type DeoptIRNode = ir.CFGInstruction;

const DEOPT_REASON_IDS = new Map<DeoptReason, number>(
  DEOPT_REASON_LIST.map((reason, id) => [reason, id]),
);

function metadataString(value: ir.IRMetadataValue): string {
  return metadataStringOrNull(value) ?? String(value ?? "");
}

export function deoptReasonId(reason: DeoptReason): number {
  return (
    DEOPT_REASON_IDS.get(reason) ?? DEOPT_REASON_IDS.get(DEOPT_GUARD_FAILURE)!
  );
}

export function deoptReasonFromId(id: number): DeoptReason {
  return DEOPT_REASON_LIST[id] || DEOPT_GUARD_FAILURE;
}

export function deoptReasonForNode(node: DeoptIRNode | null | undefined): DeoptReason {
  if (!node) return DEOPT_GUARD_FAILURE;
  if (node.type === ir.IR_CHECK_SMI) return DEOPT_SMI_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_NUMBER) return DEOPT_NUMBER_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_MAP) return DEOPT_MAP_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_ARRAY) return DEOPT_ARRAY_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_ELEMENTS_KIND)
    return DEOPT_ELEMENTS_KIND_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_BOUNDS) return DEOPT_BOUNDS_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_CALL_TARGET) return DEOPT_WRONG_CALL_TARGET;
  if (node.type === ir.IR_DEOPTIMIZE)
    return metadataString(node.props.reason) || DEOPT_GUARD_FAILURE;
  return DEOPT_GUARD_FAILURE;
}
