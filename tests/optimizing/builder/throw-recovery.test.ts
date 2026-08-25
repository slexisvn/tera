import { describe, it, expect } from "vitest";
import * as ops from "../../../src/bytecode/register/ops/bytecode.js";
import { RegisterInstruction } from "../../../src/bytecode/register/ops/bytecode.js";
import {
  CFGFunction,
  IR_BRANCH,
  IR_RETURN,
  irConstant,
} from "../../../src/optimizing/ir/index.js";
import {
  branchOnPendingThrow,
  carriesPendingThrow,
  clearPendingThrowReturn,
  forwardsPendingThrow,
  handlerStacksOf,
  isPendingThrowReturn,
  isThrownValue,
  markThrownValue,
  raisesPendingThrow,
  recordPendingThrow,
  recoverAfterCall,
  returnPendingThrow,
  takePendingThrow,
  takesPendingThrow,
} from "../../../src/optimizing/builder/throw-recovery.js";

const instruction = (opcode: number, ...operands: number[]) =>
  new RegisterInstruction(opcode, ...operands);

const stacksOf = (...instructions: RegisterInstruction[]) =>
  handlerStacksOf(instructions).map((stack) => [...stack]);

function graphWithBlock(): { graph: CFGFunction; block: CFGFunction["blocks"][number] } {
  const graph = new CFGFunction("test");
  return { graph, block: graph.addBlock() };
}

describe("handlerStacksOf", () => {
  it("leaves every instruction outside a try with an empty handler stack", () => {
    expect(
      stacksOf(
        instruction(ops.ROP_LDA_CONST, 0),
        instruction(ops.ROP_STAR, 0),
        instruction(ops.ROP_RETURN),
      ),
    ).toEqual([[], [], []]);
  });

  it("covers the body between a try and its end with the handler it declares", () => {
    expect(
      stacksOf(
        instruction(ops.ROP_TRY_START, 3),
        instruction(ops.ROP_LDA_CONST, 0),
        instruction(ops.ROP_TRY_END),
        instruction(ops.ROP_LDA_CONST, 1),
        instruction(ops.ROP_RETURN),
      ),
    ).toEqual([[], [3], [3], [], []]);
  });

  it("leaves the handler itself outside the try it handles", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 4),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_JUMP, 5),
      instruction(ops.ROP_LDA_CONST, 1),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[4]).toEqual([]);
  });

  it("nests an inner handler on top of the one already covering the body", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 6),
      instruction(ops.ROP_TRY_START, 5),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_LDA_CONST, 1),
      instruction(ops.ROP_LDA_CONST, 2),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[2]).toEqual([6, 5]);
    expect(stacks[4]).toEqual([6]);
  });

  it("pops the inner handler back off at its end", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 7),
      instruction(ops.ROP_TRY_START, 4),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_LDA_CONST, 1),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_RETURN),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[3]).toEqual([7]);
  });

  it("carries the handler across a jump out of the middle of the body", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 5),
      instruction(ops.ROP_JUMP, 3),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_LDA_CONST, 1),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[3]).toEqual([5]);
    expect(stacks[2]).toEqual([]);
  });

  it("covers both arms of a branch taken inside the body", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 5),
      instruction(ops.ROP_JUMP_IF_FALSE, 3),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_LDA_CONST, 1),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[2]).toEqual([5]);
    expect(stacks[3]).toEqual([5]);
  });

  it("stops at a return, leaving what only follows it unreached", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 4),
      instruction(ops.ROP_RETURN),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[1]).toEqual([4]);
    expect(stacks[2]).toEqual([]);
  });

  it("stops at a throw the same way it stops at a return", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 4),
      instruction(ops.ROP_THROW),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[1]).toEqual([4]);
    expect(stacks[2]).toEqual([]);
  });

  it("keeps the handler over a loop that runs inside the body", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 5),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_JUMP_IF_TRUE, 1),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_RETURN),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[1]).toEqual([5]);
    expect(stacks[2]).toEqual([5]);
    expect(stacks[4]).toEqual([]);
  });

  it("answers an empty stack for an instruction no path reaches", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_JUMP, 2),
      instruction(ops.ROP_LDA_CONST, 0),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[1]).toEqual([]);
    expect(stacks).toHaveLength(3);
  });

  it("treats an opcode with no modelled control flow as falling through", () => {
    const stacks = stacksOf(
      instruction(ops.ROP_TRY_START, 3),
      instruction(0xfe, 0),
      instruction(ops.ROP_TRY_END),
      instruction(ops.ROP_RETURN),
    );

    expect(stacks[1]).toEqual([3]);
    expect(stacks[2]).toEqual([3]);
  });
});

describe("the pending-throw cell a recovered call writes through", () => {
  it("marks the flag store as the one that raises, and the value store as the one that carries", () => {
    const { block } = graphWithBlock();
    const thrown = irConstant("boom");
    block.addNode(thrown);

    recordPendingThrow(block, thrown);

    const raising = block.nodes.filter(raisesPendingThrow);
    const forwarding = block.nodes.filter(forwardsPendingThrow);
    expect(raising).toHaveLength(1);
    expect(forwarding).toHaveLength(1);
    expect(raising[0]).not.toBe(forwarding[0]);
    expect(carriesPendingThrow(forwarding[0]!)).toBe(true);
  });

  it("hands back the loaded value when the handler takes the throw, and clears the flag", () => {
    const { block } = graphWithBlock();

    const taken = takePendingThrow(block);

    expect(takesPendingThrow(taken)).toBe(true);
    expect(carriesPendingThrow(taken)).toBe(true);
    expect(block.nodes).toContain(taken);
    expect(block.nodes.filter(raisesPendingThrow)).toHaveLength(0);
  });

  it("keeps a thrown value distinguishable from an ordinary one", () => {
    const value = irConstant(1);

    expect(isThrownValue(value)).toBe(false);
    markThrownValue(value);
    expect(isThrownValue(value)).toBe(true);
  });

  it("returns a marked status node the backend can tell from a real return", () => {
    const { block } = graphWithBlock();

    returnPendingThrow(block);

    const returns = block.nodes.filter((node) => node.type === IR_RETURN);
    expect(returns).toHaveLength(1);
    expect(isPendingThrowReturn(returns[0]!)).toBe(true);
    clearPendingThrowReturn(returns[0]!);
    expect(isPendingThrowReturn(returns[0]!)).toBe(false);
  });

  it("splits the block into a taken and a resumed half, both linked from it", () => {
    const { graph, block } = graphWithBlock();

    const { taken, resumed } = branchOnPendingThrow(graph, block);

    expect(block.nodes.at(-1)!.type).toBe(IR_BRANCH);
    expect(block.successors).toContain(taken);
    expect(block.successors).toContain(resumed);
    expect(taken).not.toBe(resumed);
  });
});

describe("recoverAfterCall", () => {
  it("returns the pending throw when the call sits under no handler", () => {
    const { graph, block } = graphWithBlock();

    const resumed = recoverAfterCall(graph, block, null, new Map(), new Map());

    const taken = block.successors.find((successor) => successor !== resumed)!;
    expect(taken.nodes.some(isPendingThrowReturn)).toBe(true);
    expect(resumed.nodes).toHaveLength(0);
  });

  it("jumps to the handler and remembers the thrown value for it when one is in scope", () => {
    const { graph, block } = graphWithBlock();
    const handler = graph.addBlock();
    const savedBlockRegs = new Map();

    const resumed = recoverAfterCall(
      graph,
      block,
      { handler, target: 7 },
      new Map(),
      savedBlockRegs,
    );

    const taken = block.successors.find((successor) => successor !== resumed)!;
    expect(taken.successors).toContain(handler);
    expect(taken.nodes.some(takesPendingThrow)).toBe(true);
    expect(savedBlockRegs.get(7)).toHaveLength(1);
    expect(savedBlockRegs.get(7)![0].predecessor).toBe(taken);
  });

  it("carries the register state of the call site into the handler's incoming state", () => {
    const { graph, block } = graphWithBlock();
    const handler = graph.addBlock();
    const live = irConstant(5);
    const regs = new Map([[2, live]]);
    const savedBlockRegs = new Map();

    recoverAfterCall(graph, block, { handler, target: 1 }, regs, savedBlockRegs);

    expect(savedBlockRegs.get(1)![0].regs.get(2)).toBe(live);
  });
});
