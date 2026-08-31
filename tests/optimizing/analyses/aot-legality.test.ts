import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  IR_NEW_OBJECT,
  irCallBuiltin,
  irCallKnownFunction,
  irConstant,
  irFloat64Add,
  irGenericAdd,
  irGenericGetProp,
  irInt32Add,
  irLoadArrayLength,
  IR_LOAD_ELEMENT,
  irLoadElement,
  irLoadGlobal,
  irNewArray,
  irReturn,
  irStoreElement,
  irStoreField,
  irStoreText,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";
import {
  analyzeAotLegality,
  summarizeStringEscapes,
} from "../../../src/optimizing/analyses/aot-legality.js";
import { callReachability } from "../../../src/optimizing/metadata/call-graph.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry } from "../../../src/optimizing/analyses/index.js";
import { typeInferenceAnalysisId } from "../../../src/optimizing/analyses/type-inference.js";
import { gatheredParameterName } from "../../../src/optimizing/types/signature.js";
import { BUFFER_ELEMENTS_OFFSET } from "../../../src/optimizing/metadata/class-table.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  TEXT_STORAGE_BYTES,
  type AotScalar,
} from "../../../src/optimizing/types/scalar.js";
import {
  builtinIntrinsicByName,
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  INPUT_BUILTIN,
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

  it("rejects a global whose value is used, and names it", () => {
    const graph = returning("global", (fn) => {
      const global = irLoadGlobal("counter");
      fn.addBlock().addNode(global);
      return global;
    });
    expect(reasonOf(graph)).toContain("load of the global value counter");
  });

  it("says where a member read off a runtime global comes from", () => {
    const graph = returning("runtime_member", (fn) => {
      const global = irLoadGlobal("Promise");
      const read = irGenericGetProp(global, "resolve");
      const block = fn.addBlock();
      block.addNode(global);
      block.addNode(read);
      return read;
    });
    expect(reasonOf(graph)).toContain("Promise.resolve is part of the runtime");
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

  it("rejects a string constant longer than the storage a compiled string has", () => {
    const graph = new CFGFunction("long");
    graph.declaredSignature = { params: [], returns: "string" };
    const block = graph.addBlock();
    const value = irConstant("x".repeat(graph.textBufferBytes));
    block.addNode(value);
    block.addNode(irReturn(value));
    expect(reasonOf(graph)).toContain(`longer than the ${graph.textBufferBytes - 1} characters`);
  });

  it("accepts a string constant that fills the storage exactly", () => {
    const graph = new CFGFunction("full");
    graph.declaredSignature = { params: [], returns: "string" };
    const block = graph.addBlock();
    const value = irConstant("x".repeat(graph.textBufferBytes - 1));
    block.addNode(value);
    block.addNode(irReturn(value));
    expect(analyze(graph).ok).toBe(true);
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
  function elementAccess(name: string, element: AotScalar, index: string): CFGFunction {
    const graph = new CFGFunction(name);
    graph.declaredSignature = { params: ["float[]", index], returns: "float" };
    const array = graph.addParameter(0);
    const at = graph.addParameter(1);
    const block = graph.addBlock();
    const loaded = irLoadElement(array, at);
    loaded.props.elementScalar = element;
    loaded.props.offset = BUFFER_ELEMENTS_OFFSET;
    block.addNode(loaded);
    block.addNode(irReturn(loaded));
    return graph;
  }

  it("gives an element access the width the array was shaped with", () => {
    const graph = elementAccess("read", SCALAR_FLOAT64, "int");
    const loaded = graph.blocks[0]!.nodes.find((node) => node.type === IR_LOAD_ELEMENT)!;

    expect(admitted(graph).scalarOf(loaded)).toBe(SCALAR_FLOAT64);
  });

  it("rejects an element access the shaping pass never reached", () => {
    const graph = new CFGFunction("bare");
    graph.declaredSignature = { params: ["float[]", "int"], returns: "float" };
    const array = graph.addParameter(0);
    const at = graph.addParameter(1);
    const block = graph.addBlock();
    const loaded = irLoadElement(array, at);
    block.addNode(loaded);
    block.addNode(irReturn(loaded));

    expect(reasonOf(graph)).toContain("cannot see the elements of");
  });

  it("admits a fractional index, which the backend narrows on the way in", () => {
    const graph = elementAccess("floating", SCALAR_FLOAT64, "float");
    const loaded = graph.blocks[0]!.nodes.find((node) => node.type === IR_LOAD_ELEMENT)!;

    expect(admitted(graph).scalarOf(loaded)).toBe(SCALAR_FLOAT64);
  });

  it("rejects an index that is not a number", () => {
    expect(reasonOf(elementAccess("textual", SCALAR_FLOAT64, "string"))).toContain(
      "indexed by a value that is not a number",
    );
  });

  it("rejects storing text into an array of numbers", () => {
    const graph = new CFGFunction("mixed");
    graph.declaredSignature = { params: ["float[]", "int", "string"], returns: "float" };
    const array = graph.addParameter(0);
    const at = graph.addParameter(1);
    const text = graph.addParameter(2);
    const block = graph.addBlock();
    const stored = irStoreElement(array, at, text);
    stored.props.elementScalar = SCALAR_FLOAT64;
    stored.props.offset = BUFFER_ELEMENTS_OFFSET;
    block.addNode(stored);
    block.addNode(irReturn(stored));

    expect(reasonOf(graph)).toContain("array has an unsupported element type");
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
    expect(reasonOf(builtinCall("string.last_index_of", ["string", "string"]))).toContain(
      "unsupported builtin string.last_index_of",
    );
  });

  it("rejects a builtin whose receiver has the wrong type", () => {
    expect(reasonOf(builtinCall(charCodeAt.qualifiedName, ["int", "int"]))).toContain(
      "is given a int32 where it takes string",
    );
  });
});

describe("AOT legality string buffers", () => {
  const OWNER_OFFSET = 24;

  function building(keep: (owner: CFGInstruction, built: CFGInstruction) => CFGInstruction) {
    const graph = new CFGFunction("greet");
    graph.declaredSignature = { params: ["string"], returns: "int" };
    const owner = graph.addParameter(0);
    const block = graph.addBlock();
    const left = irConstant("hello ");
    const built = irGenericAdd(left, owner);
    const zero = irConstant(0);
    block.addNode(left);
    block.addNode(built);
    block.addNode(keep(owner, built));
    block.addNode(zero);
    block.addNode(irReturn(zero));
    return graph;
  }

  it("admits a built string copied into storage the object owns", () => {
    const graph = building((owner, built) =>
      irStoreText(owner, OWNER_OFFSET, built, TEXT_STORAGE_BYTES),
    );

    expect(admitted(graph).stringBuffers).toHaveLength(1);
  });

  it("rejects a built string stored as a pointer and names what to do instead", () => {
    const graph = building((owner, built) => irStoreField(owner, OWNER_OFFSET, built, "value"));

    expect(reasonOf(graph)).toBe(
      "greet builds a string and then stores it in value; that string lives only until the " +
        "next one is produced there, so it can be printed, built into another string, or " +
        "copied into an object field, but not kept; use it where it is produced, or keep " +
        "this part interpreted",
    );
  });

  it("names the callee a built string is handed to", () => {
    const graph = building((owner, built) =>
      irCallKnownFunction({ name: "shout" } as never, [built, owner]),
    );

    expect(reasonOf(graph)).toContain("passes it to shout");
  });

  function reading(keep: (owner: CFGInstruction, read: CFGInstruction) => CFGInstruction) {
    const graph = new CFGFunction("prompt");
    graph.declaredSignature = { params: ["string"], returns: "int" };
    const owner = graph.addParameter(0);
    const block = graph.addBlock();
    const read = irCallBuiltin(
      INPUT_BUILTIN,
      [owner],
      builtinMethodCallMetadata(builtinIntrinsicByName(INPUT_BUILTIN)!),
    );
    const zero = irConstant(0);
    block.addNode(read);
    block.addNode(keep(owner, read));
    block.addNode(zero);
    block.addNode(irReturn(zero));
    return graph;
  }

  it("admits a line of input copied into storage the object owns", () => {
    const graph = reading((owner, read) =>
      irStoreText(owner, OWNER_OFFSET, read, TEXT_STORAGE_BYTES),
    );

    expect(admitted(graph).stringBuffers).toHaveLength(1);
  });

  it("rejects a line of input stored as a pointer", () => {
    const graph = reading((owner, read) => irStoreField(owner, OWNER_OFFSET, read, "value"));

    expect(reasonOf(graph)).toBe(
      "prompt reads a line and then stores it in value; that string lives only until the " +
        "next one is produced there, so it can be printed, built into another string, or " +
        "copied into an object field, but not kept; use it where it is produced, or keep " +
        "this part interpreted",
    );
  });

  it("rejects a line of input handed to a function that keeps it", () => {
    const graph = reading((owner, read) =>
      irCallKnownFunction({ name: "shout" } as never, [read, owner]),
    );

    expect(reasonOf(graph)).toContain("passes it to shout");
  });
});

describe("AOT string escape summaries", () => {
  const OWNER_OFFSET = 24;

  function summarize(graphs: readonly CFGFunction[]) {
    return summarizeStringEscapes(
      graphs.map((graph) => ({
        graph,
        types: new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
      })),
      callReachability(graphs),
    );
  }

  function keeping(name: string, keep: (owner: CFGInstruction, text: CFGInstruction) => CFGInstruction) {
    const graph = new CFGFunction(name);
    graph.declaredSignature = { params: ["int", "string"], returns: "int" };
    const owner = graph.addParameter(0);
    const text = graph.addParameter(1);
    const block = graph.addBlock();
    const zero = irConstant(0);
    block.addNode(keep(owner, text));
    block.addNode(zero);
    block.addNode(irReturn(zero));
    return graph;
  }

  it("does not retain a string parameter the callee copies into its own storage", () => {
    const graph = keeping("hold", (owner, text) =>
      irStoreText(owner, OWNER_OFFSET, text, TEXT_STORAGE_BYTES),
    );

    expect(summarize([graph]).summaryOf("hold")!.retains.has(1)).toBe(false);
  });

  it("retains a string parameter the callee stores as a pointer", () => {
    const graph = keeping("hold", (owner, text) =>
      irStoreField(owner, OWNER_OFFSET, text, "value"),
    );

    expect(summarize([graph]).summaryOf("hold")!.retains.has(1)).toBe(true);
  });

  it("carries retention back through a caller that only forwards the string", () => {
    const callee = keeping("hold", (owner, text) =>
      irStoreField(owner, OWNER_OFFSET, text, "value"),
    );
    const caller = keeping("forward", (owner, text) =>
      irCallKnownFunction({ name: "hold" } as never, [owner, text]),
    );

    expect(summarize([callee, caller]).summaryOf("forward")!.retains.has(1)).toBe(true);
  });

  it("reports a function that returns a string it built as returning a buffer", () => {
    const graph = returning("build", (fn) => {
      fn.declaredSignature = { params: ["string"], returns: "string" };
      const tail = fn.addParameter(0);
      const block = fn.addBlock();
      const head = irConstant("v");
      const built = irGenericAdd(head, tail);
      block.addNode(head);
      block.addNode(built);
      return built;
    });

    expect(summarize([graph]).summaryOf("build")!.returnsBuffer).toBe(true);
  });

  it("does not report a function that returns a string constant as returning a buffer", () => {
    const graph = returning("label", (fn) => {
      fn.declaredSignature = { params: [], returns: "string" };
      const value = irConstant("v");
      fn.addBlock().addNode(value);
      return value;
    });

    expect(summarize([graph]).summaryOf("label")!.returnsBuffer).toBe(false);
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
    graph.declaredSignature = { params: ["int"], names: ["left"], returns: null };
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

  it("refuses a parameter whose type the source never declared", () => {
    const graph = new CFGFunction("loose");
    graph.declaredSignature = { params: ["any"], names: ["a"], returns: "int" };
    const value = graph.addParameter(0);
    const block = graph.addBlock();
    const one = irConstant(1);
    const sum = irInt32Add(value, one);
    block.addNode(one);
    block.addNode(sum);
    block.addNode(irReturn(sum));

    expect(reasonOf(graph)).toBe(
      "parameter 'a' has no declared type; declare it (for example 'a: int'), " +
        "or keep this part interpreted",
    );
  });

  it("names the rest parameter when a gathered argument has no declared type", () => {
    const graph = new CFGFunction("gathering");
    graph.declaredSignature = {
      params: [null],
      names: [gatheredParameterName(0)],
      rest: { name: "values", type: null },
      returns: "int",
    };
    const value = graph.addParameter(0);
    const block = graph.addBlock();
    const one = irConstant(1);
    const sum = irInt32Add(value, one);
    block.addNode(one);
    block.addNode(sum);
    block.addNode(irReturn(sum));

    expect(reasonOf(graph)).toBe(
      "rest parameter 'values' has no declared type; declare the type its arguments have " +
        "(for example '...values: int'), or keep this part interpreted",
    );
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

describe("AOT legality text stores", () => {
  const FIELD_OFFSET = 24;
  const FIELD_CAPACITY = 32;

  function storing(text: string) {
    const graph = new CFGFunction("label");
    graph.declaredSignature = { params: ["string"], returns: "int" };
    const owner = graph.addParameter(0);
    const block = graph.addBlock();
    const value = block.addNode(irConstant(text));
    block.addNode(irStoreText(owner, FIELD_OFFSET, value, FIELD_CAPACITY, "name"));
    const zero = block.addNode(irConstant(0));
    block.addNode(irReturn(zero));
    return graph;
  }

  it("admits a constant that fits the storage the field holds", () => {
    expect(analyze(storing("x".repeat(FIELD_CAPACITY - 1))).ok).toBe(true);
  });

  it("rejects a constant one character past what the field holds", () => {
    expect(reasonOf(storing("x".repeat(FIELD_CAPACITY)))).toContain(
      `stores a string of ${FIELD_CAPACITY} characters in name, which holds ${FIELD_CAPACITY - 1}`,
    );
  });

  it("names the field a too-long constant would not fit", () => {
    expect(reasonOf(storing("x".repeat(FIELD_CAPACITY + 10)))).toContain("in name");
  });

  it("says nothing about --text-size for a store the field bounds", () => {
    expect(reasonOf(storing("x".repeat(FIELD_CAPACITY)))).not.toContain("--text-size");
  });
});
