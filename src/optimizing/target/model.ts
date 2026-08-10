import type { Representation } from "../types/representation.js";
import type { CapabilitySet } from "./capabilities.js";
import type { SpeculationStrategy } from "./speculation.js";

export type MachineRepr =
  | "int32"
  | "float64"
  | "boolean"
  | "tagged"
  | "pointer";

export interface TargetModel {
  readonly name: string;
  readonly capabilities: CapabilitySet;
  readonly speculation: SpeculationStrategy;
  machineReprOf(rep: Representation): MachineRepr;
}
