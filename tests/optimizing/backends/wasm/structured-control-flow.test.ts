import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irJump,
  irReturn,
  resetIRNodeIds,
  type CFGBlock,
} from "../../../../src/optimizing/ir/index.js";
import { link } from "../../../../src/optimizing/ir/cfg-edit.js";
import {
  buildMergeResolver,
  findLabelDepth,
  type StructuredLabel,
} from "../../../../src/optimizing/backends/wasm/structured-control-flow.js";

beforeEach(() => resetIRNodeIds());

function resolverFor(blocks: CFGBlock[]) {
  const orderIndex = new Map<number, number>();
  blocks.forEach((block, index) => orderIndex.set(block.id, index));
  return buildMergeResolver(blocks, orderIndex);
}

function diamond() {
  const graph = new CFGFunction("diamond");
  const entry = graph.addBlock();
  const left = graph.addBlock();
  const right = graph.addBlock();
  const merge = graph.addBlock();

  const flag = irConstant(true);
  entry.addNode(flag);
  entry.addNode(irBranch(flag, left, right));
  link(entry, left);
  link(entry, right);
  left.addNode(irJump(merge));
  link(left, merge);
  right.addNode(irJump(merge));
  link(right, merge);
  merge.addNode(irReturn(irConstant(0)));
  graph.rebuildUses();
  return { graph, entry, left, right, merge, blocks: [entry, left, right, merge] };
}

describe("findLabelDepth", () => {
  const stack: StructuredLabel[] = [
    { type: "block", targetId: 9 },
    { type: "loop", targetId: 3 },
    { type: "if", targetId: null },
  ];

  it("counts depth from the innermost label outwards", () => {
    expect(findLabelDepth(stack, "if", null)).toBe(0);
    expect(findLabelDepth(stack, "loop", 3)).toBe(1);
    expect(findLabelDepth(stack, "block", 9)).toBe(2);
  });

  it("reports a missing label rather than guessing a depth", () => {
    expect(findLabelDepth(stack, "loop", 9)).toBe(-1);
    expect(findLabelDepth(stack, "block", 3)).toBe(-1);
    expect(findLabelDepth([], "block", 1)).toBe(-1);
  });

  it("matches the innermost label when a target repeats", () => {
    const repeated: StructuredLabel[] = [
      { type: "block", targetId: 5 },
      { type: "block", targetId: 5 },
    ];

    expect(findLabelDepth(repeated, "block", 5)).toBe(0);
  });
});

describe("buildMergeResolver", () => {
  it("finds the join point of a diamond", () => {
    const { left, right, merge, blocks } = diamond();

    expect(resolverFor(blocks).find(left.id, right.id)).toBe(merge.id);
  });

  it("refuses a merge that is one of the arms itself", () => {
    const graph = new CFGFunction("early-exit");
    const entry = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    const flag = irConstant(true);
    entry.addNode(flag);
    entry.addNode(irBranch(flag, body, exit));
    link(entry, body);
    link(entry, exit);
    body.addNode(irJump(exit));
    link(body, exit);
    exit.addNode(irReturn(irConstant(0)));
    graph.rebuildUses();

    expect(resolverFor([entry, body, exit]).find(body.id, exit.id)).toBeNull();
  });

  it("refuses arms that never rejoin", () => {
    const graph = new CFGFunction("split");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();

    const flag = irConstant(true);
    entry.addNode(flag);
    entry.addNode(irBranch(flag, left, right));
    link(entry, left);
    link(entry, right);
    left.addNode(irReturn(irConstant(1)));
    right.addNode(irReturn(irConstant(2)));
    graph.rebuildUses();

    expect(resolverFor([entry, left, right]).find(left.id, right.id)).toBeNull();
  });

  it("reports nothing for blocks outside the emitted order", () => {
    const { left, right, blocks } = diamond();
    const resolver = resolverFor(blocks.slice(0, 3));

    expect(resolver.find(left.id, right.id)).toBeNull();
    expect(resolver.find(left.id, 999)).toBeNull();
  });
});
