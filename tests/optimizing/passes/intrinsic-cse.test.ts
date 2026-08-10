import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  EFFECT_CALL,
  EFFECT_READ,
  EFFECT_WRITE,
  IR_CALL_INTRINSIC,
  IR_LOAD_GLOBAL,
  IR_RETURN,
  IR_STORE_GLOBAL,
  CFGInstruction,
  irBranch,
  irConstant,
  irJump,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import { commonSubexpressionIntrinsicReads } from "../../../src/optimizing/passes/intrinsic-cse.js";

beforeEach(() => resetIRNodeIds());

function graphWithBlock() {
  const graph = new CFGFunction("intrinsic-cse");
  const block = graph.addBlock();
  return { graph, block };
}

function reactiveRead(input: CFGInstruction): CFGInstruction {
  const node = new CFGInstruction(IR_CALL_INTRINSIC, {
    name: "__read",
    argCount: 1,
    intrinsicEffects: ["reactive-read"],
    effectKind: EFFECT_CALL,
  });
  node.addInput(input);
  return node;
}

function reactiveWrite(input: CFGInstruction): CFGInstruction {
  const node = new CFGInstruction(IR_CALL_INTRINSIC, {
    name: "__write",
    argCount: 1,
    intrinsicEffects: ["reactive-write"],
    effectKind: EFFECT_WRITE,
  });
  node.addInput(input);
  return node;
}

function domainRead(input: CFGInstruction, domain: string): CFGInstruction {
  const node = new CFGInstruction(IR_CALL_INTRINSIC, {
    name: "__domain_read",
    argCount: 1,
    intrinsicEffects: ["reactive-read"],
    intrinsicReads: [domain],
    effectKind: EFFECT_CALL,
  });
  node.addInput(input);
  return node;
}

function domainWrite(input: CFGInstruction, domain: string): CFGInstruction {
  const node = new CFGInstruction(IR_CALL_INTRINSIC, {
    name: "__domain_write",
    argCount: 1,
    intrinsicEffects: ["reactive-write"],
    intrinsicWrites: [domain],
    effectKind: EFFECT_WRITE,
  });
  node.addInput(input);
  return node;
}

function readonlyIntrinsic(input: CFGInstruction): CFGInstruction {
  const node = new CFGInstruction(IR_CALL_INTRINSIC, {
    name: "__peek",
    argCount: 1,
    intrinsicEffects: ["read"],
    effectKind: EFFECT_READ,
    pure: true,
    readonly: true,
  });
  node.addInput(input);
  return node;
}

describe("commonSubexpressionIntrinsicReads", () => {
  it("eliminates duplicate reactive-read intrinsics in the same block", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = reactiveRead(handle);
    const second = reactiveRead(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(1);
    expect(ret.inputs[0]).toBe(first);
    expect(block.nodes).toContain(first);
    expect(block.nodes).not.toContain(second);
  });

  it("does not eliminate reactive reads across write barriers", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = reactiveRead(handle);
    const write = reactiveWrite(handle);
    const second = reactiveRead(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(write);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(ret.inputs[0]).toBe(second);
    expect(block.nodes).toContain(first);
    expect(block.nodes).toContain(second);
  });

  it("eliminates duplicate reactive-read intrinsics in dominated blocks", () => {
    const graph = new CFGFunction("intrinsic-cse");
    const entry = graph.addBlock();
    const child = graph.addBlock();
    link(entry, child);

    const handle = irConstant("signal");
    const first = reactiveRead(handle);
    const second = reactiveRead(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    entry.addNode(handle);
    entry.addNode(first);
    entry.addNode(irJump(child));
    child.addNode(second);
    child.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(1);
    expect(ret.inputs[0]).toBe(first);
    expect(entry.nodes).toContain(first);
    expect(child.nodes).not.toContain(second);
  });

  it("does not eliminate dominated reactive reads after a write barrier", () => {
    const graph = new CFGFunction("intrinsic-cse");
    const entry = graph.addBlock();
    const child = graph.addBlock();
    link(entry, child);

    const handle = irConstant("signal");
    const first = reactiveRead(handle);
    const write = reactiveWrite(handle);
    const second = reactiveRead(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    entry.addNode(handle);
    entry.addNode(first);
    entry.addNode(write);
    entry.addNode(irJump(child));
    child.addNode(second);
    child.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(ret.inputs[0]).toBe(second);
    expect(child.nodes).toContain(second);
  });

  it("does not reuse branch-local reactive reads at a merge block", () => {
    const graph = new CFGFunction("intrinsic-cse");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();
    link(entry, left);
    link(entry, right);
    link(left, merge);
    link(right, merge);

    const handle = irConstant("signal");
    const first = reactiveRead(handle);
    const second = reactiveRead(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    entry.addNode(handle);
    left.addNode(first);
    left.addNode(irJump(merge));
    right.addNode(irJump(merge));
    merge.addNode(second);
    merge.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(ret.inputs[0]).toBe(second);
    expect(left.nodes).toContain(first);
    expect(merge.nodes).toContain(second);
  });

  it("does not reuse entry reactive reads at a merge block reached through a write branch", () => {
    const graph = new CFGFunction("intrinsic-cse");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();
    link(entry, left);
    link(entry, right);
    link(left, merge);
    link(right, merge);

    const handle = irConstant("signal");
    const cond = irConstant(true);
    const first = reactiveRead(handle);
    const write = reactiveWrite(handle);
    const second = reactiveRead(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    entry.addNode(handle);
    entry.addNode(cond);
    entry.addNode(first);
    entry.addNode(irBranch(cond, left, right));
    left.addNode(write);
    left.addNode(irJump(merge));
    right.addNode(irJump(merge));
    merge.addNode(second);
    merge.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(ret.inputs[0]).toBe(second);
    expect(entry.nodes).toContain(first);
    expect(merge.nodes).toContain(second);
  });

  it("canonicalizes repeated global loads feeding the same reactive read", () => {
    const { graph, block } = graphWithBlock();
    const firstGlobal = new CFGInstruction(IR_LOAD_GLOBAL, { name: "count" });
    const secondGlobal = new CFGInstruction(IR_LOAD_GLOBAL, { name: "count" });
    const first = reactiveRead(firstGlobal);
    const second = reactiveRead(secondGlobal);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(firstGlobal);
    block.addNode(first);
    block.addNode(secondGlobal);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(1);
    expect(ret.inputs[0]).toBe(first);
    expect(block.nodes).not.toContain(second);
  });

  it("ignores plain read effects that are not reactive dependency tracking", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = new CFGInstruction(IR_CALL_INTRINSIC, {
      name: "__peek",
      argCount: 1,
      intrinsicEffects: ["read"],
    });
    first.addInput(handle);
    const second = new CFGInstruction(IR_CALL_INTRINSIC, {
      name: "__peek",
      argCount: 1,
      intrinsicEffects: ["read"],
    });
    second.addInput(handle);
    const store = new CFGInstruction(IR_STORE_GLOBAL, { name: "out" });
    store.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(second);
    block.addNode(store);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(store.inputs[0]).toBe(second);
  });

  it("eliminates duplicate readonly runtime intrinsics", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = readonlyIntrinsic(handle);
    const second = readonlyIntrinsic(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(1);
    expect(ret.inputs[0]).toBe(first);
    expect(block.nodes).toContain(first);
    expect(block.nodes).not.toContain(second);
  });

  it("does not eliminate readonly runtime intrinsics across write barriers", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = readonlyIntrinsic(handle);
    const write = reactiveWrite(handle);
    const second = readonlyIntrinsic(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(write);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(ret.inputs[0]).toBe(second);
    expect(block.nodes).toContain(first);
    expect(block.nodes).toContain(second);
  });

  it("keeps domain-qualified intrinsic reads across non-aliasing writes", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = domainRead(handle, "reactive-value");
    const write = domainWrite(handle, "foreign-state");
    const second = domainRead(handle, "reactive-value");
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(write);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(1);
    expect(ret.inputs[0]).toBe(first);
    expect(block.nodes).toContain(first);
    expect(block.nodes).not.toContain(second);
  });

  it("invalidates domain-qualified intrinsic reads across aliasing writes", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = domainRead(handle, "reactive-value");
    const write = domainWrite(handle, "reactive-value");
    const second = domainRead(handle, "reactive-value");
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(write);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(ret.inputs[0]).toBe(second);
    expect(block.nodes).toContain(first);
    expect(block.nodes).toContain(second);
  });

  it("keeps unknown-domain intrinsic reads conservative across domain writes", () => {
    const { graph, block } = graphWithBlock();
    const handle = irConstant("signal");
    const first = reactiveRead(handle);
    const write = domainWrite(handle, "foreign-state");
    const second = reactiveRead(handle);
    const ret = new CFGInstruction(IR_RETURN);
    ret.addInput(second);

    block.addNode(handle);
    block.addNode(first);
    block.addNode(write);
    block.addNode(second);
    block.addNode(ret);

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(ret.inputs[0]).toBe(second);
    expect(block.nodes).toContain(first);
    expect(block.nodes).toContain(second);
  });

  it("reaches a fixed point for loops with intrinsic write barriers", () => {
    const graph = new CFGFunction("intrinsic-cse-loop");
    const entry = graph.addBlock();
    const loop = graph.addBlock();
    link(entry, loop);
    link(loop, loop);

    const handle = irConstant("signal");
    const write = reactiveWrite(handle);

    entry.addNode(handle);
    entry.addNode(irJump(loop));
    loop.addNode(write);
    loop.addNode(irJump(loop));

    expect(commonSubexpressionIntrinsicReads(graph)).toBe(0);
    expect(loop.nodes).toContain(write);
  });
});
