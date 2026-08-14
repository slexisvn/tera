import { describe, expect, it } from "vitest";
import {
  AnalysisManager,
  AnalysisRegistry,
  analysisId,
  type AnalysisPass,
} from "../../../src/optimizing/infra/analysis-manager.js";

type Graph = { value: number };

describe("AnalysisManager", () => {
  it("computes an analysis once and caches the result", () => {
    let runs = 0;
    const id = analysisId<number>("doubler");
    const pass: AnalysisPass<Graph, number> = {
      id,
      run: (graph) => {
        runs++;
        return graph.value * 2;
      },
    };
    const registry = new AnalysisRegistry<Graph>();
    registry.register(pass);
    const analyses = new AnalysisManager<Graph>({ value: 21 }, registry);

    expect(analyses.get(id)).toBe(42);
    expect(analyses.get(id)).toBe(42);
    expect(runs).toBe(1);
  });

  it("recomputes an analysis after it is invalidated", () => {
    let runs = 0;
    const id = analysisId<number>("counter");
    const registry = new AnalysisRegistry<Graph>();
    registry.register({ id, run: () => ++runs });
    const analyses = new AnalysisManager<Graph>({ value: 0 }, registry);

    analyses.get(id);
    analyses.invalidate(id);
    analyses.get(id);
    expect(runs).toBe(2);
  });

  it("clears every cached analysis on invalidateAll", () => {
    let runs = 0;
    const id = analysisId<number>("counter");
    const registry = new AnalysisRegistry<Graph>();
    registry.register({ id, run: () => ++runs });
    const analyses = new AnalysisManager<Graph>({ value: 0 }, registry);

    analyses.get(id);
    analyses.invalidateAll();
    analyses.get(id);
    expect(runs).toBe(2);
  });

  it("resolves a transitive analysis dependency through the manager", () => {
    const base = analysisId<number>("base");
    const derived = analysisId<number>("derived");
    const registry = new AnalysisRegistry<Graph>();
    registry.register({ id: base, run: (graph) => graph.value + 1 });
    registry.register({ id: derived, run: (_graph, analyses) => analyses.get(base) * 10 });
    const analyses = new AnalysisManager<Graph>({ value: 4 }, registry);

    expect(analyses.get(derived)).toBe(50);
  });

  it("throws when resolving an unregistered analysis", () => {
    const registry = new AnalysisRegistry<Graph>();
    const analyses = new AnalysisManager<Graph>({ value: 0 }, registry);
    expect(() => analyses.get(analysisId<number>("missing"))).toThrow(/missing/);
  });
});
