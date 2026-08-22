import { describe, expect, it } from "vitest";
import {
  AnalysisManager,
  AnalysisRegistry,
  analysisId,
  type AnalysisId,
  type AnalysisPass,
} from "../../../src/optimizing/infra/analysis-manager.js";
import { PassManager, type TransformPass } from "../../../src/optimizing/infra/pass-manager.js";
import {
  analysisName,
  formatPassTrace,
  type GraphProbe,
  type PassTraceRecord,
} from "../../../src/optimizing/infra/pass-trace.js";
import { compilerOptions } from "../../../src/optimizing/options.js";

type Graph = { nodes: number };

const probeCalls = { count: 0, dump: 0 };

const probe: GraphProbe<Graph> = {
  nodeCount(graph) {
    probeCalls.count++;
    return graph.nodes;
  },
  dump(graph) {
    probeCalls.dump++;
    return `graph(${graph.nodes})`;
  },
};

function resizeBy(name: string, delta: number): TransformPass<Graph> {
  return {
    name,
    preserves: { kind: "all" },
    run: (graph) => {
      graph.nodes += delta;
      return { changed: delta !== 0 };
    },
  };
}

function harness(analyses: Array<AnalysisPass<Graph, number>> = []) {
  probeCalls.count = 0;
  probeCalls.dump = 0;
  const graph: Graph = { nodes: 10 };
  const registry = new AnalysisRegistry<Graph>();
  for (const analysis of analyses) registry.register(analysis);
  const manager = new AnalysisManager<Graph>(graph, registry);
  const records: PassTraceRecord[] = [];
  const traced = new PassManager<Graph>(manager, compilerOptions(), {
    tracer: { probe, sink: (record) => records.push(record) },
  });
  const untraced = new PassManager<Graph>(manager, compilerOptions());
  return { graph, manager, records, traced, untraced };
}

function constantAnalysis(name: string): AnalysisPass<Graph, number> {
  return { id: analysisId<number>(name), run: (graph) => graph.nodes };
}

describe("pass tracing", () => {
  it("emits one record per pass carrying the node count delta", () => {
    const { graph, records, traced } = harness();

    traced.run(graph, [resizeBy("grow", 4), resizeBy("shrink", -6)]);

    expect(records.map((record) => record.pass)).toEqual(["grow", "shrink"]);
    expect(records.map((record) => [record.nodesBefore, record.nodesAfter])).toEqual([
      [10, 14],
      [14, 8],
    ]);
  });

  it("numbers records continuously across separate pipeline runs", () => {
    const { graph, records, traced } = harness();

    traced.run(graph, [resizeBy("first", 1)]);
    traced.run(graph, [resizeBy("second", 1)]);

    expect(records.map((record) => record.ordinal)).toEqual([0, 1]);
  });

  it("reports a pass that changed nothing as unchanged with no invalidation", () => {
    const { graph, records, traced } = harness();

    traced.run(graph, [resizeBy("noop", 0)]);

    expect(records[0].changed).toBe(false);
    expect(records[0].invalidated).toEqual([]);
  });

  it("reports exactly the analyses the pass invalidated", () => {
    const kept = constantAnalysis("kept");
    const dropped = constantAnalysis("dropped");
    const { graph, manager, records, traced } = harness([kept, dropped]);
    manager.get(kept.id);
    manager.get(dropped.id);

    traced.run(graph, [
      {
        name: "mutate",
        preserves: { kind: "only", preserved: [kept.id as AnalysisId<unknown>] },
        run: () => ({ changed: true }),
      },
    ]);

    expect(records[0].invalidated.map(analysisName)).toEqual(["dropped"]);
  });

  it("reports nothing invalidated for an analysis that was never cached", () => {
    const uncached = constantAnalysis("uncached");
    const { graph, records, traced } = harness([uncached]);

    traced.run(graph, [
      {
        name: "mutate",
        preserves: { kind: "allExcept", invalidated: [uncached.id as AnalysisId<unknown>] },
        run: () => ({ changed: true }),
      },
    ]);

    expect(records[0].invalidated).toEqual([]);
  });

  it("never touches the graph probe when no tracer is supplied", () => {
    const { graph, untraced } = harness();

    untraced.run(graph, [resizeBy("grow", 4), resizeBy("shrink", -6)]);

    expect(probeCalls).toEqual({ count: 0, dump: 0 });
  });

  it("renders a section header naming the pass, delta and invalidated analyses", () => {
    const rendered = formatPassTrace({
      ordinal: 3,
      pass: "licm",
      changed: true,
      nodesBefore: 12,
      nodesAfter: 9,
      invalidated: [analysisId("points-to"), analysisId("mod-ref")],
      graph: "BODY",
    });

    expect(rendered).toBe(
      "*** IR after #3 licm [changed, nodes 12 -> 9 (-3), invalidated points-to mod-ref] ***\nBODY",
    );
  });

  it("renders growth with an explicit plus sign and an empty invalidation set", () => {
    const rendered = formatPassTrace({
      ordinal: 0,
      pass: "inline",
      changed: true,
      nodesBefore: 4,
      nodesAfter: 11,
      invalidated: [],
      graph: "BODY",
    });

    expect(rendered.split("\n")[0]).toBe(
      "*** IR after #0 inline [changed, nodes 4 -> 11 (+7), invalidated nothing] ***",
    );
  });
});
