import { printIR } from "../ir/text.js";
import type { Remark } from "../infra/pass-remarks.js";
import type { ModuleIR } from "../compilation-unit.js";

export interface ModuleTraceRecord {
  readonly ordinal: number;
  readonly stage: string;
  readonly remarks: readonly Remark[];
  readonly module: ModuleIR;
}

export type ModuleTracer = (record: ModuleTraceRecord) => void;

export function printModuleIR(module: ModuleIR): string {
  return module.units.map((unit) => printIR(unit.graph)).join("\n");
}

export function formatModuleTrace(record: ModuleTraceRecord): string {
  const units = record.module.units.length;
  return (
    `*** module after #${record.ordinal} ${record.stage} [${units} units] ***\n` +
    printModuleIR(record.module)
  );
}

export function consoleModuleTracer(record: ModuleTraceRecord): void {
  console.log(formatModuleTrace(record));
}
