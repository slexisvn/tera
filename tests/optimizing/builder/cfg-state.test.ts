import { describe, expect, it } from "vitest";
import {
  CFGFunction,
  IR_CONSTANT,
  IR_PHI,
  homeInstruction,
  irConstant,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import {
  mergeIncomingState,
  openLoopHeader,
  rememberIncomingState,
  type IncomingStatesByTarget,
} from "../../../src/optimizing/builder/cfg-state.js";

function diamond(name: string) {
  const graph = new CFGFunction(name);
  const left = graph.addBlock();
  const right = graph.addBlock();
  const merge = graph.addBlock();
  link(left, merge);
  link(right, merge);
  return { graph, left, right, merge };
}

describe("mergeIncomingState", () => {
  it("creates phis for registers that differ across predecessors", () => {
    const { left, right, merge } = diamond("merge");
    const leftValue = homeInstruction(irConstant(1), left);
    const rightValue = homeInstruction(irConstant(2), right);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 10, left, new Map([[0, leftValue]]), leftValue);
    rememberIncomingState(states, 10, right, new Map([[0, rightValue]]), rightValue);

    const regs = new Map();
    const acc = mergeIncomingState(merge, states.get(10)!, regs, null);
    const regPhi = regs.get(0);

    expect(regPhi?.type).toBe(IR_PHI);
    expect(regPhi?.inputs).toEqual([leftValue, rightValue]);
    expect(acc?.type).toBe(IR_PHI);
    expect(acc?.inputs).toEqual([leftValue, rightValue]);
    expect(merge.nodes.filter((node) => node.type === IR_PHI)).toHaveLength(2);
  });

  it("keeps a single value when every predecessor agrees", () => {
    const { graph, left, right, merge } = diamond("uniform");
    const entry = graph.addBlock();
    const value = homeInstruction(irConstant(5), entry);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 10, left, new Map([[0, value]]), null);
    rememberIncomingState(states, 10, right, new Map([[0, value]]), null);

    const regs = new Map();
    mergeIncomingState(merge, states.get(10)!, regs, null);

    expect(regs.get(0)).toBe(value);
    expect(merge.nodes.filter((node) => node.type === IR_PHI)).toHaveLength(0);
  });

  it("fills undefined for a register missing from one predecessor", () => {
    const { left, right, merge } = diamond("partial-reg");
    const rightValue = homeInstruction(irConstant(7), right);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 20, left, new Map(), null);
    rememberIncomingState(states, 20, right, new Map([[3, rightValue]]), null);

    const regs = new Map();
    mergeIncomingState(merge, states.get(20)!, regs, null);

    const regPhi = regs.get(3);
    expect(regPhi?.type).toBe(IR_PHI);
    expect(regPhi?.inputs[0]?.type).toBe(IR_CONSTANT);
    expect(regPhi?.inputs[0]?.props.value).toBeUndefined();
    expect(regPhi?.inputs[1]).toBe(rightValue);
  });

  it("fills undefined for an accumulator missing from one predecessor", () => {
    const { left, right, merge } = diamond("partial-acc");
    const rightValue = homeInstruction(irConstant(9), right);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 30, left, new Map(), null);
    rememberIncomingState(states, 30, right, new Map(), rightValue);

    const acc = mergeIncomingState(merge, states.get(30)!, new Map(), null);

    expect(acc?.type).toBe(IR_PHI);
    expect(acc?.inputs[0]?.type).toBe(IR_CONSTANT);
    expect(acc?.inputs[0]?.props.value).toBeUndefined();
    expect(acc?.inputs[1]).toBe(rightValue);
  });

  it("drops registers that no predecessor defines", () => {
    const { graph, left, right, merge } = diamond("stale");
    const unrelated = graph.addBlock();
    const staleValue = homeInstruction(irConstant(11), unrelated);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 40, left, new Map(), null);
    rememberIncomingState(states, 40, right, new Map(), null);

    const regs = new Map([[2, staleValue]]);
    mergeIncomingState(merge, states.get(40)!, regs, staleValue);

    expect(regs.has(2)).toBe(false);
    expect(merge.nodes.filter((node) => node.type === IR_PHI)).toHaveLength(0);
  });
});

describe("openLoopHeader", () => {
  it("seeds header phis from the recorded entry state, not the walking state", () => {
    const graph = new CFGFunction("loop");
    const entry = graph.addBlock();
    const unrelated = graph.addBlock();
    const header = graph.addBlock();
    header.isLoopHeader = true;
    link(entry, header);

    const entryValue = homeInstruction(irConstant(1), entry);
    const staleValue = homeInstruction(irConstant(2), unrelated);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 50, entry, new Map([[0, entryValue]]), null);

    const regs = new Map([[0, staleValue]]);
    const phis = openLoopHeader(header, states.get(50)!, regs, 1, entry);

    expect(phis.get(0)?.inputs).toEqual([entryValue]);
    expect(regs.get(0)).toBe(phis.get(0));
  });

  it("creates a phi for every local slot", () => {
    const graph = new CFGFunction("loop-locals");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    header.isLoopHeader = true;
    link(entry, header);

    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 60, entry, new Map(), null);

    const phis = openLoopHeader(header, states.get(60)!, new Map(), 3, entry);

    expect([...phis.keys()]).toEqual([0, 1, 2]);
    for (const phi of phis.values()) {
      expect(phi.inputs[0]?.type).toBe(IR_CONSTANT);
      expect(phi.inputs[0]?.props.value).toBeUndefined();
    }
  });
});
