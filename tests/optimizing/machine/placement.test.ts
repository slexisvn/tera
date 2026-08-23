import { describe, expect, it } from "vitest";
import { MachineFunction, type MachineBlock } from "../../../src/optimizing/machine/ir.js";
import { placeLoopHeadersAfterBodies } from "../../../src/optimizing/machine/placement.js";

function functionOf(labels: readonly string[]): {
  fn: MachineFunction;
  blocks: MachineBlock[];
} {
  const fn = new MachineFunction("probe", "probe");
  return { fn, blocks: labels.map((name) => fn.createBlock(name)) };
}

function edge(from: MachineBlock, to: MachineBlock): void {
  from.successors.push(to);
  to.predecessors.push(from);
}

const order = (fn: MachineFunction): string[] => fn.blocks.map((block) => block.label);

describe("placeLoopHeadersAfterBodies", () => {
  it("moves a loop header below the body that jumps back to it", () => {
    const { fn, blocks } = functionOf(["entry", "header", "body", "exit"]);
    const [entry, header, body, exit] = blocks as [
      MachineBlock,
      MachineBlock,
      MachineBlock,
      MachineBlock,
    ];
    edge(entry, header);
    edge(header, body);
    edge(header, exit);
    edge(body, header);

    expect(placeLoopHeadersAfterBodies(fn)).toBe(1);
    expect(order(fn)).toEqual(["entry", "body", "header", "exit"]);
  });

  it("keeps the entry block first even when it heads a loop", () => {
    const { fn, blocks } = functionOf(["header", "body", "exit"]);
    const [header, body, exit] = blocks as [MachineBlock, MachineBlock, MachineBlock];
    edge(header, body);
    edge(header, exit);
    edge(body, header);

    expect(placeLoopHeadersAfterBodies(fn)).toBe(0);
    expect(order(fn)).toEqual(["header", "body", "exit"]);
  });

  it("places the inner header before it places the outer one", () => {
    const { fn, blocks } = functionOf(["entry", "outer", "inner", "body", "exit"]);
    const [entry, outer, inner, body, exit] = blocks as [
      MachineBlock,
      MachineBlock,
      MachineBlock,
      MachineBlock,
      MachineBlock,
    ];
    edge(entry, outer);
    edge(outer, inner);
    edge(outer, exit);
    edge(inner, body);
    edge(inner, outer);
    edge(body, inner);

    expect(placeLoopHeadersAfterBodies(fn)).toBe(2);
    expect(order(fn)).toEqual(["entry", "body", "inner", "outer", "exit"]);
  });

  it("leaves a function without a back edge in the order it was given", () => {
    const { fn, blocks } = functionOf(["entry", "then", "join"]);
    const [entry, then, join] = blocks as [MachineBlock, MachineBlock, MachineBlock];
    edge(entry, then);
    edge(entry, join);
    edge(then, join);

    expect(placeLoopHeadersAfterBodies(fn)).toBe(0);
    expect(order(fn)).toEqual(["entry", "then", "join"]);
  });
});
