import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irInt32Sub,
  irReturn,
  irSelect,
  resetIRNodeIds,
  IR_PHI,
  IR_SELECT,
  type CFGBlock,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AOT_OPCODES, analyzeAotLegality } from "../../../src/optimizing/analyses/aot-legality.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { pointsToAnalysisId } from "../../../src/optimizing/analyses/points-to.js";
import { createAnalysisRegistry } from "../../../src/optimizing/analyses/index.js";
import { typeInferenceAnalysisId } from "../../../src/optimizing/analyses/type-inference.js";
import {
  legalizeOperations,
  type ValueLegality,
} from "../../../src/optimizing/passes/operation-legalization.js";

import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

const EVERY_VALUE: ValueLegality = new Map();

const admitting = (admits: (node: CFGInstruction) => boolean): ValueLegality =>
  new Map([[IR_SELECT, admits]]);

beforeEach(() => resetIRNodeIds());

const WITHOUT_SELECT = AOT_OPCODES;
const WITH_SELECT: ReadonlySet<string> = new Set([...AOT_OPCODES, IR_SELECT]);

interface Chosen {
  readonly graph: CFGFunction;
  readonly entry: CFGBlock;
  readonly raised: CFGInstruction;
  readonly lowered: CFGInstruction;
  readonly select: CFGInstruction;
}

function proven(node: CFGInstruction): CFGInstruction {
  node.props.noOverflow = true;
  return node;
}

function chooses(selects = 1): Chosen {
  const graph = new CFGFunction("clamped");
  graph.declaredSignature = { params: ["int"], names: ["n"], returns: "int" };
  const n = graph.addParameter(0);
  const entry = graph.addBlock();

  const zero = entry.addNode(irConstant(0));
  const negative = entry.addNode(irInt32Compare("<", n, zero));
  const two = entry.addNode(irConstant(2));
  const raised = entry.addNode(proven(irInt32Add(n, two)));
  const one = entry.addNode(irConstant(1));
  const lowered = entry.addNode(proven(irInt32Sub(n, one)));

  let merged = entry.addNode(irSelect(negative, raised, lowered));
  const select = merged;
  for (let more = 1; more < selects; more++) {
    merged = entry.addNode(irSelect(negative, merged, lowered));
  }
  entry.addNode(irReturn(merged));
  graph.rebuildUses();
  return { graph, entry, raised, lowered, select };
}

function nodesOf(graph: CFGFunction): CFGInstruction[] {
  return graph.blocks.flatMap((block) => block.nodes);
}

function legalityOf(graph: CFGFunction) {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return analyzeAotLegality(
    graph,
    analyses.get(typeInferenceAnalysisId),
    analyses.get(pointsToAnalysisId),
  );
}

describe("operation legalization", () => {
  it("leaves an operation the target emits alone", () => {
    const { graph, select } = chooses();
    graph.emits = WITH_SELECT;

    expect(legalizeOperations(graph, EVERY_VALUE)).toBe(0);
    expect(nodesOf(graph)).toContain(select);
  });

  it("does nothing when no target has named its opcodes", () => {
    const { graph, select } = chooses();

    expect(legalizeOperations(graph, EVERY_VALUE)).toBe(0);
    expect(nodesOf(graph)).toContain(select);
  });

  it("rewrites a select the target cannot emit into a branch over a phi", () => {
    const { graph, entry, raised, lowered } = chooses();
    graph.emits = WITHOUT_SELECT;

    expect(legalizeOperations(graph, EVERY_VALUE)).toBe(1);

    expect(nodesOf(graph).filter((node) => node.type === IR_SELECT)).toEqual([]);
    expect(entry.successors).toHaveLength(2);
    const [taken, otherwise] = entry.successors as [CFGBlock, CFGBlock];
    expect(taken.successors).toEqual(otherwise.successors);

    const join = taken.successors[0]!;
    expect(join.phis).toHaveLength(1);
    const merged = join.phis[0]!;
    expect(merged.inputs[join.predecessors.indexOf(taken)]).toBe(raised);
    expect(merged.inputs[join.predecessors.indexOf(otherwise)]).toBe(lowered);
    expect(join.getTerminator()!.inputs[0]).toBe(merged);
  });

  it("keeps the graph well formed and every node id its own", () => {
    const { graph } = chooses();
    graph.emits = WITHOUT_SELECT;
    legalizeOperations(graph, EVERY_VALUE);

    expect(() => validateGraphInvariants(graph)).not.toThrow();
  });

  it("rewrites every select in the block, including one feeding another", () => {
    const { graph } = chooses(3);
    graph.emits = WITHOUT_SELECT;

    expect(legalizeOperations(graph, EVERY_VALUE)).toBe(3);
    expect(nodesOf(graph).filter((node) => node.type === IR_SELECT)).toEqual([]);
    expect(nodesOf(graph).filter((node) => node.type === IR_PHI)).toHaveLength(3);
    expect(() => validateGraphInvariants(graph)).not.toThrow();
  });

  it("turns a function the target refused into one it admits", () => {
    const refused = chooses();
    refused.graph.emits = WITHOUT_SELECT;
    const before = legalityOf(refused.graph);
    expect(before.ok).toBe(false);
    expect(before.ok ? "" : before.reason).toContain(IR_SELECT);

    const rewritten = chooses();
    rewritten.graph.emits = WITHOUT_SELECT;
    legalizeOperations(rewritten.graph, EVERY_VALUE);

    expect(legalityOf(rewritten.graph).ok).toBe(true);
  });
  it("expands a select the target admits for one scalar but not the value's own", () => {
    const { graph, select } = chooses();
    graph.emits = WITH_SELECT;

    expect(legalizeOperations(graph, admitting((merged) => merged !== select))).toBe(1);
    expect(nodesOf(graph).filter((node) => node.type === IR_SELECT)).toEqual([]);
    expect(nodesOf(graph).filter((node) => node.type === IR_PHI)).toHaveLength(1);
    expect(() => validateGraphInvariants(graph)).not.toThrow();
  });

  it("leaves a select the target admits for the value at hand", () => {
    const { graph } = chooses();
    graph.emits = WITH_SELECT;

    expect(legalizeOperations(graph, admitting(() => true))).toBe(0);
    expect(nodesOf(graph).filter((node) => node.type === IR_SELECT)).toHaveLength(1);
  });
});
