import {
  REP_BOOL,
  REP_FLOAT64,
  REP_HANDLE,
  REP_INT32,
  REP_TAGGED,
  REP_TAGGED_NUMBER,
  type Representation,
} from "../types/representation.js";
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

const MACHINE_REPR = new Map<Representation, MachineRepr>([
  [REP_INT32, "int32"],
  [REP_FLOAT64, "float64"],
  [REP_TAGGED_NUMBER, "float64"],
  [REP_BOOL, "boolean"],
  [REP_HANDLE, "pointer"],
  [REP_TAGGED, "tagged"],
]);

export function defaultMachineReprOf(rep: Representation): MachineRepr {
  return MACHINE_REPR.get(rep) ?? "pointer";
}

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
