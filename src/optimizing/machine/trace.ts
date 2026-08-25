import type { MachineFunction } from "./ir.js";
import type { MachineStage } from "./verifier.js";
import { printMachineFunction } from "./print.js";

export interface MachineTraceRecord {
  readonly ordinal: number;
  readonly symbol: string;
  readonly stage: MachineStage;
  readonly after: string;
  readonly fn: MachineFunction;
}

export type MachineTracer = (record: MachineTraceRecord) => void;

export function formatMachineTrace(record: MachineTraceRecord): string {
  return (
    `*** machine after #${record.ordinal} ${record.after} ` +
    `[${record.symbol}, ${record.stage}] ***\n${printMachineFunction(record.fn)}`
  );
}

export function consoleMachineTracer(record: MachineTraceRecord): void {
  console.log(formatMachineTrace(record));
}
