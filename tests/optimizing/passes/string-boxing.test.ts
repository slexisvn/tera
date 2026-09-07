import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irGenericAdd,
  irJump,
  irReturn,
  resetIRNodeIds,
  irLoadElement,
  irNewObject,
  irStoreElement,
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
import { SCALAR_TEXT } from "../../../src/optimizing/types/scalar.js";

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

describe("a string read out of an array that the program writes back into", () => {
  interface Swapped {
    readonly graph: CFGFunction;
    readonly read: CFGInstruction;
    readonly answer: CFGInstruction;
  }

  function reading(overwritten: "same" | "never"): Swapped {
    const graph = new CFGFunction("swap");
    graph.classes = buildClassTable([]);
    const block = graph.addBlock();
    const buffer = block.addNode(irNewObject());
    const here = block.addNode(irConstant(0));
    const there = block.addNode(irConstant(1));
    const read = block.addNode(irLoadElement(buffer, here));
    read.props.elementScalar = SCALAR_TEXT;
    if (overwritten === "same") {
      const written = block.addNode(irLoadElement(buffer, there));
      written.props.elementScalar = SCALAR_TEXT;
      const store = block.addNode(irStoreElement(buffer, here, written));
      store.props.elementScalar = SCALAR_TEXT;
    }
    const answer = block.addNode(irStoreElement(buffer, there, read));
    answer.props.elementScalar = SCALAR_TEXT;
    block.addNode(irReturn(buffer));
    graph.rebuildUses();
    return { graph, read, answer };
  }

  const boxing = (swapped: Swapped): number =>
    boxEscapingStrings(
      swapped.graph,
      new AnalysisManager(swapped.graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    );

  it("copies the string it read before the slot it came from is written", () => {
    const swapped = reading("same");
    boxing(swapped);

    expect(swapped.answer.inputs[2]!.type).toBe(IR_LOAD_TEXT);
    expect(swapped.answer.inputs[2]!.inputs[0]!.type).toBe(IR_NEW_OBJECT);
  });

  it("reports the read it rewrote", () => {
    expect(boxing(reading("same"))).toBe(1);
  });

  it("leaves the read alone when nothing writes the array in between", () => {
    const swapped = reading("never");

    expect(boxing(swapped)).toBe(0);
    expect(swapped.answer.inputs[2]).toBe(swapped.read);
  });
});
