import type { LatticeType } from "../../types/lattice.js";
import { TypeKind } from "../../types/lattice.js";
import type { MachineRepr, TargetModel } from "../../target/model.js";
import { capabilitySet } from "../../target/capabilities.js";
import { deoptToInterpreter } from "../../target/speculation.js";

function reprOf(type: LatticeType): MachineRepr {
  switch (type.kind) {
    case TypeKind.Smi:
      return "int32";
    case TypeKind.Double:
    case TypeKind.Number:
      return "float64";
    case TypeKind.Boolean:
      return "boolean";
    case TypeKind.String:
    case TypeKind.Object:
    case TypeKind.Array:
      return "int32";
    default:
      return "tagged";
  }
}

export const wasmTarget: TargetModel = {
  name: "wasm32",
  capabilities: capabilitySet("linear-memory", "host-gc", "deopt", "osr"),
  objectModel: "linear-memory",
  speculation: deoptToInterpreter,
  abi: { helperPrefix: "env.", pointerBytes: 4 },
  reprOf,
};
