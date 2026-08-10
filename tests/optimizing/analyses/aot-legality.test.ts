import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  IR_NEW_OBJECT,
  irCallBuiltin,
  irCallKnownFunction,
  irConstant,
  irFloat64Add,
  irGenericGetProp,
  irInt32Add,
  irLoadArrayLength,
  irLoadElement,
  irLoadGlobal,
  irNewArray,
  irReturn,
  irStoreElement,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { analyzeAotLegality } from "../../../src/optimizing/analyses/aot-legality.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry } from "../../../src/optimizing/analyses/index.js";
import { typeInferenceAnalysisId } from "../../../src/optimizing/analyses/type-inference.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
} from "../../../src/optimizing/types/scalar.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  qualifiedMethodName,
} from "../../../src/optimizing/metadata/builtin-methods.js";

beforeEach(() => resetIRNodeIds());

function analyze(graph: CFGFunction) {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return analyzeAotLegality(graph, analyses.get(typeInferenceAnalysisId));
}

function reasonOf(graph: CFGFunction): string {
  const result = analyze(graph);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

function admitted(graph: CFGFunction) {
  const result = analyze(graph);
  if (!result.ok) throw new Error(`expected the graph to be legal, got: ${result.reason}`);
  return result.legality;
}

function returning(name: string, build: (graph: CFGFunction) => CFGInstruction): CFGFunction {
  const graph = new CFGFunction(name);
  const value = build(graph);
  graph.blocks[0]!.addNode(irReturn(value));
  return graph;
}

describe("AOT legality structure", () => {
  it("rejects a graph that already bailed out", () => {
    const graph = new CFGFunction("bailed");
    graph.addBlock();
    graph.bailout = "prior failure";
    expect(reasonOf(graph)).toContain("bailed");
  });

  it("rejects phis on the entry block", () => {
    const graph = new CFGFunction("entry_phi");
    const block = graph.addBlock();
    addPhi(block, []);
    const value = irConstant(1);
    block.addNode(value);
    block.addNode(irReturn(value));
    expect(reasonOf(graph)).toContain("entry block has phis");
  });

  it("rejects a block without a terminator", () => {
    const graph = new CFGFunction("open");
    const entry = graph.addBlock();
    const tail = graph.addBlock();
    entry.addNode(irReturn(irConstant(1)));
    tail.addNode(irConstant(2));
    link(entry, tail);
    expect(reasonOf(graph)).toContain("no terminator");
  });

  it("rejects a function with no return at all", () => {
    const graph = new CFGFunction("no_return");
    graph.addBlock().addNode(irConstant(1));
    expect(reasonOf(graph)).toContain("no return");
  });
});

describe("AOT legality values", () => {
  it("names the unsupported opcode it found", () => {
    const graph = returning("objects", (fn) => {
      const object = new CFGInstruction(IR_NEW_OBJECT);
      fn.addBlock().addNode(object);
      return object;
    });
    expect(reasonOf(graph)).toContain(IR_NEW_OBJECT);
  });

  it("names the property it cannot lower", () => {
    const graph = new CFGFunction("member");
    graph.declaredSignature = { params: ["string"], returns: "int" };
    const receiver = graph.addParameter(0);
    const block = graph.addBlock();
    const property = irGenericGetProp(receiver, "length");
    block.addNode(property);
    block.addNode(irReturn(property));

    expect(reasonOf(graph)).toContain("unsupported property length");
  });

  it("rejects a global whose value is used", () => {
    const graph = returning("global", (fn) => {
      const global = irLoadGlobal("counter");
      fn.addBlock().addNode(global);
      return global;
    });
    expect(reasonOf(graph)).toContain("load of a global value");
  });

  it("accepts a global load nobody reads", () => {
    const graph = new CFGFunction("unused_global");
    const block = graph.addBlock();
    const global = irLoadGlobal("counter");
    const value = irConstant(1);
    block.addNode(global);
    block.addNode(value);
    block.addNode(irReturn(value));
    expect(analyze(graph).ok).toBe(true);
  });

  it("rejects a call whose target has no resolvable name", () => {
    const graph = returning("anonymous", (fn) => {
      const block = fn.addBlock();
      const argument = irConstant(1);
      const call = irCallKnownFunction({} as never, [argument]);
      block.addNode(argument);
      block.addNode(call);
      return call;
    });
    expect(reasonOf(graph)).toContain("resolvable name");
  });

  it("rejects a non-finite constant", () => {
    const graph = returning("infinite", (fn) => {
      const value = irConstant(Number.POSITIVE_INFINITY);
      fn.addBlock().addNode(value);
      return value;
    });
    expect(reasonOf(graph)).toContain("unsupported constant");
  });

  it("rejects a string constant outside ASCII", () => {
    const graph = new CFGFunction("wide");
    graph.declaredSignature = { params: [], returns: "string" };
    const block = graph.addBlock();
    const value = irConstant("café");
    block.addNode(value);
    block.addNode(irReturn(value));
    expect(reasonOf(graph)).toContain("ASCII");
  });
});

describe("AOT legality arrays", () => {
  function withArray(name: string, escape: boolean): CFGFunction {
    const graph = new CFGFunction(name);
    graph.declaredSignature = { params: ["int"], returns: "float" };
    const index = graph.addParameter(0);
    const block = graph.addBlock();
    const first = irConstant(1.5);
    const second = irConstant(2.5);
    const array = irNewArray([first, second]);
    block.addNode(first);
    block.addNode(second);
    block.addNode(array);
    if (escape) {
      const call = irCallKnownFunction({ name: "sink" } as never, [array]);
      block.addNode(call);
      block.addNode(irReturn(first));
      return graph;
    }
    const loaded = irLoadElement(array, index);
    block.addNode(loaded);
    block.addNode(irReturn(loaded));
    return graph;
  }

  it("models a non escaping array by allocation, length and element type", () => {
    const legality = admitted(withArray("kept", false));

    expect(legality.arrays).toHaveLength(1);
    expect(legality.arrays[0]!.length).toBe(2);
    expect(legality.arrays[0]!.element).toBe(SCALAR_FLOAT64);
  });

  it("rejects an array that escapes into a call", () => {
    expect(reasonOf(withArray("escaped", true))).toContain("array escapes to");
  });

  it("resolves a phi over the same array back to its allocation", () => {
    const graph = new CFGFunction("looped");
    graph.declaredSignature = { params: ["int"], returns: "float" };
    const index = graph.addParameter(0);
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const first = irConstant(1.5);
    const array = irNewArray([first]);
    entry.addNode(first);
    entry.addNode(array);
    entry.addNode(new CFGInstruction("Jump", { targetBlock: header.id }));
    link(entry, header);
    const carried = addPhi(header, [array]);
    const stored = irStoreElement(carried, index, first);
    const length = irLoadArrayLength(carried);
    header.addNode(stored);
    header.addNode(length);
    header.addNode(irReturn(length));
    connect(header, header, [carried]);

    const legality = admitted(graph);
    expect(legality.arrayOf(carried)).toBe(legality.arrayOf(array));
    expect(legality.arrayOf(carried)!.allocation).toBe(array);
  });

  it("rejects indexing a value that is not a local array", () => {
    const graph = new CFGFunction("string_index");
    graph.declaredSignature = { params: ["string", "int"], returns: "float" };
    const text = graph.addParameter(0);
    const index = graph.addParameter(1);
    const block = graph.addBlock();
    const loaded = irLoadElement(text, index);
    block.addNode(loaded);
    block.addNode(irReturn(loaded));

    expect(reasonOf(graph)).toContain("not a local array");
  });
});

describe("AOT legality builtins", () => {
  const charCodeAt = builtinMethodIntrinsicByName(
    qualifiedMethodName("string", "char_code_at"),
  )!;

  function builtinCall(name: string, params: readonly (string | null)[]): CFGFunction {
    const graph = new CFGFunction("call");
    graph.declaredSignature = { params: [...params], returns: "int" };
    const receiver = graph.addParameter(0);
    const index = graph.addParameter(1);
    const block = graph.addBlock();
    const call = irCallBuiltin(name, [receiver, index], builtinMethodCallMetadata(charCodeAt));
    block.addNode(call);
    block.addNode(irReturn(call));
    return graph;
  }

  it("accepts a builtin in the shared subset", () => {
    expect(analyze(builtinCall(charCodeAt.qualifiedName, ["string", "int"])).ok).toBe(true);
  });

  it("names a builtin outside the shared subset", () => {
    expect(reasonOf(builtinCall("string.trim", ["string", "int"]))).toContain(
      "unsupported builtin string.trim",
    );
  });

  it("rejects a builtin whose receiver has the wrong type", () => {
    expect(reasonOf(builtinCall(charCodeAt.qualifiedName, ["int", "int"]))).toContain(
      "unsupported argument type",
    );
  });
});

describe("AOT legality signatures", () => {
  it("takes scalar types from the declared signature", () => {
    const graph = new CFGFunction("declared");
    graph.declaredSignature = { params: ["int", "string"], returns: "float" };
    const left = graph.addParameter(0);
    graph.addParameter(1);
    const block = graph.addBlock();
    const sum = irFloat64Add(left, left);
    block.addNode(sum);
    block.addNode(irReturn(sum));

    const legality = admitted(graph);
    expect(legality.parameterScalars).toEqual([SCALAR_INT32, SCALAR_STRING]);
    expect(legality.returnScalar).toBe(SCALAR_FLOAT64);
    expect(legality.declaredReturn).toBe(true);
  });

  it("infers a return type when the signature declares none", () => {
    const graph = new CFGFunction("inferred");
    const left = graph.addParameter(0);
    const block = graph.addBlock();
    const one = irConstant(1);
    const sum = irInt32Add(left, one);
    block.addNode(one);
    block.addNode(sum);
    block.addNode(irReturn(sum));

    const legality = admitted(graph);
    expect(legality.declaredReturn).toBe(false);
  });

  it("collects each distinct constant once", () => {
    const graph = new CFGFunction("constants");
    const block = graph.addBlock();
    const one = irConstant(1);
    const two = irConstant(2);
    const sum = irInt32Add(one, two);
    block.addNode(one);
    block.addNode(two);
    block.addNode(sum);
    block.addNode(irReturn(sum));

    expect(admitted(graph).constants).toEqual([one, two]);
  });
});
