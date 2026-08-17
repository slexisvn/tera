import { defaultMachineReprOf, type TargetModel } from "../../target/model.js";
import { capabilitySet } from "../../target/capabilities.js";
import { deoptToInterpreter } from "../../target/speculation.js";

export const wasmTarget: TargetModel = {
  name: "wasm32",
  capabilities: capabilitySet("deopt", "osr", "tagged-values", "float-text"),
  speculation: deoptToInterpreter,
  abi: null,
  machineReprOf: defaultMachineReprOf,
};
