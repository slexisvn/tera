import { describe, it, expect, beforeEach } from "vitest";
import {
  hoistLoopInvariants,
  findLoops,
} from "../../src/optimizing/passes/loop-opts.js";
import {
  CFGFunction,
  irConstant,
  irCheckSmi,
  irCheckMap,
  irLoadField,
  irStoreField,
  irInt32Add,
  irInt32Compare,
  irReturn,
  irJump,
  irBranch,
  IR_CHECK_SMI,
  IR_CHECK_MAP,
  IR_LOAD_FIELD,
  IR_CONSTANT,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

function makeSimpleLoop() {
  const graph = new CFGFunction("test");
  const preHeader = graph.addBlock();
  const header = graph.addBlock();
  const body = graph.addBlock();
  const exit = graph.addBlock();

  header.isLoopHeader = true;
  preHeader.addSuccessor(header);
  preHeader.addNode(irJump(header));
  header.addSuccessor(body);
  header.addSuccessor(exit);
  body.addSuccessor(header);
  body.addNode(irJump(header));

  return { graph, preHeader, header, body, exit };
}

describe("findLoops", () => {
  it("identifies loop with header marked isLoopHeader", () => {
    const { graph, header, body } = makeSimpleLoop();
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, header.successors[1]));
    const loops = findLoops(graph);
    expect(loops).toHaveLength(1);
    expect(loops[0].header).toBe(header);
    expect(loops[0].blocks).toContain(header);
  });

  it("returns empty for graph without loops", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    b1.addNode(irReturn(irConstant(0)));
    const loops = findLoops(graph);
    expect(loops).toHaveLength(0);
  });

  it("loop body includes back-edge predecessor", () => {
    const { graph, header, body } = makeSimpleLoop();
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, header.successors[1]));
    const loops = findLoops(graph);
    expect(loops[0].blocks).toContain(body);
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
    hoistLoopInvariants(graph, findLoops);
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
    hoistLoopInvariants(graph, findLoops);
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
    hoistLoopInvariants(graph, findLoops);
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
    hoistLoopInvariants(graph, findLoops);
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
    hoistLoopInvariants(graph, findLoops);
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
    hoistLoopInvariants(graph, findLoops);
    expect(preHeader.nodes.some(n => n.type === IR_CHECK_SMI)).toBe(true);
    expect(preHeader.nodes.some(n => n.type === IR_CONSTANT && n.props.value === 1)).toBe(true);
  });
});
