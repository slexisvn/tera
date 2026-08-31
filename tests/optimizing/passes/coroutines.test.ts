import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irAwait,
  irConstant,
  irInt32Add,
  irNewObject,
  irReturn,
  resetIRNodeIds,
  IR_BRANCH,
  IR_GENERIC_ADD,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_NEW_OBJECT,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
  textCapacityOf,
  type CFGBlock,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import {
  lowerAwaitedPromises,
  splitCoroutine,
  type PromiseOf,
} from "../../../src/optimizing/passes/coroutines.js";
import {
  coroutineBaseShapes,
  coroutinePromiseShape,
  CORO_ERROR_FIELD,
  CORO_ERROR_VALUE_FIELD,
  CORO_NEXT_FIELD,
  CORO_STATE_FIELD,
  CORO_STATE_PENDING,
  CORO_STATE_REJECTED,
  CORO_VALUE_FIELD,
} from "../../../src/optimizing/metadata/coroutines.js";
import { TERA_NEVER_SETTLED } from "../../../src/optimizing/target/faults.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";
import { recordPendingThrow, returnPendingThrow } from "../../../src/optimizing/builder/throw-recovery.js";
import {
  buildClassTable,
  referenceFieldOffsets,
  type ClassShape,
  type ClassTable,
} from "../../../src/optimizing/metadata/class-table.js";
import { TEXT_STORAGE_BYTES } from "../../../src/optimizing/types/scalar.js";
import { CLASS_DATA_MEMBER } from "../../../src/core/class-member.js";
import {
  ERROR_DISPLAY_PREFIX,
  ERROR_MESSAGE_FIELD,
} from "../../../src/optimizing/prelude/errors.js";
import type { ClassSurface } from "../../../src/frontend/modules/interface.js";

const BOX: ClassSurface = {
  name: "Box",
  parent: null,
  abstract: false,
  members: [
    {
      name: "v",
      declaredType: "int",
      member: CLASS_DATA_MEMBER,
      owner: "Box",
      abstract: false,
      visibility: "public",
      static: false,
    },
  ],
  constructorParams: [],
  constructorParamNames: [],
};

const FAULT: ClassSurface = {
  name: "Fault",
  parent: null,
  abstract: false,
  members: [
    {
      name: "message",
      declaredType: "string",
      member: CLASS_DATA_MEMBER,
      owner: "Fault",
      abstract: false,
      visibility: "public",
      static: false,
    },
  ],
  constructorParams: [],
  constructorParamNames: [],
};

function table(): ClassTable {
  const classes = buildClassTable([BOX]);
  coroutineBaseShapes(classes);
  return classes;
}

function allocationOf(block: CFGBlock, shape: ClassShape) {
  return block.nodes.find(
    (node) => node.type === IR_NEW_OBJECT && node.props.classId === shape.id,
  )!;
}

function offsetsSetBeforeTheNextAllocation(block: CFGBlock, shape: ClassShape): number[] {
  const allocation = allocationOf(block, shape);
  const stored = new Set<number>();
  for (const node of block.nodes.slice(block.nodes.indexOf(allocation) + 1)) {
    if (node.type === IR_NEW_OBJECT || node.type === IR_CALL_KNOWN_FUNCTION) break;
    if (node.type !== IR_STORE_FIELD || node.inputs[0] !== allocation) continue;
    stored.add(Number(node.props.offset));
  }
  return referenceFieldOffsets(shape).filter((offset) => stored.has(offset));
}

function suspending(classes: ClassTable, suspends: number, carry: boolean): CFGFunction {
  const graph = new CFGFunction("f");
  graph.classes = classes;
  graph.declaredSignature = { params: ["int"], returns: "int" };
  const n = graph.addParameter(0);
  const block = graph.addBlock();
  const consumed = block.addNode(irInt32Add(n, n));
  const kept = block.addNode(irInt32Add(consumed, n));
  let total = kept;
  for (let index = 0; index < suspends; index++) {
    const awaited = block.addNode(irAwait(block.addNode(irConstant(1))));
    total = block.addNode(irInt32Add(carry ? total : awaited, awaited));
  }
  block.addNode(irReturn(total));
  return graph;
}

function split(graph: CFGFunction, classes: ClassTable, promiseOf: PromiseOf = () => null) {
  return splitCoroutine(graph, classes, coroutinePromiseShape(classes, "f", "Box"), promiseOf);
}

beforeEach(() => resetIRNodeIds());

describe("splitCoroutine", () => {
  it("hands the collector a frame whose references are all set before the next allocation", () => {
    const classes = table();
    const graph = suspending(classes, 1, true);
    const { frame, promise } = split(graph, classes);

    const stub = graph.blocks[0]!;
    for (const shape of [promise, frame!]) {
      expect([shape.name, offsetsSetBeforeTheNextAllocation(stub, shape)]).toEqual([
        shape.name,
        referenceFieldOffsets(shape),
      ]);
    }
    expect(referenceFieldOffsets(frame!).length).toBeGreaterThan(0);
  });

  it("gives a frame slot to the values that outlive a suspend and to nothing else", () => {
    const classes = table();
    const { frame } = split(suspending(classes, 1, true), classes);

    expect([...frame!.fields.keys()]).toEqual([
      "coroutine",
      "state",
      "next",
      "result",
      "param0",
      "slot0",
    ]);
  });

  it("leaves a value consumed before the suspend out of the frame", () => {
    const classes = table();
    const { frame } = split(suspending(classes, 1, false), classes);

    expect([...frame!.fields.keys()]).toEqual([
      "coroutine",
      "state",
      "next",
      "result",
      "param0",
    ]);
  });

  it("re-points the queue link at every frame it enqueues", () => {
    const classes = table();
    const { resume, frame } = split(suspending(classes, 3, true), classes);
    const link = frame!.fields.get(CORO_NEXT_FIELD)!.offset;

    const relinks = resume!.blocks.flatMap((block) =>
      block.nodes.filter(
        (node) =>
          node.type === IR_STORE_FIELD &&
          Number(node.props.offset) === link &&
          node.inputs[0] === node.inputs[1],
      ),
    );
    expect(relinks).toHaveLength(4);
  });

  it("copies a string result into the promise instead of pointing at the buffer", () => {
    const classes = table();
    const graph = new CFGFunction("f");
    graph.classes = classes;
    graph.declaredSignature = { params: [], returns: "string" };
    const block = graph.addBlock();
    const text = block.addNode(irConstant("done"));
    block.addNode(irAwait(block.addNode(irConstant(1))));
    block.addNode(irReturn(text));

    const promise = coroutinePromiseShape(classes, "f", "string");
    const { resume } = splitCoroutine(graph, classes, promise, () => null);
    const value = promise.fields.get(CORO_VALUE_FIELD)!;
    const settles = (type: string) =>
      resume!.blocks.flatMap((candidate) =>
        candidate.nodes.filter(
          (node) => node.type === type && Number(node.props.offset) === value.offset,
        ),
      );

    expect(settles(IR_STORE_FIELD)).toEqual([]);
    expect(settles(IR_STORE_TEXT).map((node) => textCapacityOf(node))).toEqual([
      TEXT_STORAGE_BYTES,
    ]);
  });

  it("copies a thrown value into the promise and marks it rejected", () => {
    const classes = table();
    const graph = new CFGFunction("f");
    graph.classes = classes;
    graph.recoversThrows = true;
    graph.declaredSignature = { params: [], returns: "int" };
    const block = graph.addBlock();
    block.addNode(irAwait(block.addNode(irConstant(1))));
    recordPendingThrow(block, block.addNode(irConstant("boom")));
    returnPendingThrow(block);

    const promise = coroutinePromiseShape(classes, "f", "int");
    const { resume } = splitCoroutine(graph, classes, promise, () => null);
    const error = promise.fields.get(CORO_ERROR_FIELD)!;
    const state = promise.fields.get(CORO_STATE_FIELD)!;
    const stores = (type: string, offset: number) =>
      resume!.blocks.flatMap((candidate) =>
        candidate.nodes.filter(
          (node) => node.type === type && Number(node.props.offset) === offset,
        ),
      );

    expect(stores(IR_STORE_TEXT, error.offset).map((node) => textCapacityOf(node))).toEqual([
      TEXT_STORAGE_BYTES,
    ]);
    expect(
      stores(IR_STORE_FIELD, state.offset).map((node) => Number(node.inputs[1]!.props.value)),
    ).toContain(CORO_STATE_REJECTED);
  });

  const rejectsWith = (declaredThrown: string | null) => {
    const classes = buildClassTable([BOX, FAULT]);
    if (declaredThrown !== null) classes.declareThrownType(declaredThrown);
    coroutineBaseShapes(classes);
    const graph = new CFGFunction("f");
    graph.classes = classes;
    graph.recoversThrows = true;
    graph.declaredSignature = { params: [], returns: "int" };
    const block = graph.addBlock();
    block.addNode(irAwait(block.addNode(irConstant(1))));
    recordPendingThrow(block, block.addNode(irNewObject(classes.shapeOf("Fault")!.id)));
    returnPendingThrow(block);

    const promise = coroutinePromiseShape(classes, "f", "int");
    const { resume } = splitCoroutine(graph, classes, promise, () => null);
    return {
      promise,
      nodes: resume!.blocks.flatMap((candidate) => candidate.nodes),
    };
  };

  const storesAt = (nodes: CFGInstruction[], type: string, offset: number) =>
    nodes.filter((node) => node.type === type && Number(node.props.offset) === offset);

  it("carries the raised error itself when the module declares what it throws", () => {
    const { promise, nodes } = rejectsWith("Fault");
    const errorValue = promise.fields.get(CORO_ERROR_VALUE_FIELD)!;

    expect(storesAt(nodes, IR_STORE_FIELD, errorValue.offset)).toHaveLength(1);
  });

  it("carries no error value when the module declares nothing it throws", () => {
    const { promise, nodes } = rejectsWith(null);
    const errorValue = promise.fields.get(CORO_ERROR_VALUE_FIELD)!;

    expect(storesAt(nodes, IR_STORE_FIELD, errorValue.offset)).toEqual([]);
  });

  it("reports a rejection by the text the raised error names itself with", () => {
    const { promise, nodes } = rejectsWith("Fault");
    const error = promise.fields.get(CORO_ERROR_FIELD)!;

    const reported = storesAt(nodes, IR_STORE_TEXT, error.offset)[0]!;
    const spelled = reported.inputs[1]!;
    expect(spelled.type).toBe(IR_GENERIC_ADD);
    expect(spelled.inputs[0]!.props.value).toBe(ERROR_DISPLAY_PREFIX);
    expect(spelled.inputs[1]!.props.propName).toBe(ERROR_MESSAGE_FIELD);
  });

  it("resumes at one label per suspend and keeps the entry state", () => {
    const classes = table();
    const { resume } = split(suspending(classes, 3, true), classes);

    const states: number[] = [];
    let block = resume!.entry!;
    for (let terminator = block.getTerminator()!; terminator.type === IR_BRANCH; ) {
      states.push(Number(terminator.inputs[0]!.inputs[1]!.props.value));
      block = resume!.blocks.find((candidate) => candidate.id === terminator.props.falseBlock)!;
      terminator = block.getTerminator()!;
    }

    expect(states).toEqual([0, 1, 2]);
  });
});

describe("lowerAwaitedPromises", () => {
  function awaitingOutsideACoroutine(classes: ClassTable) {
    const graph = new CFGFunction("g");
    graph.classes = classes;
    graph.declaredSignature = { params: [], returns: "int" };
    const block = graph.addBlock();
    const promise = block.addNode(irConstant(1));
    const awaited = block.addNode(irAwait(promise));
    block.addNode(irReturn(awaited));
    graph.rebuildUses();
    return { graph, promise };
  }

  function lower(carries: string) {
    const classes = table();
    const shape = coroutinePromiseShape(classes, "f", carries);
    const { graph, promise } = awaitingOutsideACoroutine(classes);
    const lowered = lowerAwaitedPromises(graph, classes, (node) =>
      node === promise ? shape : null,
    );
    return { graph, classes, shape, lowered };
  }

  function branchOnPendingState(graph: CFGFunction, shape: ClassShape): CFGBlock | null {
    const offset = shape.fields.get(CORO_STATE_FIELD)!.offset;
    for (const block of graph.blocks) {
      const branch = block.nodes.find((node) => node.type === IR_BRANCH);
      if (branch === undefined) continue;
      const compare = branch.inputs[0]!;
      const state = compare.inputs[0];
      const against = compare.inputs[1];
      if (state?.props.offset !== offset) continue;
      if (against?.props.value !== CORO_STATE_PENDING) continue;
      return block.successors[0] ?? null;
    }
    return null;
  }

  it("stops instead of reading the value of a promise that is still pending", () => {
    const { graph, shape, lowered } = lower("int");

    expect(lowered).toBe(1);
    const stop = branchOnPendingState(graph, shape);
    expect(stop).not.toBeNull();
    const thrown = stop!.nodes.find((node) => node.type === IR_CALL_BUILTIN);
    expect(thrown?.inputs[0]?.props.value).toBe(TERA_NEVER_SETTLED);
  });

  it("leaves the lowered graph in SSA form", () => {
    const { graph } = lower("int");

    expect(validateGraphInvariants(graph)).toBe(true);
  });
});
