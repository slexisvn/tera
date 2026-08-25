import type { AnalysisId } from "./analysis-manager.js";

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
  readonly invalidated: readonly AnalysisId<unknown>[];
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

export function formatPassTrace<G>(record: PassTraceRecord<G>, dump: string): string {
  const invalidated = record.invalidated.map(analysisName);
  const facts = [
    record.changed ? "changed" : "unchanged",
    `nodes ${record.nodesBefore} -> ${record.nodesAfter} (${signedDelta(record.nodesBefore, record.nodesAfter)})`,
    `invalidated ${invalidated.length === 0 ? "nothing" : invalidated.join(" ")}`,
  ];
  return `*** IR after #${record.ordinal} ${record.pass} [${facts.join(", ")}] ***\n${dump}`;
}

export function consolePassTracer<G>(probe: GraphProbe<G>): PassTracer<G> {
  return (record) => console.log(formatPassTrace(record, probe.dump(record.graph)));
}
