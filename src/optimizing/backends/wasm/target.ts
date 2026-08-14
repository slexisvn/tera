import type { MachineRepr, TargetModel } from "../../target/model.js";
import { capabilitySet } from "../../target/capabilities.js";
import { deoptToInterpreter } from "../../target/speculation.js";
import {
  REP_BOOL,
  REP_FLOAT64,
  REP_HANDLE,
  REP_INT32,
  REP_TAGGED,
  REP_TAGGED_NUMBER,
  type Representation,
} from "../../types/representation.js";

const MACHINE_REPR = new Map<Representation, MachineRepr>([
  [REP_INT32, "int32"],
  [REP_FLOAT64, "float64"],
  [REP_TAGGED_NUMBER, "float64"],
  [REP_BOOL, "boolean"],
  [REP_HANDLE, "pointer"],
  [REP_TAGGED, "tagged"],
]);

function machineReprOf(rep: Representation): MachineRepr {
  return MACHINE_REPR.get(rep) ?? "pointer";
}

export const wasmTarget: TargetModel = {
  name: "wasm32",
  capabilities: capabilitySet("deopt", "osr", "tagged-values", "float-text"),
  speculation: deoptToInterpreter,
  abi: null,
  machineReprOf,
};
