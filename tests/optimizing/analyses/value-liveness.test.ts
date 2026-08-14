import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irJump,
  irReturn,
  resetIRNodeIds,
  type CFGBlock,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { computeValueLiveness } from "../../../src/optimizing/analyses/value-liveness.js";

beforeEach(() => resetIRNodeIds());

function names(live: ReadonlySet<CFGInstruction>, of: Map<CFGInstruction, string>): string[] {
  return [...live].map((value) => of.get(value) ?? `v${value.id}`).sort();
}

describe("computeValueLiveness", () => {
  it("keeps a value live through the blocks between its definition and its use", () => {
    const graph = new CFGFunction("straight");
    const entry = graph.addBlock();
    const middle = graph.addBlock();
    const exit = graph.addBlock();
    const defined = entry.addNode(irConstant(1));
    const carried = entry.addNode(irInt32Add(defined, defined));
    entry.addNode(irJump(middle));
    link(entry, middle);
    middle.addNode(irJump(exit));
    link(middle, exit);
    exit.addNode(irReturn(carried));

    const liveness = computeValueLiveness(graph);

    expect(liveness.liveIn(middle).has(carried)).toBe(true);
    expect(liveness.liveIn(exit).has(carried)).toBe(true);
    expect(liveness.liveIn(entry).has(carried)).toBe(false);
  });

  it("drops a value once every use is behind it", () => {
    const graph = new CFGFunction("consumed");
    const entry = graph.addBlock();
    const exit = graph.addBlock();
    const defined = entry.addNode(irConstant(1));
    const consumed = entry.addNode(irInt32Add(defined, defined));
    const result = entry.addNode(irInt32Add(consumed, consumed));
    entry.addNode(irJump(exit));
    link(entry, exit);
    exit.addNode(irReturn(result));

    const liveness = computeValueLiveness(graph);

    expect(liveness.liveIn(exit).has(consumed)).toBe(false);
    expect(liveness.liveIn(exit).has(result)).toBe(true);
  });

  it("charges a phi argument to the edge it arrives on, not to the block holding the phi", () => {
    const graph = new CFGFunction("merge");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const join = graph.addBlock();
    const zero = entry.addNode(irConstant(0));
    entry.addNode(irBranch(entry.addNode(irInt32Compare("==", zero, zero)), left, right));
    link(entry, left);
    link(entry, right);
    const fromLeft = left.addNode(irInt32Add(zero, zero));
    const fromRight = right.addNode(irInt32Add(zero, zero));
    left.addNode(irJump(join));
    right.addNode(irJump(join));
    connect(left, join);
    connect(right, join);
    const merged = addPhi(join, [fromLeft, fromRight]);
    join.addNode(irReturn(merged));

    const liveness = computeValueLiveness(graph);

    expect(liveness.liveOut(left).has(fromLeft)).toBe(true);
    expect(liveness.liveOut(left).has(fromRight)).toBe(false);
    expect(liveness.liveIn(join).has(merged)).toBe(false);
  });

  it("keeps a value defined outside a loop live around the back edge", () => {
    const graph = new CFGFunction("loop");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();
    const outside = entry.addNode(irConstant(7));
    entry.addNode(irJump(header));
    link(entry, header);
    const test = header.addNode(irInt32Compare("<", outside, outside));
    header.addNode(irBranch(test, body, exit));
    link(header, body);
    link(header, exit);
    const inside = body.addNode(irInt32Add(outside, outside));
    body.addNode(irJump(header));
    link(body, header);
    exit.addNode(irReturn(outside));

    const liveness = computeValueLiveness(graph);
    const labels = new Map<CFGInstruction, string>([
      [outside, "outside"],
      [inside, "inside"],
    ]);

    expect(names(liveness.liveIn(body), labels)).toEqual(["outside"]);
    expect(names(liveness.liveIn(header as CFGBlock), labels)).toEqual(["outside"]);
  });
});
