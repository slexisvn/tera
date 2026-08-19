import { describe, expect, it } from "vitest";
import {
  RegisterCompiledFunction,
  RegisterInstruction,
  ROP_LDA_CONST,
  ROP_RETURN,
} from "../../../src/bytecode/register/ops/bytecode.js";
import { FeedbackVector, type FeedbackSlot } from "../../../src/feedback/vector/index.js";
import { FEEDBACK_HINT_MONOMORPHIC } from "../../../src/feedback/nexus/index.js";
import { selectInlineTarget } from "../../../src/optimizing/builder/inline.js";
import { IRGraph } from "../../../src/optimizing/ir/index.js";

const HOT_ENOUGH = 32;

const callee = (name: string): RegisterCompiledFunction => {
  const fn = new RegisterCompiledFunction(name, 0);
  fn.constants.push(1);
  fn.instructions.push(new RegisterInstruction(ROP_LDA_CONST, 0));
  fn.instructions.push(new RegisterInstruction(ROP_RETURN));
  fn.feedbackVector = new FeedbackVector(1);
  return fn;
};

const decide = (target: RegisterCompiledFunction) => {
  const graph = new IRGraph("caller");
  graph.inlineBudgetRemaining = HOT_ENOUGH;
  return selectInlineTarget(
    {
      slot: {} as FeedbackSlot,
      kind: FEEDBACK_HINT_MONOMORPHIC,
      frequency: HOT_ENOUGH,
      targetRef: target,
    },
    new RegisterCompiledFunction("caller", 1),
    0,
    graph,
  );
};

describe("selecting an inline target for a hot monomorphic call site", () => {
  it("inlines a plain callee", () => {
    const target = callee("plain");
    expect(decide(target)).toEqual({ target, targets: null, reason: "inlined" });
  });

  it("declines an async callee whose call builds a promise", () => {
    const target = callee("asyncCallee");
    target.isAsync = true;
    expect(decide(target)).toEqual({ target: null, targets: null, reason: "cannot-inline" });
  });

  it("declines a generator callee whose call builds an iterator", () => {
    const target = callee("generatorCallee");
    target.isGenerator = true;
    expect(decide(target)).toEqual({ target: null, targets: null, reason: "cannot-inline" });
  });

  it("declines a generator callee whose body only returns", () => {
    const target = callee("emptyGenerator");
    target.isGenerator = true;
    expect(target.instructions.map((instr) => instr.opcode)).toEqual([ROP_LDA_CONST, ROP_RETURN]);
    expect(decide(target)).toEqual({ target: null, targets: null, reason: "cannot-inline" });
  });
});
