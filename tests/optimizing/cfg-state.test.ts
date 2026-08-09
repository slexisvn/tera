import { describe, expect, it } from "vitest";
import {
  CFGFunction,
  IR_CONSTANT,
  IR_PHI,
  homeInstruction,
  irConstant,
} from "../../src/optimizing/ir/index.js";
import { link } from "../../src/optimizing/ir/cfg-edit.js";
import {
  rememberIncomingState,
  restoreIncomingState,
  type IncomingStatesByTarget,
} from "../../src/optimizing/builder/cfg-state.js";

describe("restoreIncomingState", () => {
  it("creates phis for multi-predecessor blocks even with one saved incoming state", () => {
    const graph = new CFGFunction("merge");
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();
    link(left, merge);
    link(right, merge);

    const leftValue = homeInstruction(irConstant(1), left);
    const rightValue = homeInstruction(irConstant(2), right);
    const states: IncomingStatesByTarget = new Map();
    const savedRegs = new Map([[0, leftValue]]);
    rememberIncomingState(states, 10, left, savedRegs, leftValue);

    const regs = new Map([[0, rightValue]]);
    const acc = restoreIncomingState(merge, states.get(10), regs, rightValue);
    const regPhi = regs.get(0);

    expect(regPhi?.type).toBe(IR_PHI);
    expect(regPhi?.inputs).toEqual([leftValue, rightValue]);
    expect(acc?.type).toBe(IR_PHI);
    expect(acc?.inputs).toEqual([leftValue, rightValue]);
    expect(merge.nodes.filter((node) => node.type === IR_PHI)).toHaveLength(2);
    expect(merge.nodes.every((node) => node.type === IR_PHI || node.type === IR_CONSTANT)).toBe(true);
  });

  it("creates a phi for a register first defined on the current predecessor", () => {
    const graph = new CFGFunction("current-only-reg");
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();
    link(left, merge);
    link(right, merge);

    const rightValue = homeInstruction(irConstant(7), right);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 20, left, new Map(), null);

    const regs = new Map([[3, rightValue]]);
    restoreIncomingState(merge, states.get(20), regs, null);

    const regPhi = regs.get(3);
    expect(regPhi?.type).toBe(IR_PHI);
    expect(regPhi?.inputs[0]?.type).toBe(IR_CONSTANT);
    expect(regPhi?.inputs[0]?.props.value).toBeUndefined();
    expect(regPhi?.inputs[1]).toBe(rightValue);
  });

  it("creates an accumulator phi when only the current predecessor has an accumulator", () => {
    const graph = new CFGFunction("current-only-acc");
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();
    link(left, merge);
    link(right, merge);

    const rightValue = homeInstruction(irConstant(9), right);
    const states: IncomingStatesByTarget = new Map();
    rememberIncomingState(states, 30, left, new Map(), null);

    const acc = restoreIncomingState(merge, states.get(30), new Map(), rightValue);

    expect(acc?.type).toBe(IR_PHI);
    expect(acc?.inputs[0]?.type).toBe(IR_CONSTANT);
    expect(acc?.inputs[0]?.props.value).toBeUndefined();
    expect(acc?.inputs[1]).toBe(rightValue);
  });
});
