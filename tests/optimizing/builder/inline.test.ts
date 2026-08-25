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
import { compilerOptions, type OptLevel } from "../../../src/optimizing/options.js";
import { buildIR } from "../../../src/optimizing/builder/ir-builder.js";

const HOT_ENOUGH = 32;

const callee = (name: string): RegisterCompiledFunction => {
  const fn = new RegisterCompiledFunction(name, 0);
  fn.constants.push(1);
  fn.instructions.push(new RegisterInstruction(ROP_LDA_CONST, 0));
  fn.instructions.push(new RegisterInstruction(ROP_RETURN));
  fn.feedbackVector = new FeedbackVector(1);
  return fn;
};

const callerGraph = (adjust: (graph: IRGraph) => void = () => undefined): IRGraph => {
  const graph = new IRGraph("caller");
  graph.inlineBudgetRemaining = HOT_ENOUGH;
  adjust(graph);
  return graph;
};

const decideAt = (
  target: RegisterCompiledFunction,
  graph: IRGraph,
  frequency = HOT_ENOUGH,
) =>
  selectInlineTarget(
    {
      slot: {} as FeedbackSlot,
      kind: FEEDBACK_HINT_MONOMORPHIC,
      frequency,
      targetRef: target,
    },
    new RegisterCompiledFunction("caller", 1),
    0,
    graph,
  );

const decide = (target: RegisterCompiledFunction) => decideAt(target, callerGraph());

const grow = (fn: RegisterCompiledFunction, instructions: number): RegisterCompiledFunction => {
  while (fn.instructions.length < instructions) {
    fn.instructions.splice(
      fn.instructions.length - 1,
      0,
      new RegisterInstruction(ROP_LDA_CONST, 0),
    );
  }
  return fn;
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

describe("the graph-builder inliner obeys the inlining policy of its compiler options", () => {
  const DECLINED = { target: null, targets: null, reason: "cannot-inline" };

  it("declines a callee larger than the policy allows and accepts one at the limit", () => {
    const policy = compilerOptions("baseline").graphInlining;
    const graph = callerGraph((g) => {
      g.inlining = policy;
      g.inlineBudgetRemaining = policy.budget;
    });
    const atLimit = grow(callee("atLimit"), policy.maxCalleeSize);
    const overLimit = grow(callee("overLimit"), policy.maxCalleeSize + 1);
    expect(decideAt(atLimit, graph)).toEqual({ target: atLimit, targets: null, reason: "inlined" });
    expect(decideAt(overLimit, graph)).toEqual(DECLINED);
  });

  it("declines once inlining has reached the policy depth limit", () => {
    const policy = compilerOptions("speed").graphInlining;
    const target = callee("nested");
    const shallow = callerGraph((g) => {
      g.inlining = policy;
      g.inlineDepth = policy.maxDepth - 1;
    });
    const exhausted = callerGraph((g) => {
      g.inlining = policy;
      g.inlineDepth = policy.maxDepth;
    });
    expect(decideAt(target, shallow)).toEqual({ target, targets: null, reason: "inlined" });
    expect(decideAt(target, exhausted)).toEqual(DECLINED);
  });

  it("declines a call site colder than the policy frequency", () => {
    const policy = compilerOptions("max").graphInlining;
    const graph = callerGraph((g) => {
      g.inlining = policy;
    });
    const target = callee("cold");
    expect(decideAt(target, graph, policy.minCallFrequency)).toEqual({
      target,
      targets: null,
      reason: "inlined",
    });
    expect(decideAt(target, graph, policy.minCallFrequency - 1)).toEqual({
      target: null,
      targets: null,
      reason: "cold-call-site",
    });
  });

  it("inlines nothing at all when optimization is off", () => {
    const policy = compilerOptions("none").graphInlining;
    const graph = callerGraph((g) => {
      g.inlining = policy;
      g.inlineBudgetRemaining = policy.budget;
    });
    expect(decideAt(callee("anything"), graph)).toEqual(DECLINED);
  });
});

describe("the inlining policy a built graph carries", () => {
  const built = (level: OptLevel): IRGraph => {
    const host = new RegisterCompiledFunction("host", 0);
    host.instructions.push(new RegisterInstruction(ROP_RETURN));
    const graph = new IRGraph("host");
    buildIR(graph, graph.addBlock(), host, null, [], undefined, compilerOptions(level));
    return graph;
  };

  it("comes from the compiler options the graph was built with", () => {
    const target = grow(callee("midSized"), 100);
    expect(decideAt(target, built("baseline"))).toEqual({
      target: null,
      targets: null,
      reason: "cannot-inline",
    });
    expect(decideAt(target, built("speed"))).toEqual({
      target,
      targets: null,
      reason: "inlined",
    });
  });
});
