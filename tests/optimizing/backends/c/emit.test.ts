import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  IR_NEW_OBJECT,
  irBranch,
  irConstant,
  irCheckNumber,
  irCheckSmi,
  irFloat64Add,
  irFloat64Compare,
  irInt32Add,
  irInt32Compare,
  irInt32Mul,
  irInt32Sub,
  irJump,
  irNeg,
  irReturn,
  resetIRNodeIds,
} from "../../../../src/optimizing/ir/index.js";
import { link, connect, addPhi } from "../../../../src/optimizing/ir/cfg-edit.js";
import { emitNumericFunction } from "../../../../src/optimizing/backends/c/emit.js";
import { runCFunction } from "./c-executor.js";

beforeEach(() => resetIRNodeIds());

function compile(graph: CFGFunction) {
  const result = emitNumericFunction(graph);
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`);
  return result;
}

function run(graph: CFGFunction, args: number[] = []): number {
  const result = compile(graph);
  return runCFunction(result.source, result.symbol, args);
}

function returningConstant(name: string, value: number): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  const constant = irConstant(value);
  block.addNode(constant);
  block.addNode(irReturn(constant));
  return graph;
}

describe("emitNumericFunction executable subset", () => {
  it("executes float64 arithmetic over parameters", () => {
    const graph = new CFGFunction("add_two");
    const p0 = graph.addParameter(0);
    const p1 = graph.addParameter(1);
    const block = graph.addBlock();
    const sum = irFloat64Add(p0, p1);
    block.addNode(sum);
    block.addNode(irReturn(sum));

    expect(run(graph, [3.25, 4.5])).toBe(7.75);
  });

  it("executes constants and negation", () => {
    const graph = new CFGFunction("negate");
    const block = graph.addBlock();
    const value = irConstant(12.5);
    const negated = irNeg(value);
    block.addNode(value);
    block.addNode(negated);
    block.addNode(irReturn(negated));

    expect(run(graph)).toBe(-12.5);
    expect(Object.is(run(returningConstant("negative_zero", -0)), -0)).toBe(true);
  });

  it("bails on speculative guards that lowering must remove first", () => {
    const smiGraph = new CFGFunction("checked_smi");
    const p0 = smiGraph.addParameter(0);
    const smiBlock = smiGraph.addBlock();
    const smi = irCheckSmi(p0);
    smiBlock.addNode(smi);
    smiBlock.addNode(irReturn(smi));

    const numberGraph = new CFGFunction("checked_number");
    const p1 = numberGraph.addParameter(0);
    const numberBlock = numberGraph.addBlock();
    const number = irCheckNumber(p1);
    numberBlock.addNode(number);
    numberBlock.addNode(irReturn(number));

    const smiResult = emitNumericFunction(smiGraph);
    expect(smiResult.ok).toBe(false);
    if (!smiResult.ok) expect(smiResult.reason).toContain("CheckSmi");

    const numberResult = emitNumericFunction(numberGraph);
    expect(numberResult.ok).toBe(false);
    if (!numberResult.ok) expect(numberResult.reason).toContain("CheckNumber");
  });

  it("uses defined int32 wraparound for integer arithmetic", () => {
    const add = new CFGFunction("wrap_add");
    const p0 = add.addParameter(0);
    const addBlock = add.addBlock();
    const one = irConstant(1);
    const sum = irInt32Add(p0, one);
    addBlock.addNode(one);
    addBlock.addNode(sum);
    addBlock.addNode(irReturn(sum));

    const mul = new CFGFunction("wrap_mul");
    const p1 = mul.addParameter(0);
    const mulBlock = mul.addBlock();
    const four = irConstant(4);
    const product = irInt32Mul(p1, four);
    mulBlock.addNode(four);
    mulBlock.addNode(product);
    mulBlock.addNode(irReturn(product));

    expect(run(add, [2147483647])).toBe(-2147483648);
    expect(run(mul, [1073741824])).toBe(0);
  });

});

describe("emitNumericFunction control flow", () => {
  it("executes both arms of a branch", () => {
    const graph = new CFGFunction("pick_max");
    const p0 = graph.addParameter(0);
    const p1 = graph.addParameter(1);
    const entry = graph.addBlock();
    const whenTrue = graph.addBlock();
    const whenFalse = graph.addBlock();
    const cmp = irFloat64Compare("<", p0, p1);
    entry.addNode(cmp);
    entry.addNode(irBranch(cmp, whenTrue, whenFalse));
    link(entry, whenTrue);
    link(entry, whenFalse);
    whenTrue.addNode(irReturn(p1));
    whenFalse.addNode(irReturn(p0));

    expect(run(graph, [2, 7])).toBe(7);
    expect(run(graph, [9, 3])).toBe(9);
  });

  it("executes loop-carried block parameters through edge copies", () => {
    const graph = new CFGFunction("countdown");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const exit = graph.addBlock();
    const latch = graph.addBlock();

    const start = irConstant(10);
    entry.addNode(start);
    entry.addNode(irJump(header));
    link(entry, header);

    const counter = addPhi(header, [start]);
    const zero = irConstant(0);
    const done = irInt32Compare("<=", counter, zero);
    header.addNode(zero);
    header.addNode(done);
    header.addNode(irBranch(done, exit, latch));
    link(header, exit);
    link(header, latch);

    exit.addNode(irReturn(counter));

    const one = irConstant(1);
    const next = irInt32Sub(counter, one);
    latch.addNode(one);
    latch.addNode(next);
    latch.addNode(irJump(header));
    connect(latch, header, [next]);

    expect(run(graph)).toBe(0);
  });
});

describe("emitNumericFunction bail conditions", () => {
  function expectBail(graph: CFGFunction): string {
    const result = emitNumericFunction(graph);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  }

  it("bails on parameters attached to the entry block", () => {
    const graph = new CFGFunction("params");
    const block = graph.addBlock();
    addPhi(block, []);
    const constant = irConstant(1);
    block.addNode(constant);
    block.addNode(irReturn(constant));
    expect(expectBail(graph)).toContain("entry block");
  });

  it("bails when a reachable block lacks a terminator", () => {
    const graph = new CFGFunction("open");
    const entry = graph.addBlock();
    const tail = graph.addBlock();
    entry.addNode(irReturn(irConstant(1)));
    tail.addNode(irConstant(2));
    link(entry, tail);
    expect(expectBail(graph)).toContain("no terminator");
  });

  it("bails on a constant with no machine representation", () => {
    const graph = new CFGFunction("infinite");
    const block = graph.addBlock();
    const constant = irConstant(Number.POSITIVE_INFINITY);
    block.addNode(constant);
    block.addNode(irReturn(constant));
    expect(expectBail(graph)).toContain("unsupported constant");
  });

  it("bails on an unsupported opcode and names it", () => {
    const graph = new CFGFunction("objects");
    const block = graph.addBlock();
    const object = new CFGInstruction(IR_NEW_OBJECT);
    block.addNode(object);
    block.addNode(irReturn(object));
    expect(expectBail(graph)).toContain(IR_NEW_OBJECT);
  });

  it("bails when there is no return", () => {
    const graph = new CFGFunction("no_return");
    const block = graph.addBlock();
    block.addNode(irConstant(1));
    expect(expectBail(graph)).toContain("no return");
  });

  it("bails when the graph has already bailed out", () => {
    const graph = new CFGFunction("bailed");
    graph.addBlock();
    graph.bailout = "prior failure";
    expect(expectBail(graph)).toContain("bailed");
  });
});
