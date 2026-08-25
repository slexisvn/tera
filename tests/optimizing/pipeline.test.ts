import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  IR_CHECK_SMI,
  irBranch,
  irCheckSmi,
  irConstant,
  irLoadField,
  irStoreField,
  irInt32Add,
  irJump,
  irReturn,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";
import { link } from "../../src/optimizing/ir/cfg-edit.js";
import { FrameState } from "../../src/deopt/frame-state.js";
import {
  cfgPassManager,
  cfgPassTracing,
  middleEndPhases,
  middleEndPipeline,
  runMiddleEnd,
} from "../../src/optimizing/pipeline.js";
import { createAnalysisRegistry } from "../../src/optimizing/analyses/index.js";
import { consolePassTracer } from "../../src/optimizing/infra/pass-trace.js";
import { cfgGraphProbe } from "../../src/optimizing/ir/probe.js";
import type { TransformPass } from "../../src/optimizing/infra/pass-manager.js";
import {
  AnalysisManager,
  AnalysisRegistry,
  analysisId,
  type AnalysisPass,
} from "../../src/optimizing/infra/analysis-manager.js";
import { PassManager } from "../../src/optimizing/infra/pass-manager.js";
import { compilerOptions } from "../../src/optimizing/options.js";
import { parseIR, printIR } from "../../src/optimizing/ir/text.js";

beforeEach(() => resetIRNodeIds());

function passNamed(name: string) {
  const pass = middleEndPipeline({ feedback: undefined }).find(
    (candidate) => candidate.name === name,
  );
  if (!pass) throw new Error(`missing pass ${name}`);
  return pass;
}

function foldedGraph(): CFGFunction {
  const graph = new CFGFunction("folded");
  const block = graph.addBlock();
  const left = irConstant(20);
  const right = irConstant(22);
  const sum = irInt32Add(left, right);
  block.addNode(left);
  block.addNode(right);
  block.addNode(sum);
  block.addNode(irReturn(sum));
  return graph;
}

function stableGraph(): CFGFunction {
  const graph = new CFGFunction("stable");
  const param = graph.addParameter(0);
  const block = graph.addBlock();
  block.addNode(irReturn(param));
  return graph;
}

function managerFor(graph: CFGFunction) {
  let runs = 0;
  const id = analysisId<number>("node-count");
  const pass: AnalysisPass<CFGFunction, number> = {
    id,
    run: (g) => {
      runs++;
      return g.blocks.reduce((sum, block) => sum + block.nodes.length, 0);
    },
  };
  const registry = new AnalysisRegistry<CFGFunction>();
  registry.register(pass);
  const manager = new AnalysisManager(graph, registry);
  return { id, manager, runs: () => runs };
}

describe("middleEndPipeline pass reporting", () => {
  it("invalidates analyses when a real pass mutates the graph", () => {
    const graph = foldedGraph();
    const analysis = managerFor(graph);
    const passes = new PassManager(analysis.manager, compilerOptions());

    expect(analysis.manager.get(analysis.id)).toBe(4);
    expect(passes.run(graph, [passNamed("sccp")])).toBe(true);
    expect(analysis.manager.get(analysis.id)).toBe(4);
    expect(analysis.runs()).toBe(2);
  });

  it("keeps analyses cached when a real pass makes no change", () => {
    const graph = stableGraph();
    const analysis = managerFor(graph);
    const passes = new PassManager(analysis.manager, compilerOptions());

    expect(analysis.manager.get(analysis.id)).toBe(1);
    expect(passes.run(graph, [passNamed("sccp")])).toBe(false);
    expect(analysis.manager.get(analysis.id)).toBe(1);
    expect(analysis.runs()).toBe(1);
  });
});

function captureConsole(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

const printingOptions = () =>
  compilerOptions("speed", { passTracer: consolePassTracer(cfgGraphProbe) });

describe("pass tracing", () => {
  it("builds no tracing while no tracer is installed", () => {
    expect(cfgPassTracing(compilerOptions("speed"))).toBeNull();
  });

  it("builds tracing once a tracer is installed", () => {
    expect(cfgPassTracing(printingOptions())).not.toBeNull();
  });

  it("hands every record the live graph so a sink can capture what it wants", () => {
    const seen: { pass: string; name: string; nodes: number }[] = [];
    const options = compilerOptions("speed", {
      passTracer: (record) =>
        void seen.push({
          pass: record.pass,
          name: record.graph.name,
          nodes: record.nodesAfter,
        }),
    });
    runMiddleEnd(foldedGraph(), options);

    expect(seen).toHaveLength(middleEndPipeline(options).length + 1);
    expect(seen[0]).toMatchObject({ pass: "ir-builder", name: "folded" });
    expect(seen.every((record) => record.name === "folded")).toBe(true);
    expect(seen[seen.length - 1]!.nodes).toBe(2);
  });

  it("prints exactly one section per middle-end pass", () => {
    const options = printingOptions();
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), options));

    expect(sections).toHaveLength(middleEndPipeline(options).length + 1);
    expect(sections.every((section) => section.startsWith("*** IR after #"))).toBe(true);
  });

  it("attributes each change and invalidation to the pass that caused it", () => {
    const options = printingOptions();
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), options));
    const headerOf = (name: string) =>
      sections.find((section) => section.includes(` ${name} [`))?.split("\n")[0];

    expect(headerOf("sccp")).toContain(
      "sccp [changed, nodes 4 -> 4 (+0), invalidated type-inference dominance loops points-to mod-ref] ***",
    );
    expect(headerOf("dead-code-elimination-after-late-escape")).toContain(
      "dead-code-elimination-after-late-escape [changed, nodes 4 -> 2 (-2), invalidated points-to mod-ref] ***",
    );
    expect(headerOf("gvn")).toContain("[unchanged, nodes 4 -> 4 (+0), invalidated nothing]");
  });

  it("dumps the graph body under every section header", () => {
    const options = printingOptions();
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), options));
    const folded = sections.find((section) => section.includes(" sccp ["));

    expect(folded).toContain("fn folded params=0 {");
    expect(folded).toContain("= Constant [value=42]");
  });

  it("dumps a body that parses back into the same graph", () => {
    const options = printingOptions();
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), options));
    const body = sections[sections.length - 1]!.slice(
      sections[sections.length - 1]!.indexOf("fn folded"),
    );

    expect(printIR(parseIR(body))).toBe(body);
  });

  it("opens with the graph the builder produced, before any pass ran", () => {
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), printingOptions()));

    expect(sections[0]).toContain("*** IR after #-1 ir-builder [changed, nodes 4 -> 4 (+0)");
    expect(sections[0]).toContain("Int32Add");
  });

  it("stays silent while the option is off", () => {
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), compilerOptions("speed")));

    expect(sections).toEqual([]);
  });
});

describe("cfgPassManager graph verification", () => {
  const dropsAUseEntry = (name: string): TransformPass<CFGFunction> => ({
    name,
    preserves: { kind: "all" },
    run: (graph) => {
      graph.blocks[0]!.nodes[0]!.uses.pop();
      return { changed: true };
    },
  });

  const managerWith = (graph: CFGFunction, verifyEachPass: boolean) =>
    cfgPassManager(
      new AnalysisManager(graph, createAnalysisRegistry()),
      compilerOptions("speed", { verifyEachPass }),
    );

  it("names the pass that left the graph inconsistent", () => {
    const graph = foldedGraph();
    graph.rebuildUses();

    expect(() => managerWith(graph, true).run(graph, [dropsAUseEntry("wrecker")])).toThrow(
      /folded after wrecker/,
    );
  });

  it("leaves the graph unchecked when verification is off", () => {
    const graph = foldedGraph();
    graph.rebuildUses();

    expect(() => managerWith(graph, false).run(graph, [dropsAUseEntry("wrecker")])).not.toThrow();
  });

  it("accepts a pass that keeps the graph consistent", () => {
    const graph = foldedGraph();
    graph.rebuildUses();

    expect(managerWith(graph, true).run(graph, [passNamed("sccp")])).toBe(true);
  });
});

describe("peeling a guard out of a loop", () => {
  function loopGuardingAnInvariant(): {
    graph: CFGFunction;
    preHeader: ReturnType<CFGFunction["addBlock"]>;
    body: ReturnType<CFGFunction["addBlock"]>;
  } {
    const graph = new CFGFunction("guarded");
    const limit = graph.addParameter(0);
    const repeat = graph.addParameter(1);
    const preHeader = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    link(preHeader, header);
    preHeader.addNode(irJump(header));

    link(header, body);
    link(header, exit);
    header.addNode(irBranch(repeat, body, exit));

    const guard = irCheckSmi(limit);
    guard.frameState = new FrameState(null, 0);
    body.addNode(guard);
    link(body, header);
    body.addNode(irJump(header));

    exit.addNode(irReturn(exit.addNode(irConstant(0))));
    graph.rebuildUses();
    return { graph, preHeader, body };
  }

  const guardsIn = (block: { nodes: ReadonlyArray<{ type: string }> }): number =>
    block.nodes.filter((node) => node.type === IR_CHECK_SMI).length;

  it("leaves the guard checked once, in the pre-header", () => {
    const { graph, preHeader, body } = loopGuardingAnInvariant();
    runMiddleEnd(graph, compilerOptions("speed"));
    expect(guardsIn(preHeader)).toBe(1);
    expect(guardsIn(body)).toBe(0);
  });

  it("keeps the guard inside the loop when the peel budget forbids peeling", () => {
    const { graph, preHeader, body } = loopGuardingAnInvariant();
    runMiddleEnd(graph, compilerOptions("speed", { peelBudget: 0 }));
    expect(guardsIn(preHeader)).toBe(0);
    expect(guardsIn(body)).toBe(1);
  });

  function loopGuardingAMutatedField(): {
    graph: CFGFunction;
    body: ReturnType<CFGFunction["addBlock"]>;
  } {
    const graph = new CFGFunction("mutating");
    const holder = graph.addParameter(0);
    const repeat = graph.addParameter(1);
    const preHeader = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    link(preHeader, header);
    preHeader.addNode(irJump(header));

    link(header, body);
    link(header, exit);
    header.addNode(irBranch(repeat, body, exit));

    const loaded = body.addNode(irLoadField(holder, 0));
    const guard = irCheckSmi(loaded);
    guard.frameState = new FrameState(null, 0);
    body.addNode(guard);
    body.addNode(irStoreField(holder, 0, body.addNode(irConstant(1))));
    link(body, header);
    body.addNode(irJump(header));

    exit.addNode(irReturn(exit.addNode(irConstant(0))));
    graph.rebuildUses();
    return { graph, body };
  }

  it("keeps the guard inside the loop when the loop rewrites the field it guards", () => {
    const { graph, body } = loopGuardingAMutatedField();
    runMiddleEnd(graph, compilerOptions("speed"));
    expect(guardsIn(body)).toBe(1);
  });
});
