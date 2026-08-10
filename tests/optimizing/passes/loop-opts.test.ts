import { describe, it, expect, beforeEach } from "vitest";
import {
  hoistLoopInvariants,
} from "../../../src/optimizing/passes/loop-opts.js";
import { DominatorTree } from "../../../src/optimizing/analyses/dominance.js";
import { LoopForest } from "../../../src/optimizing/analyses/loops.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  modRefAnalysisId,
  pointsToAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  CFGFunction,
  irConstant,
  irCheckSmi,
  irCheckMap,
  irLoadField,
  irStoreField,
  irStoreGlobal,
  irLoadGlobal,
  irGenericGetProp,
  irCallBuiltin,
  irInt32Add,
  irInt32Compare,
  irReturn,
  irJump,
  irBranch,
  IR_CHECK_SMI,
  IR_CHECK_MAP,
  IR_LOAD_FIELD,
  IR_LOAD_GLOBAL,
  IR_CALL_BUILTIN,
  IR_CONSTANT,
  EFFECT_READ,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";

beforeEach(() => resetIRNodeIds());

function makeSimpleLoop() {
  const graph = new CFGFunction("test");
  const preHeader = graph.addBlock();
  const header = graph.addBlock();
  const body = graph.addBlock();
  const exit = graph.addBlock();

  link(preHeader, header);
  preHeader.addNode(irJump(header));
  link(header, body);
  link(header, exit);
  link(body, header);
  body.addNode(irJump(header));

  return { graph, preHeader, header, body, exit };
}

function loopForest(graph: CFGFunction): LoopForest {
  return new LoopForest(graph, new DominatorTree(graph));
}

function hoist(graph: CFGFunction): number {
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return hoistLoopInvariants(
    graph,
    loopForest(graph),
    analyses.get(pointsToAnalysisId),
    analyses.get(modRefAnalysisId),
  );
}

describe("LoopForest", () => {
  it("identifies loop from a dominating back edge", () => {
    const { graph, header, body } = makeSimpleLoop();
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, header.successors[1]));
    const forest = loopForest(graph);
    const loops = [...forest.loops()];
    expect(loops).toHaveLength(1);
    expect(loops[0].header).toBe(header);
    expect(loops[0].blocks.has(header)).toBe(true);
  });

  it("returns empty for graph without loops", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    link(b0, b1);
    b0.addNode(irJump(b1));
    b1.addNode(irReturn(irConstant(0)));
    const loops = [...loopForest(graph).loops()];
    expect(loops).toHaveLength(0);
  });

  it("loop body includes back-edge predecessor", () => {
    const { graph, header, body } = makeSimpleLoop();
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, header.successors[1]));
    const loops = [...loopForest(graph).loops()];
    expect(loops[0].blocks.has(body)).toBe(true);
  });
});

describe("hoistLoopInvariants", () => {
  it("hoists CheckSmi with loop-external input to pre-header", () => {
    const { graph, preHeader, header, body, exit } = makeSimpleLoop();
    const param = graph.addParameter(0);
    const check = irCheckSmi(param);
    body.nodes.splice(0, 0, check);
    check.block = body;
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    exit.addNode(irReturn(irConstant(0)));
    hoist(graph);
    const preHeaderTypes = preHeader.nodes.map(n => n.type);
    expect(preHeaderTypes).toContain(IR_CHECK_SMI);
    expect(body.nodes.every(n => n.type !== IR_CHECK_SMI)).toBe(true);
  });

  it("hoists Constant from loop body", () => {
    const { graph, preHeader, header, body, exit } = makeSimpleLoop();
    const c = irConstant(42);
    body.nodes.splice(0, 0, c);
    c.block = body;
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    exit.addNode(irReturn(irConstant(0)));
    hoist(graph);
    expect(preHeader.nodes.some(n => n.type === IR_CONSTANT && n.props.value === 42)).toBe(true);
  });

  it("does NOT hoist node with frameState", () => {
    const { graph, preHeader, header, body, exit } = makeSimpleLoop();
    const param = graph.addParameter(0);
    const check = irCheckSmi(param);
    check.frameState = { id: 0 };
    body.nodes.splice(0, 0, check);
    check.block = body;
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    exit.addNode(irReturn(irConstant(0)));
    hoist(graph);
    expect(body.nodes).toContain(check);
  });

  it("does NOT hoist LoadField that aliases a store in loop", () => {
    const { graph, preHeader, header, body, exit } = makeSimpleLoop();
    const param = graph.addParameter(0);
    const load = irLoadField(param, 0);
    body.nodes.splice(0, 0, load);
    load.block = body;
    const store = irStoreField(param, 0, irConstant(1));
    body.nodes.splice(1, 0, store);
    store.block = body;
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    exit.addNode(irReturn(irConstant(0)));
    hoist(graph);
    expect(body.nodes).toContain(load);
  });

  it("hoists LoadField with no aliasing store in loop body", () => {
    const { graph, preHeader, header, body, exit } = makeSimpleLoop();
    const param = graph.addParameter(0);
    const load = irLoadField(param, 0);
    body.nodes.splice(0, 0, load);
    load.block = body;
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    exit.addNode(irReturn(irConstant(0)));
    hoist(graph);
    expect(preHeader.nodes.some(n => n.type === IR_LOAD_FIELD)).toBe(true);
    expect(body.nodes.every(n => n.type !== IR_LOAD_FIELD)).toBe(true);
  });

  it("hoists chain of invariant nodes via worklist", () => {
    const { graph, preHeader, header, body, exit } = makeSimpleLoop();
    const param = graph.addParameter(0);
    const check = irCheckSmi(param);
    body.nodes.splice(0, 0, check);
    check.block = body;
    const c = irConstant(1);
    body.nodes.splice(1, 0, c);
    c.block = body;
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    exit.addNode(irReturn(irConstant(0)));
    hoist(graph);
    expect(preHeader.nodes.some(n => n.type === IR_CHECK_SMI)).toBe(true);
    expect(preHeader.nodes.some(n => n.type === IR_CONSTANT && n.props.value === 1)).toBe(true);
  });
});

describe("hoistLoopInvariants speculation and memory dependence", () => {
  function loopWith(build: (blocks: ReturnType<typeof makeSimpleLoop>) => void) {
    const blocks = makeSimpleLoop();
    const { graph, header, body, exit } = blocks;
    build(blocks);
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    exit.addNode(irReturn(irConstant(0)));
    hoist(graph);
    return blocks;
  }

  function intoBody(body: CFGFunction["blocks"][number], node: ReturnType<typeof irConstant>) {
    body.nodes.splice(body.nodes.length - 1, 0, node);
    node.block = body;
    return node;
  }

  const pureCall = (receiver: ReturnType<typeof irConstant>) =>
    irCallBuiltin("string.length", [receiver], {
      effectKind: EFFECT_READ,
      pure: true,
    });

  it("hoists a pure builtin call whose operands come from outside the loop", () => {
    const { preHeader, body } = loopWith(({ graph, body }) => {
      intoBody(body, pureCall(graph.addParameter(0)));
    });

    expect(preHeader.nodes.some((n) => n.type === IR_CALL_BUILTIN)).toBe(true);
    expect(body.nodes.every((n) => n.type !== IR_CALL_BUILTIN)).toBe(true);
  });

  it("keeps a builtin call that is not declared pure inside the loop", () => {
    const { body } = loopWith(({ graph, body }) => {
      intoBody(body, irCallBuiltin("owner.effectful", [graph.addParameter(0)]));
    });

    expect(body.nodes.some((n) => n.type === IR_CALL_BUILTIN)).toBe(true);
  });

  it("still hoists a pure call when the loop clobbers all memory", () => {
    const { preHeader } = loopWith(({ graph, body }) => {
      const param = graph.addParameter(0);
      intoBody(body, irGenericGetProp(param, "anything"));
      intoBody(body, pureCall(param));
    });

    expect(preHeader.nodes.some((n) => n.type === IR_CALL_BUILTIN)).toBe(true);
  });

  it("keeps a field load inside a loop that clobbers all memory", () => {
    const { body } = loopWith(({ graph, body }) => {
      const param = graph.addParameter(0);
      intoBody(body, irLoadField(param, 0));
      intoBody(body, irGenericGetProp(param, "anything"));
    });

    expect(body.nodes.some((n) => n.type === IR_LOAD_FIELD)).toBe(true);
  });

  it("hoists a field load when the loop only writes a different slot", () => {
    const { preHeader } = loopWith(({ graph, body }) => {
      const param = graph.addParameter(0);
      intoBody(body, irLoadField(param, 0));
      intoBody(body, irStoreField(param, 8, irConstant(1)));
    });

    expect(preHeader.nodes.some((n) => n.type === IR_LOAD_FIELD)).toBe(true);
  });

  it("keeps a global load that the loop overwrites", () => {
    const { body } = loopWith(({ body }) => {
      intoBody(body, irLoadGlobal("counter"));
      intoBody(body, irStoreGlobal("counter", irConstant(1)));
    });

    expect(body.nodes.some((n) => n.type === IR_LOAD_GLOBAL)).toBe(true);
  });

  it("hoists a global load when the loop writes a different global", () => {
    const { preHeader } = loopWith(({ body }) => {
      intoBody(body, irLoadGlobal("counter"));
      intoBody(body, irStoreGlobal("other", irConstant(1)));
    });

    expect(preHeader.nodes.some((n) => n.type === IR_LOAD_GLOBAL)).toBe(true);
  });

  it("never hoists a store out of the loop", () => {
    const { body } = loopWith(({ graph, body }) => {
      intoBody(body, irStoreField(graph.addParameter(0), 0, irConstant(1)));
    });

    expect(body.nodes.some((n) => n.type === "StoreField")).toBe(true);
  });
});
