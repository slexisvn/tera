import type { LatticeType } from "../types/lattice.js";
import type { CapabilitySet } from "./capabilities.js";
import type { SpeculationStrategy } from "./speculation.js";

export type MachineRepr =
  | "int32"
  | "int64"
  | "float64"
  | "boolean"
  | "tagged"
  | "pointer";

export type ObjectModel = "linear-memory" | "native-pointer";

export interface RuntimeAbi {
  readonly helperPrefix: string;
  readonly pointerBytes: 4 | 8;
}

export interface TargetModel {
  readonly name: string;
  readonly capabilities: CapabilitySet;
  readonly objectModel: ObjectModel;
  readonly speculation: SpeculationStrategy;
  readonly abi: RuntimeAbi;
  reprOf(type: LatticeType): MachineRepr;
}
