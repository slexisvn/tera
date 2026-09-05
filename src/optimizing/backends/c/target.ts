import { defaultMachineReprOf, type TargetModel } from "../../target/model.js";
import { capabilitySet } from "../../target/capabilities.js";
import { proveOrGeneric } from "../../target/speculation.js";

export const cTarget: TargetModel = {
  name: "native64",
  capabilities: capabilitySet(
    "terminating-throw",
    "float-text",
    "select-integer",
    "select-float",
    "generational-heap",
    "utf16-text",
    "timers",
  ),
  speculation: proveOrGeneric,
  abi: null,
  machineReprOf: defaultMachineReprOf,
};
