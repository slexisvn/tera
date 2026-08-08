import type { LatticeType } from "../../types/lattice.js";
import { TypeKind } from "../../types/lattice.js";
import type { MachineRepr, TargetModel } from "../../target/model.js";
import { capabilitySet } from "../../target/capabilities.js";
import { proveOrGeneric } from "../../target/speculation.js";

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
      return "pointer";
    default:
      return "tagged";
  }
}

export const cTarget: TargetModel = {
  name: "native64",
  capabilities: capabilitySet("native-pointer", "own-gc", "int64"),
  objectModel: "native-pointer",
  speculation: proveOrGeneric,
  abi: { helperPrefix: "tera_", pointerBytes: 8 },
  reprOf,
};
