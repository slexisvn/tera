import { describe, expect, it } from "vitest";
import {
  AnalysisManager,
  AnalysisRegistry,
  analysisId,
  type AnalysisPass,
} from "../../../src/optimizing/infra/analysis-manager.js";
import { PassManager, type TransformPass } from "../../../src/optimizing/infra/pass-manager.js";
import { compilerOptions } from "../../../src/optimizing/options.js";

type Graph = { value: number };

function countingAnalysis(name: string) {
  let runs = 0;
  const id = analysisId<number>(name);
  const pass: AnalysisPass<Graph, number> = {
    id,
    run: (graph) => {
      runs++;
      return graph.value;
    },
  };
  return { id, pass, runs: () => runs };
}

function managerWith(analyses: Array<AnalysisPass<Graph, number>>): {
  graph: Graph;
  manager: AnalysisManager<Graph>;
  passes: PassManager<Graph>;
} {
  const graph = { value: 1 };
  const registry = new AnalysisRegistry<Graph>();
  for (const analysis of analyses) registry.register(analysis);
  const manager = new AnalysisManager<Graph>(graph, registry);
  return { graph, manager, passes: new PassManager<Graph>(manager, compilerOptions()) };
}

describe("PassManager", () => {
  it("runs passes in order", () => {
    const order: string[] = [];
    const record = (name: string): TransformPass<Graph> => ({
      name,
      preserves: { kind: "all" },
      run: () => {
        order.push(name);
        return { changed: false };
      },
    });
    const { graph, passes } = managerWith([]);

    passes.run(graph, [record("first"), record("second"), record("third")]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("reports whether any pass changed the graph", () => {
    const { graph, passes } = managerWith([]);
    const unchanged: TransformPass<Graph> = {
      name: "noop",
      preserves: { kind: "all" },
      run: () => ({ changed: false }),
    };
    const changed: TransformPass<Graph> = {
      name: "mutate",
      preserves: { kind: "all" },
      run: () => ({ changed: true }),
    };

    expect(passes.run(graph, [unchanged, unchanged])).toBe(false);
    expect(passes.run(graph, [unchanged, changed])).toBe(true);
  });

  it("preserves cached analyses when a pass reports no change", () => {
    const analysis = countingAnalysis("count");
    const { graph, manager, passes } = managerWith([analysis.pass]);
    const observe: TransformPass<Graph> = {
      name: "observe",
      preserves: { kind: "all" },
      run: () => {
        manager.get(analysis.id);
        return { changed: false };
      },
    };

    passes.run(graph, [observe, observe, observe]);
    expect(analysis.runs()).toBe(1);
  });

  it("invalidates only the listed analyses under allExcept", () => {
    const kept = countingAnalysis("kept");
    const dropped = countingAnalysis("dropped");
    const { graph, manager, passes } = managerWith([kept.pass, dropped.pass]);
    manager.get(kept.id);
    manager.get(dropped.id);

    passes.run(graph, [
      {
        name: "mutate",
        preserves: { kind: "allExcept", invalidated: [dropped.id] },
        run: () => ({ changed: true }),
      },
    ]);
    manager.get(kept.id);
    manager.get(dropped.id);

    expect(kept.runs()).toBe(1);
    expect(dropped.runs()).toBe(2);
  });

  it("invalidates every analysis except preserved analyses under only preservation", () => {
    const kept = countingAnalysis("kept");
    const dropped = countingAnalysis("dropped");
    const { graph, manager, passes } = managerWith([kept.pass, dropped.pass]);
    manager.get(kept.id);
    manager.get(dropped.id);

    passes.run(graph, [
      {
        name: "mutate",
        preserves: { kind: "only", preserved: [kept.id] },
        run: () => ({ changed: true }),
      },
    ]);
    manager.get(kept.id);
    manager.get(dropped.id);

    expect(kept.runs()).toBe(1);
    expect(dropped.runs()).toBe(2);
  });

  it("preloads required analyses before running a transform pass", () => {
    const required = countingAnalysis("required");
    const { graph, passes } = managerWith([required.pass]);
    const observedRuns: number[] = [];

    passes.run(graph, [
      {
        name: "uses-required-analysis",
        requires: [required.id],
        preserves: { kind: "all" },
        run: () => {
          observedRuns.push(required.runs());
          return { changed: false };
        },
      },
    ]);

    expect(observedRuns).toEqual([1]);
    expect(required.runs()).toBe(1);
  });

  it("invalidates every analysis under a none preservation", () => {
    const kept = countingAnalysis("kept");
    const { graph, manager, passes } = managerWith([kept.pass]);
    manager.get(kept.id);

    passes.run(graph, [
      {
        name: "mutate",
        preserves: { kind: "none" },
        run: () => ({ changed: true }),
      },
    ]);
    manager.get(kept.id);

    expect(kept.runs()).toBe(2);
  });

  it("maintains the graph only after a pass that changed it", () => {
    const maintained: number[] = [];
    const graph = { value: 1 };
    const manager = new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>());
    const passes = new PassManager<Graph>(manager, compilerOptions(), null, (g) =>
      maintained.push(g.value),
    );

    passes.run(graph, [
      { name: "noop", preserves: { kind: "all" }, run: () => ({ changed: false }) },
      {
        name: "mutate",
        preserves: { kind: "all" },
        run: (g) => {
          g.value = 2;
          return { changed: true };
        },
      },
      { name: "noop-again", preserves: { kind: "all" }, run: () => ({ changed: false }) },
    ]);

    expect(maintained).toEqual([2]);
  });

  it("runs no maintenance at all when nothing changes", () => {
    let maintenanceRuns = 0;
    const graph = { value: 1 };
    const manager = new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>());
    const passes = new PassManager<Graph>(manager, compilerOptions(), null, () => {
      maintenanceRuns++;
    });

    const inert: TransformPass<Graph> = {
      name: "inert",
      preserves: { kind: "all" },
      run: () => ({ changed: false }),
    };
    passes.run(graph, [inert, inert, inert]);

    expect(maintenanceRuns).toBe(0);
  });
});
