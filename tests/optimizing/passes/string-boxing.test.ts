import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irGenericAdd,
  irJump,
  irReturn,
  resetIRNodeIds,
  IR_LOAD_TEXT,
  IR_NEW_OBJECT,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import { boxEscapingStrings } from "../../../src/optimizing/passes/string-boxing.js";

beforeEach(() => resetIRNodeIds());

interface Carried {
  readonly graph: CFGFunction;
  readonly phi: CFGInstruction;
  readonly answer: CFGInstruction;
}

function carrying(other: "join" | "constant" | "number"): Carried {
  const graph = new CFGFunction("carry");
  graph.classes = buildClassTable([]);
  const entry = graph.addBlock();
  const taken = graph.addBlock();
  const skipped = graph.addBlock();
  const join = graph.addBlock();

  const left = entry.addNode(irConstant("a"));
  const right = entry.addNode(irConstant("b"));
  link(entry, taken);
  link(entry, skipped);
  entry.addNode(irBranch(entry.addNode(irConstant(true)), taken, skipped));

  const built = taken.addNode(irGenericAdd(left, right));
  link(taken, join);
  taken.addNode(irJump(join));

  const held =
    other === "join"
      ? skipped.addNode(irGenericAdd(right, left))
      : skipped.addNode(irConstant(other === "constant" ? "c" : 1));
  link(skipped, join);
  skipped.addNode(irJump(join));

  const phi = addPhi(join, [built, held]);
  const answer = irReturn(phi);
  join.addNode(answer);
  graph.rebuildUses();
  return { graph, phi, answer };
}

function box(carried: Carried): number {
  return boxEscapingStrings(
    carried.graph,
    new AnalysisManager(carried.graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
  );
}

describe("strings a phi carries from more than one place", () => {
  it("gives each incoming string its own allocation", () => {
    const carried = carrying("join");
    box(carried);

    expect(carried.phi.inputs.map((input) => input.type)).toEqual([
      IR_NEW_OBJECT,
      IR_NEW_OBJECT,
    ]);
  });

  it("reads the carried string back out of what the phi holds", () => {
    const carried = carrying("join");
    box(carried);

    expect(carried.answer.inputs[0]!.type).toBe(IR_LOAD_TEXT);
    expect(carried.answer.inputs[0]!.inputs[0]).toBe(carried.phi);
  });

  it("reports the web it rewrote", () => {
    expect(box(carrying("join"))).toBe(1);
  });

  it("leaves a phi fed by one producer and a constant alone", () => {
    const carried = carrying("constant");

    expect(box(carried)).toBe(0);
    expect(carried.answer.inputs[0]).toBe(carried.phi);
  });

  it("leaves a phi alone when one arm carries no string at all", () => {
    const carried = carrying("number");

    expect(box(carried)).toBe(0);
    expect(carried.answer.inputs[0]).toBe(carried.phi);
  });
});
