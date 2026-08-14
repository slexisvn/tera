import type { Representation } from "../types/representation.js";
import type { AotScalar } from "../types/scalar.js";
import type { CapabilitySet } from "./capabilities.js";
import type { SpeculationStrategy } from "./speculation.js";
import type { RuntimeAbi } from "./abi.js";
import type { RegisterClass, RegisterFile } from "./registers.js";

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
  readonly abi: RuntimeAbi | null;
  machineReprOf(rep: Representation): MachineRepr;
}

export interface ScalarLocation {
  readonly classId: string;
  readonly width: number;
}

export interface MachineTargetModel extends TargetModel {
  readonly abi: RuntimeAbi;
  readonly registers: RegisterFile;
  readonly integerClass: RegisterClass;
  readonly floatClass: RegisterClass;
  locationOf(scalar: AotScalar): ScalarLocation;
}

export function isMachineTarget(target: TargetModel): target is MachineTargetModel {
  return target.abi !== null && "registers" in target;
}
