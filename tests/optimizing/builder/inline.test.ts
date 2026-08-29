import { describe, expect, it } from "vitest";
import {
  RegisterCompiledFunction,
  RegisterInstruction,
  ROP_LDA_CONST,
  ROP_RETURN,
  ROP_CALL,
  ROP_STAR,
} from "../../../src/bytecode/register/ops/bytecode.js";
import {
  FEEDBACK_CALL,
  FeedbackVector,
  type FeedbackSlot,
} from "../../../src/feedback/vector/index.js";
import { FEEDBACK_HINT_MONOMORPHIC } from "../../../src/feedback/nexus/index.js";
import { selectInlineTarget } from "../../../src/optimizing/builder/inline.js";
import {
  IRGraph,
  IR_CHECK_CALL_TARGET,
  IR_CHECK_SMI,
} from "../../../src/optimizing/ir/index.js";
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
  slot: FeedbackSlot = {} as FeedbackSlot,
) =>
  selectInlineTarget(
    {
      slot,
      kind: FEEDBACK_HINT_MONOMORPHIC,
      frequency,
      targetRef: target,
    },
    new RegisterCompiledFunction("caller", 1),
    0,
    graph,
  );

const siteAnswering = (...tags: string[]): FeedbackSlot => {
  const vector = new FeedbackVector(1);
  vector.initSlot(0, FEEDBACK_CALL);
  const slot = vector.getSlot(0)!;
  for (const tag of tags) slot.recordReturnType(tag);
  return slot;
};

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

describe("inlining a callee whose declared int return must still wrap", () => {
  const declaring = (returns: string): RegisterCompiledFunction => {
    const fn = callee(`answers-${returns}`);
    fn.declaredSignature = { params: [], returns };
    return fn;
  };

  it("inlines a declared int callee only where the site answered small ints", () => {
    expect(decideAt(declaring("int"), callerGraph(), HOT_ENOUGH, siteAnswering("smi"))).toMatchObject(
      { reason: "inlined" },
    );
    expect(
      decideAt(declaring("int"), callerGraph(), HOT_ENOUGH, siteAnswering("smi", "double")),
    ).toEqual({ target: null, targets: null, reason: "cannot-inline" });
  });

  it("declines a declared int callee at a site with no return history to speculate on", () => {
    expect(decideAt(declaring("int"), callerGraph(), HOT_ENOUGH, siteAnswering())).toEqual({
      target: null,
      targets: null,
      reason: "cannot-inline",
    });
  });

  it("leaves a callee with any other declared return to the ordinary policy", () => {
    for (const returns of ["float", "string"]) {
      expect(
        decideAt(declaring(returns), callerGraph(), HOT_ENOUGH, siteAnswering("double")),
      ).toMatchObject({ reason: "inlined" });
    }
  });
});

describe("the guard that keeps an inlined declared int return sound", () => {
  const HOT_SITE = compilerOptions("speed").graphInlining.minCallFrequency + 1;

  const inlinedInto = (returns: string | null, ...answers: string[]): IRGraph => {
    const target = callee("scaled");
    target.declaredSignature = returns === null ? null : { params: [], returns };

    const host = new RegisterCompiledFunction("host", 0);
    host.constants.push(0);
    host.instructions.push(
      new RegisterInstruction(ROP_LDA_CONST, 0),
      new RegisterInstruction(ROP_STAR, 0),
      new RegisterInstruction(ROP_CALL, 0, 1, 0, 0),
      new RegisterInstruction(ROP_RETURN),
    );
    host.feedbackVector = new FeedbackVector(1);
    host.feedbackVector.initSlot(0, FEEDBACK_CALL);
    const slot = host.feedbackVector.getSlot(0)!;
    for (let i = 0; i < HOT_SITE; i++) slot.recordCallTarget(target.name, target, 0);
    for (const tag of answers) slot.recordReturnType(tag);

    const graph = new IRGraph("host");
    buildIR(graph, graph.addBlock(), host, host.feedbackVector, []);
    return graph;
  };

  const nodesOfType = (graph: IRGraph, type: string) =>
    graph.blocks.flatMap((block) => block.nodes.filter((node) => node.type === type));

  const shapeOf = (graph: IRGraph) => ({
    spliced: nodesOfType(graph, IR_CHECK_CALL_TARGET).length > 0,
    guards: nodesOfType(graph, IR_CHECK_SMI).length,
  });

  it("guards the spliced return of a declared int callee", () => {
    const graph = inlinedInto("int", "smi");
    expect(shapeOf(graph)).toEqual({ spliced: true, guards: 1 });
    expect(nodesOfType(graph, IR_CHECK_SMI)[0]!.frameState).not.toBeNull();
  });

  it("splices a callee that declares no int return without guarding it", () => {
    expect(shapeOf(inlinedInto(null, "smi"))).toEqual({ spliced: true, guards: 0 });
    expect(shapeOf(inlinedInto("float", "smi"))).toEqual({ spliced: true, guards: 0 });
  });

  it("splices no body at all where the site has answered more than small ints", () => {
    expect(shapeOf(inlinedInto("int", "smi", "double"))).toEqual({
      spliced: false,
      guards: 0,
    });
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
