import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  IR_BOX,
  IR_CALL_BUILTIN,
  IR_UNBOX,
  irBranch,
  irCallBuiltin,
  irCheckSmi,
  irConstant,
  irJump,
  irInt32Add,
  irLoadGlobal,
  irNewObject,
  irReturn,
  irStoreField,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";
import { middleEndPhases, runMiddleEnd } from "../../src/optimizing/pipeline.js";
import { compilerOptions } from "../../src/optimizing/options.js";
import { AnalysisManager } from "../../src/optimizing/infra/analysis-manager.js";
import { PassManager } from "../../src/optimizing/infra/pass-manager.js";
import { createAnalysisRegistry } from "../../src/optimizing/analyses/index.js";
import { cfgGraphProbe } from "../../src/optimizing/ir/probe.js";
import { addPhi, link } from "../../src/optimizing/ir/cfg-edit.js";
import { eliminateTrivialPhis } from "../../src/optimizing/passes/dce.js";
import { hoistLoopInvariants } from "../../src/optimizing/passes/loop-opts.js";
import { loopForestAnalysisId } from "../../src/optimizing/analyses/loops.js";
import { pointsToAnalysisId } from "../../src/optimizing/analyses/points-to.js";
import { modRefAnalysisId } from "../../src/optimizing/analyses/mod-ref.js";
import { targetLegalizationPipeline } from "../../src/optimizing/target/legalization.js";
import type { TargetModel } from "../../src/optimizing/target/model.js";
import { wasmTarget } from "../../src/optimizing/backends/wasm/target.js";
import { cTarget } from "../../src/optimizing/backends/c/target.js";

beforeEach(() => resetIRNodeIds());

function graphWithDeadStoreAndArithmetic(): CFGFunction {
  const graph = new CFGFunction("shapes");
  const param = graph.addParameter(0);
  const block = graph.addBlock();

  const object = irNewObject();
  const stored = irConstant(7);
  const dead = irStoreField(object, 0, stored);
  const one = irConstant(1);
  const sum = irInt32Add(param, one);

  block.addNode(object);
  block.addNode(stored);
  block.addNode(dead);
  block.addNode(one);
  block.addNode(sum);
  block.addNode(irReturn(sum));
  graph.rebuildUses();
  return graph;
}

function passNames(): string[] {
  return middleEndPhases(compilerOptions())
    .flatMap((phase) => phase.passes)
    .map((pass) => pass.name);
}

function nodeDeltasByPass(graph: CFGFunction): Array<{ pass: string; delta: number }> {
  const options = compilerOptions();
  const manager = new PassManager(
    new AnalysisManager(graph, createAnalysisRegistry()),
    options,
  );
  const deltas: Array<{ pass: string; delta: number }> = [];
  for (const phase of middleEndPhases(options)) {
    for (const pass of phase.passes) {
      const before = cfgGraphProbe.nodeCount(graph);
      manager.run(graph, [pass]);
      deltas.push({ pass: pass.name, delta: cfgGraphProbe.nodeCount(graph) - before });
    }
  }
  return deltas;
}

function graphBranchingOnATaggedGlobal(): CFGFunction {
  const graph = new CFGFunction("branching");
  const param = graph.addParameter(0);
  const entry = graph.addBlock();
  const taken = graph.addBlock();
  const skipped = graph.addBlock();

  const flag = irLoadGlobal("flag");
  entry.addNode(flag);
  entry.addNode(irBranch(flag, taken, skipped));
  link(entry, taken);
  link(entry, skipped);

  const smi = irCheckSmi(param);
  taken.addNode(smi);
  taken.addNode(irReturn(smi));
  skipped.addNode(irReturn(irConstant(0)));
  graph.rebuildUses();
  return graph;
}

function passNamesFor(target: TargetModel): string[] {
  return targetLegalizationPipeline(target).map((pass) => pass.name);
}

function lower(graph: CFGFunction, target: TargetModel): void {
  const options = compilerOptions();
  runMiddleEnd(graph, options);
  new PassManager(new AnalysisManager(graph, createAnalysisRegistry()), options).run(
    graph,
    targetLegalizationPipeline(target),
  );
}

function loweringDeltasByPass(
  graph: CFGFunction,
  target: TargetModel,
): Array<{ pass: string; delta: number }> {
  const options = compilerOptions();
  runMiddleEnd(graph, options);
  const manager = new PassManager(
    new AnalysisManager(graph, createAnalysisRegistry()),
    options,
  );
  const deltas: Array<{ pass: string; delta: number }> = [];
  for (const pass of targetLegalizationPipeline(target)) {
    const before = cfgGraphProbe.nodeCount(graph);
    manager.run(graph, [pass]);
    deltas.push({ pass: pass.name, delta: cfgGraphProbe.nodeCount(graph) - before });
  }
  return deltas;
}

function boxingNodes(graph: CFGFunction): string[] {
  return graph.blocks
    .flatMap((block) => block.nodes)
    .filter((node) => node.type === IR_BOX || node.type === IR_UNBOX)
    .map((node) => `${node.type} v${node.id}`);
}

function loopCarryingAnInvariantThroughAPhi() {
  const graph = new CFGFunction("carried");
  const receiver = graph.addParameter(0);
  const preheader = graph.addBlock();
  const header = graph.addBlock();
  const body = graph.addBlock();
  const exit = graph.addBlock();

  const zero = irConstant(0);
  preheader.addNode(zero);
  preheader.addNode(irJump(header));
  link(preheader, header);
  link(header, body);
  link(header, exit);
  link(body, header);

  const carried = addPhi(header, [receiver, receiver]);
  const condition = irConstant(1);
  header.addNode(condition);
  header.addNode(irBranch(condition, body, exit));

  const hoistable = irCallBuiltin("string.length", [carried], {
    declaredEffects: ["immutable-read"],
  });
  body.addNode(hoistable);
  body.addNode(irJump(header));
  exit.addNode(irReturn(zero));

  header.isLoopHeader = true;
  graph.rebuildUses();
  return { graph, preheader, hoistable };
}

function hoist(graph: CFGFunction): void {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  hoistLoopInvariants(
    graph,
    analyses.get(loopForestAnalysisId),
    analyses.get(pointsToAnalysisId),
    analyses.get(modRefAnalysisId),
  );
}

describe("pipeline ordering invariants", () => {
  it("cannot hoist a value carried through an untouched loop-header phi", () => {
    const { graph, preheader } = loopCarryingAnInvariantThroughAPhi();

    hoist(graph);

    expect(preheader.nodes.some((node) => node.type === IR_CALL_BUILTIN)).toBe(false);
  });

  it("hoists that same value once trivial phis have been eliminated first", () => {
    const { graph, preheader } = loopCarryingAnInvariantThroughAPhi();

    eliminateTrivialPhis(graph);
    graph.rebuildUses();
    hoist(graph);

    expect(preheader.nodes.some((node) => node.type === IR_CALL_BUILTIN)).toBe(true);
  });




  it("never grows the graph after representation selection", () => {
    const deltas = loweringDeltasByPass(graphWithDeadStoreAndArithmetic(), wasmTarget);
    const selection = deltas.findIndex((entry) => entry.pass === "representation-selection");

    expect(selection).toBeGreaterThanOrEqual(0);
    expect(deltas.length - selection).toBeGreaterThan(1);
    expect(deltas.slice(selection + 1).filter((entry) => entry.delta > 0)).toEqual([]);
  });

  it("gives every surviving node a representation once wasm lowering finishes", () => {
    const graph = graphWithDeadStoreAndArithmetic();
    lower(graph, wasmTarget);

    const unstamped = graph.blocks
      .flatMap((block) => block.nodes)
      .filter((node) => node.props._rep === undefined)
      .map((node) => `${node.type} v${node.id}`);

    expect(unstamped).toEqual([]);
  });

  it("selects representations only for targets that have tagged values", () => {
    expect(passNamesFor(wasmTarget)).toContain("representation-selection");
    expect(passNamesFor(cTarget)).not.toContain("representation-selection");
  });

  it("leaves no boxing ceremony for an untagged target to strip", () => {
    const tagged = graphBranchingOnATaggedGlobal();
    lower(tagged, wasmTarget);
    expect(boxingNodes(tagged).length).toBeGreaterThan(0);

    const untagged = graphBranchingOnATaggedGlobal();
    lower(untagged, cTarget);

    expect(boxingNodes(untagged)).toEqual([]);
    expect(
      untagged.blocks.flatMap((block) => block.nodes).filter((node) => node.props._rep !== undefined),
    ).toEqual([]);
  });
});
