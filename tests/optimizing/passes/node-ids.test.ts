import { describe, it, expect, beforeEach } from "vitest";
import { runNamedPass } from "../../../src/optimizing/drivers/text-driver.js";
import { parseIR } from "../../../src/optimizing/ir/text.js";
import { strengthReduction } from "../../../src/optimizing/passes/simplify.js";
import { faultOnZeroDivisor } from "../../../src/optimizing/passes/zero-divisor.js";
import { withFreshNodeIds } from "../../../src/optimizing/passes/coroutines.js";
import { nodeIdStamper } from "../../../src/optimizing/ir/graph-edit.js";
import {
  irConstant,
  resetIRNodeIds,
  type CFGFunction,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

function sharedIds(graph: CFGFunction): readonly string[] {
  const owners = new Map<number, CFGInstruction>();
  const shared: string[] = [];
  const claim = (node: CFGInstruction): void => {
    const held = owners.get(node.id);
    if (held === undefined) {
      owners.set(node.id, node);
      return;
    }
    if (held !== node) shared.push(`v${node.id}: ${held.type} and ${node.type}`);
  };
  for (const parameter of graph.parameters) claim(parameter);
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      claim(node);
      for (const input of node.inputs) if (input.block === null) claim(input);
    }
  }
  return shared;
}

// v4 is one past the four values the text names, so parsing used to leave the
// allocator pointing straight at an id the graph already carries.
const SPARSE_MULTIPLY = `fn scaled params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Constant [value=8]
    v2 = Int32Mul v0, v1 [noOverflow=true]
    v4 = Return v2
}`;

const DIVIDE_THEN_MULTIPLY = `fn ratio params=2 {
  v0 = Parameter [index=0]
  v1 = Parameter [index=1]
  B0 succs= preds=:
    v2 = Int32Div v0, v1
    v3 = Constant [value=8]
    v4 = Int32Mul v2, v3 [noOverflow=true]
    v5 = Return v4
}`;

describe("node ids minted by a pass", () => {
  it("do not repeat an id the parsed graph already carries", () => {
    const graph = parseIR(SPARSE_MULTIPLY);
    strengthReduction(graph);
    graph.rebuildUses();

    expect(sharedIds(graph)).toEqual([]);
  });

  it("survive the printed graph being parsed back", () => {
    const printed = runNamedPass(SPARSE_MULTIPLY, "strength-reduction").text;

    expect(() => parseIR(printed)).not.toThrow();
  });

  it("do not repeat an id an earlier stamping pass handed out", () => {
    const graph = parseIR(DIVIDE_THEN_MULTIPLY);
    faultOnZeroDivisor(graph);
    strengthReduction(graph);
    graph.rebuildUses();

    expect(sharedIds(graph)).toEqual([]);
  });

  it("do not repeat an id the coroutine rewrite handed out", () => {
    const graph = parseIR(DIVIDE_THEN_MULTIPLY);

    const rewritten = withFreshNodeIds(graph, () => irConstant(1));
    const later = irConstant(2);

    expect(later.id).toBeGreaterThan(rewritten.id);
  });

  it("keep a stamper and the value constructors on one counter", () => {
    const graph = parseIR(SPARSE_MULTIPLY);
    const stamp = nodeIdStamper(graph);

    const stamped = stamp(irConstant(1));
    const constructed = irConstant(2);

    expect(stamped.id).not.toBe(constructed.id);
  });

  it("stay above every id in a graph the driver parsed", () => {
    const printed = runNamedPass(SPARSE_MULTIPLY, "strength-reduction").text;

    expect(sharedIds(parseIR(printed))).toEqual([]);
  });
});
