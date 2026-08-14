import type { AnalysisId } from "./analysis-manager.js";

export interface GraphProbe<G> {
  nodeCount(graph: G): number;
  dump(graph: G): string;
}

export interface PassTraceRecord {
  readonly ordinal: number;
  readonly pass: string;
  readonly changed: boolean;
  readonly nodesBefore: number;
  readonly nodesAfter: number;
  readonly invalidated: readonly AnalysisId<unknown>[];
  readonly graph: string;
}

export type PassTraceSink = (record: PassTraceRecord) => void;

export interface PassTracer<G> {
  readonly probe: GraphProbe<G>;
  readonly sink: PassTraceSink;
}

export function analysisName(id: AnalysisId<unknown>): string {
  return id.description ?? "anonymous";
}

function signedDelta(before: number, after: number): string {
  const delta = after - before;
  return delta < 0 ? String(delta) : `+${delta}`;
}

export function formatPassTrace(record: PassTraceRecord): string {
  const invalidated = record.invalidated.map(analysisName);
  const facts = [
    record.changed ? "changed" : "unchanged",
    `nodes ${record.nodesBefore} -> ${record.nodesAfter} (${signedDelta(record.nodesBefore, record.nodesAfter)})`,
    `invalidated ${invalidated.length === 0 ? "nothing" : invalidated.join(" ")}`,
  ];
  return `*** IR after #${record.ordinal} ${record.pass} [${facts.join(", ")}] ***\n${record.graph}`;
}

export function consolePassTraceSink(record: PassTraceRecord): void {
  console.log(formatPassTrace(record));
}
