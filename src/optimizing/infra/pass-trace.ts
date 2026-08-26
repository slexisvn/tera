import type { AnalysisId } from "./analysis-manager.js";
import type { Remark } from "./pass-remarks.js";

export interface GraphProbe<G> {
  nodeCount(graph: G): number;
  dump(graph: G): string;
}

export interface PassTraceRecord<G> {
  readonly ordinal: number;
  readonly pass: string;
  readonly changed: boolean;
  readonly nodesBefore: number;
  readonly nodesAfter: number;
  readonly requires: readonly AnalysisId<unknown>[];
  readonly invalidated: readonly AnalysisId<unknown>[];
  readonly remarks: readonly Remark[];
  readonly graph: G;
}

export type PassTracer<G> = (record: PassTraceRecord<G>) => void;

export interface PassTracing<G> {
  readonly probe: GraphProbe<G>;
  readonly trace: PassTracer<G>;
}

export function analysisName(id: AnalysisId<unknown>): string {
  return id.description ?? "anonymous";
}

function signedDelta(before: number, after: number): string {
  const delta = after - before;
  return delta < 0 ? String(delta) : `+${delta}`;
}

export function formatRemark(remark: Remark): string {
  const where = remark.node === null ? "" : ` v${remark.node}`;
  return `remark ${remark.kind}${where}: ${remark.message}`;
}

export function formatPassTrace<G>(record: PassTraceRecord<G>, dump: string): string {
  const invalidated = record.invalidated.map(analysisName);
  const facts = [
    record.changed ? "changed" : "unchanged",
    `nodes ${record.nodesBefore} -> ${record.nodesAfter} (${signedDelta(record.nodesBefore, record.nodesAfter)})`,
    `invalidated ${invalidated.length === 0 ? "nothing" : invalidated.join(" ")}`,
  ];
  const notes = record.remarks.map((remark) => `${formatRemark(remark)}\n`).join("");
  return `*** IR after #${record.ordinal} ${record.pass} [${facts.join(", ")}] ***\n${notes}${dump}`;
}

export function consolePassTracer<G>(probe: GraphProbe<G>): PassTracer<G> {
  return (record) => console.log(formatPassTrace(record, probe.dump(record.graph)));
}
