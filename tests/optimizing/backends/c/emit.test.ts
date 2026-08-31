import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  IR_NEW_OBJECT,
  irBranch,
  irCallBuiltin,
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
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  qualifiedMethodName,
} from "../../../../src/optimizing/metadata/builtin-methods.js";
import { itNative, runCFunction } from "../../../helpers/c-executor.js";

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

function declaring(
  name: string,
  params: readonly string[],
  returns: string,
): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = {
    params: [...params],
    names: params.map((_, at) => `p${at}`),
    returns,
  };
  return graph;
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
  itNative("executes float64 arithmetic over parameters", () => {
    const graph = declaring("add_two", ["float", "float"], "float");
    const p0 = graph.addParameter(0);
    const p1 = graph.addParameter(1);
    const block = graph.addBlock();
    const sum = irFloat64Add(p0, p1);
    block.addNode(sum);
    block.addNode(irReturn(sum));

    expect(run(graph, [3.25, 4.5])).toBe(7.75);
  });

  itNative("executes constants and negation", () => {
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

  itNative("uses defined int32 wraparound for integer arithmetic", () => {
    const add = declaring("wrap_add", ["int"], "int");
    const p0 = add.addParameter(0);
    const addBlock = add.addBlock();
    const one = irConstant(1);
    const sum = irInt32Add(p0, one);
    addBlock.addNode(one);
    addBlock.addNode(sum);
    addBlock.addNode(irReturn(sum));

    const mul = declaring("wrap_mul", ["int"], "int");
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
  itNative("executes both arms of a branch", () => {
    const graph = declaring("pick_max", ["float", "float"], "float");
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

  itNative("executes loop-carried block parameters through edge copies", () => {
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

describe("emitNumericFunction builtin methods", () => {
  const charCodeAt = builtinMethodIntrinsicByName(
    qualifiedMethodName("string", "char_code_at"),
  )!;

  function codeAtGraph(name: string, builtinName = charCodeAt.qualifiedName): CFGFunction {
    const graph = new CFGFunction(name);
    graph.declaredSignature = { params: ["string", "int"], returns: "int" };
    const receiver = graph.addParameter(0);
    const index = graph.addParameter(1);
    const block = graph.addBlock();
    const call = irCallBuiltin(
      builtinName,
      [receiver, index],
      builtinMethodCallMetadata(charCodeAt),
    );
    block.addNode(call);
    block.addNode(irReturn(call));
    return graph;
  }

  it("calls a named helper instead of inlining the access", () => {
    const result = compile(codeAtGraph("code_at"));

    expect(result.source).toContain("= tera_string_char_code_at(p0, p1);");
    expect(result.source).not.toContain("(unsigned char)p0[");
  });

  it("defines the helper in the translation unit preamble", () => {
    const result = compile(codeAtGraph("code_at"));

    expect(result.translationUnitPreamble).toContain(
      "static inline int32_t tera_string_char_code_at(const char *value, int32_t index)",
    );
  });

  it("takes the parameter types from the declared signature", () => {
    const result = compile(codeAtGraph("code_at"));

    expect(result.prototype).toContain("int32_t code_at(const char *p0, int32_t p1)");
  });

  function padGraph(name: string, builtinName: string): CFGFunction {
    const graph = new CFGFunction(name);
    graph.declaredSignature = { params: ["string", "int", "string"], returns: "string" };
    const receiver = graph.addParameter(0);
    const width = graph.addParameter(1);
    const pad = graph.addParameter(2);
    const block = graph.addBlock();
    const method = builtinMethodIntrinsicByName(builtinName)!;
    const call = irCallBuiltin(
      builtinName,
      [receiver, width, pad],
      builtinMethodCallMetadata(method),
    );
    block.addNode(call);
    block.addNode(irReturn(call));
    return graph;
  }

  it("calls the padding helper the backend defines for pad_start", () => {
    const result = compile(padGraph("pad_left", qualifiedMethodName("string", "pad_start")));

    expect(result.source).toContain("tera_string_pad_start(");
    expect(result.translationUnitPreamble).toContain(
      "static inline char *tera_string_pad_start(char *dst, int32_t cap, const char *src, int32_t width, const char *pad)",
    );
  });

  it("calls the padding helper the backend defines for pad_end", () => {
    const result = compile(padGraph("pad_right", qualifiedMethodName("string", "pad_end")));

    expect(result.source).toContain("tera_string_pad_end(");
    expect(result.translationUnitPreamble).toContain(
      "static inline char *tera_string_pad_end(char *dst, int32_t cap, const char *src, int32_t width, const char *pad)",
    );
  });

  it("pads from the same side helper with opposite leading flags", () => {
    const left = compile(padGraph("pad_left", qualifiedMethodName("string", "pad_start")));
    const right = compile(padGraph("pad_right", qualifiedMethodName("string", "pad_end")));

    expect(left.translationUnitPreamble).toContain("tera_text_pad(dst, cap, src, width, pad, 1)");
    expect(right.translationUnitPreamble).toContain("tera_text_pad(dst, cap, src, width, pad, 0)");
  });

  it("bails on a builtin the backend has no helper for", () => {
    const result = emitNumericFunction(codeAtGraph("unknown", "string.last_index_of"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unsupported builtin string.last_index_of");
  });

  it("bails on a builtin whose receiver is not a string", () => {
    const graph = new CFGFunction("numeric_receiver");
    graph.declaredSignature = { params: ["int", "int"], returns: "int" };
    const receiver = graph.addParameter(0);
    const index = graph.addParameter(1);
    const block = graph.addBlock();
    const call = irCallBuiltin(
      charCodeAt.qualifiedName,
      [receiver, index],
      builtinMethodCallMetadata(charCodeAt),
    );
    block.addNode(call);
    block.addNode(irReturn(call));

    const result = emitNumericFunction(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("is given a int32 where it takes string");
  });

  it("emits a getter as a one-argument helper call", () => {
    const length = builtinMethodIntrinsicByName(qualifiedMethodName("string", "length"))!;
    const graph = new CFGFunction("size");
    graph.declaredSignature = { params: ["string"], returns: "int" };
    const receiver = graph.addParameter(0);
    const block = graph.addBlock();
    const call = irCallBuiltin(
      length.qualifiedName,
      [receiver],
      builtinMethodCallMetadata(length),
    );
    block.addNode(call);
    block.addNode(irReturn(call));

    const result = compile(graph);
    expect(result.source).toContain("= tera_string_length(p0);");
    expect(result.source).not.toContain("strlen(p0)");
  });

  itNative("reads the code unit at an index", () => {
    const source = compile(codeAtGraph("code_at")).source;

    expect(runCFunction(source, "code_at", ["Hi", 0])).toBe("H".charCodeAt(0));
    expect(runCFunction(source, "code_at", ["Hi", 1])).toBe("i".charCodeAt(0));
  });

  itNative("returns zero for a negative index", () => {
    const source = compile(codeAtGraph("code_at")).source;

    expect(runCFunction(source, "code_at", ["Hi", -1])).toBe(0);
  });
});

function emitted(graph: CFGFunction) {
  const result = emitNumericFunction(graph);
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`);
  return result;
}

function declined(graph: CFGFunction): string {
  const result = emitNumericFunction(graph);
  if (result.ok) throw new Error("expected the emitter to decline this graph");
  return result.reason;
}

describe("what emitNumericFunction reports about a function it lowered", () => {
  it("names the symbol after the graph", () => {
    expect(emitted(returningConstant("answer", 42)).symbol).toBe("answer");
  });

  it("reports no parameters for a graph that declares none", () => {
    const result = emitted(returningConstant("answer", 42));

    expect(result.parameterCount).toBe(0);
    expect(result.parameterScalars).toEqual([]);
  });

  it("reports one scalar per declared parameter, in order", () => {
    const graph = declaring("mix", ["int", "float"], "float");
    const p0 = graph.addParameter(0);
    const p1 = graph.addParameter(1);
    const block = graph.addBlock();
    const sum = irFloat64Add(p0, p1);
    block.addNode(sum);
    block.addNode(irReturn(sum));
    const result = emitted(graph);

    expect(result.parameterCount).toBe(2);
    expect(result.parameterScalars).toHaveLength(2);
    expect(result.parameterScalars[0]).not.toBe(result.parameterScalars[1]);
  });

  it("takes the return scalar from the declared return type", () => {
    const graph = declaring("half", ["int"], "float");
    const p0 = graph.addParameter(0);
    const block = graph.addBlock();
    const scaled = irFloat64Add(p0, p0);
    block.addNode(scaled);
    block.addNode(irReturn(scaled));

    expect(emitted(graph).returnScalar).toBe("float64");
  });

  it("emits a prototype the source's definition matches", () => {
    const result = emitted(returningConstant("answer", 42));
    const opening = result.prototype.replace(/;\s*$/, "");

    expect(result.prototype.endsWith(";")).toBe(true);
    expect(result.source).toContain(opening);
  });

  it("names the symbol in both the prototype and the body it emits", () => {
    const result = emitted(returningConstant("answer", 42));

    expect(result.prototype).toContain("answer");
    expect(result.source).toContain("answer");
  });

  it("puts the runtime helpers in a preamble rather than in each function's body", () => {
    const result = emitted(returningConstant("answer", 42));

    expect(result.sourcePreamble).toContain("tera_i32_add");
    expect(result.source.slice(result.source.indexOf("answer"))).not.toContain("static inline");
  });

  it("keeps the header preamble free of function bodies so it can be included twice", () => {
    expect(emitted(returningConstant("answer", 42)).headerPreamble).not.toContain("static inline");
  });

  it("reports no references for a function that calls nothing", () => {
    expect(emitted(returningConstant("answer", 42)).references).toEqual([]);
  });

  it("emits the same source for the same graph shape twice over", () => {
    const first = emitted(returningConstant("answer", 42)).source;
    resetIRNodeIds();
    const second = emitted(returningConstant("answer", 42)).source;

    expect(second).toBe(first);
  });

  it("declines a graph whose parameter has no declared type, saying which parameter", () => {
    const graph = new CFGFunction("loose");
    const parameter = graph.addParameter(0);
    const block = graph.addBlock();
    block.addNode(irReturn(parameter));

    expect(declined(graph)).toContain("parameter #1");
    expect(declined(graph)).toContain("declare it");
  });

  it("declines a graph that allocates an object the C backend cannot lay out", () => {
    const graph = new CFGFunction("makes");
    const block = graph.addBlock();
    const created = new CFGInstruction(IR_NEW_OBJECT);
    block.addNode(created);
    block.addNode(irReturn(created));

    expect(declined(graph)).not.toBe("");
  });

  it("gives a reason a caller can put in front of a user rather than an empty string", () => {
    const graph = new CFGFunction("loose");
    const parameter = graph.addParameter(0);
    const block = graph.addBlock();
    block.addNode(irReturn(parameter));

    expect(declined(graph).length).toBeGreaterThan(0);
    expect(declined(graph)).toBe(declined(graph));
  });
});
