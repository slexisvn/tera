import { describe, expect, it } from "vitest";
import {
  AnalysisManager,
  AnalysisRegistry,
  analysisId,
  type AnalysisPass,
} from "../../../src/optimizing/infra/analysis-manager.js";
import {
  PassManager,
  VerificationError,
  type TransformPass,
} from "../../../src/optimizing/infra/pass-manager.js";
import { OptBisect } from "../../../src/optimizing/infra/opt-bisect.js";
import { remarks } from "../../../src/optimizing/infra/pass-remarks.js";
import type { PassTraceRecord } from "../../../src/optimizing/infra/pass-trace.js";
import { compilerOptions } from "../../../src/optimizing/options.js";

type Graph = { value: number };

function noting(name: string, record: () => void): TransformPass<Graph> {
  return {
    name,
    preserves: { kind: "all" },
    optional: true,
    run: () => {
      record();
      return { changed: false };
    },
  };
}

function tracedManager(): {
  graph: Graph;
  records: PassTraceRecord<Graph>[];
  traced: PassManager<Graph>;
} {
  const graph = { value: 1 };
  const manager = new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>());
  const records: PassTraceRecord<Graph>[] = [];
  const traced = new PassManager<Graph>(manager, compilerOptions(), {
    tracing: {
      probe: { nodeCount: (g) => g.value, dump: (g) => String(g.value) },
      trace: (record) => void records.push(record),
    },
  });
  return { graph, records, traced };
}

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
    const passes = new PassManager<Graph>(manager, compilerOptions(), {
      maintain: (g) => maintained.push(g.value),
    });

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
    const passes = new PassManager<Graph>(manager, compilerOptions(), {
      maintain: () => {
        maintenanceRuns++;
      },
    });

    const inert: TransformPass<Graph> = {
      name: "inert",
      preserves: { kind: "all" },
      run: () => ({ changed: false }),
    };
    passes.run(graph, [inert, inert, inert]);

    expect(maintenanceRuns).toBe(0);
  });

  it("puts each pass's remarks on that pass's own trace record", () => {
    const { graph, records, traced } = tracedManager();
    traced.run(graph, [
      noting("explains-itself", () => remarks.missed({ id: 4 }, "no room in the budget")),
      { name: "says-nothing", preserves: { kind: "all" }, run: () => ({ changed: false }) },
    ]);

    expect(records[0]!.remarks).toEqual([
      { kind: "missed", pass: "explains-itself", node: 4, message: "no room in the budget" },
    ]);
    expect(records[1]!.remarks).toEqual([]);
  });

  it("does not leak a throwing pass's remarks into the next run", () => {
    const { graph, records, traced } = tracedManager();
    const thrower: TransformPass<Graph> = {
      name: "throws",
      preserves: { kind: "all" },
      run: () => {
        remarks.missed({ id: 1 }, "recorded just before the crash");
        throw new Error("pass failed");
      },
    };

    expect(() => traced.run(graph, [thrower])).toThrow("pass failed");
    traced.run(graph, [
      { name: "after", preserves: { kind: "all" }, run: () => ({ changed: false }) },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.pass).toBe("after");
    expect(records[0]!.remarks).toEqual([]);
  });

  it("keeps the recorder shut when nobody is tracing", () => {
    const { graph, passes } = managerWith([]);
    let listened = true;
    passes.run(graph, [
      noting("checks-the-recorder", () => {
        listened = remarks.listening;
      }),
    ]);

    expect(listened).toBe(false);
  });
  it("runs no pass past the bisect limit", () => {
    const order: string[] = [];
    const graph = { value: 1 };
    const manager = new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>());
    const bisect = new OptBisect(2);
    const passes = new PassManager<Graph>(manager, compilerOptions("speed", { optBisect: bisect }));

    passes.run(graph, [
      noting("first", () => order.push("first")),
      noting("second", () => order.push("second")),
      noting("third", () => order.push("third")),
    ]);

    expect(order).toEqual(["first", "second"]);
    expect(bisect.attempts).toBe(3);
  });

  it("spends one bisect budget across every pipeline it is handed to", () => {
    const order: string[] = [];
    const bisect = new OptBisect(1);
    const options = compilerOptions("speed", { optBisect: bisect });
    const first = { value: 1 };
    const second = { value: 2 };
    const run = (graph: Graph, name: string) =>
      new PassManager<Graph>(
        new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>()),
        options,
      ).run(graph, [noting(name, () => order.push(name))]);

    run(first, "on-first-graph");
    run(second, "on-second-graph");

    expect(order).toEqual(["on-first-graph"]);
    expect(bisect.attempts).toBe(2);
  });

  it("gives a pass the same ordinal whatever the bisect limit is", () => {
    const traceWith = (limit: number): PassTraceRecord<Graph>[] => {
      const graph = { value: 1 };
      const records: PassTraceRecord<Graph>[] = [];
      const passes = new PassManager<Graph>(
        new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>()),
        compilerOptions("speed", { optBisect: new OptBisect(limit) }),
        {
          tracing: {
            probe: { nodeCount: (g) => g.value, dump: (g) => String(g.value) },
            trace: (record) => void records.push(record),
          },
        },
      );
      passes.run(graph, [noting("a", () => {}), noting("b", () => {}), noting("c", () => {})]);
      return records;
    };

    const whole = traceWith(Number.POSITIVE_INFINITY);
    const cut = traceWith(1);

    expect(cut.map((record) => [record.ordinal, record.pass])).toEqual(
      whole.map((record) => [record.ordinal, record.pass]),
    );
    expect(cut.map((record) => record.skipped)).toEqual([false, true, true]);
  });

  it("verifies a graph only after a pass that changed it", () => {
    const verified: string[] = [];
    const graph = { value: 1 };
    const manager = new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>());
    const passes = new PassManager<Graph>(manager, compilerOptions(), {
      verify: (_graph, pass) => {
        verified.push(pass);
        return [];
      },
    });

    passes.run(graph, [
      { name: "noop", preserves: { kind: "all" }, run: () => ({ changed: false }) },
      { name: "mutate", preserves: { kind: "all" }, run: () => ({ changed: true }) },
    ]);

    expect(verified).toEqual(["mutate"]);
  });

  it("traces the graph that broke an invariant before it throws", () => {
    const graph = { value: 1 };
    const records: PassTraceRecord<Graph>[] = [];
    const broken = new PassManager<Graph>(
      new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>()),
      compilerOptions(),
      {
        tracing: {
          probe: { nodeCount: (g) => g.value, dump: (g) => String(g.value) },
          trace: (record) => void records.push(record),
        },
        verify: () => ["v3 is used before its definition"],
      },
    );

    expect(() =>
      broken.run(graph, [
        {
          name: "breaks-ssa",
          preserves: { kind: "all" },
          run: (g) => {
            g.value = 99;
            return { changed: true };
          },
        },
        { name: "never-reached", preserves: { kind: "all" }, run: () => ({ changed: true }) },
      ]),
    ).toThrow(VerificationError);

    expect(records).toHaveLength(1);
    expect(records[0]!.pass).toBe("breaks-ssa");
    expect(records[0]!.verification).toEqual(["v3 is used before its definition"]);
    expect(records[0]!.graph.value).toBe(99);
  });

  it("times each pass it traces", () => {
    const { graph, records, traced } = tracedManager();
    const spin = (ms: number): TransformPass<Graph> => ({
      name: `spins-${ms}ms`,
      preserves: { kind: "all" },
      run: () => {
        const until = performance.now() + ms;
        while (performance.now() < until) {}
        return { changed: false };
      },
    });

    traced.run(graph, [spin(8)]);

    expect(records[0]!.elapsedMs).toBeGreaterThanOrEqual(3);
  });
  it("never skips a pass the pipeline needs, whatever the bisect limit", () => {
    const order: string[] = [];
    const graph = { value: 1 };
    const bisect = new OptBisect(0);
    const passes = new PassManager<Graph>(
      new AnalysisManager<Graph>(graph, new AnalysisRegistry<Graph>()),
      compilerOptions("speed", { optBisect: bisect }),
    );

    passes.run(graph, [
      {
        name: "lowering",
        preserves: { kind: "all" },
        run: () => {
          order.push("lowering");
          return { changed: false };
        },
      },
      noting("optimization", () => order.push("optimization")),
    ]);

    expect(order).toEqual(["lowering"]);
    expect(bisect.attempts).toBe(1);
  });
});
