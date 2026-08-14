import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irAwait,
  irConstant,
  irInt32Add,
  irReturn,
  resetIRNodeIds,
  IR_BRANCH,
  IR_CALL_KNOWN_FUNCTION,
  IR_NEW_OBJECT,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
  textCapacityOf,
  type CFGBlock,
} from "../../../src/optimizing/ir/index.js";
import {
  splitCoroutine,
  type PromiseOf,
} from "../../../src/optimizing/passes/coroutines.js";
import {
  coroutineBaseShapes,
  coroutinePromiseShape,
  CORO_ERROR_FIELD,
  CORO_NEXT_FIELD,
  CORO_STATE_FIELD,
  CORO_STATE_REJECTED,
  CORO_VALUE_FIELD,
} from "../../../src/optimizing/metadata/coroutines.js";
import { recordPendingThrow, returnPendingThrow } from "../../../src/optimizing/builder/throw-recovery.js";
import {
  buildClassTable,
  referenceFieldOffsets,
  type ClassShape,
  type ClassTable,
} from "../../../src/optimizing/metadata/class-table.js";
import { TEXT_STORAGE_BYTES } from "../../../src/optimizing/types/scalar.js";
import { CLASS_DATA_MEMBER } from "../../../src/core/class-member.js";
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
  return splitCoroutine(graph, classes, 0, coroutinePromiseShape(classes, "f", "Box"), promiseOf);
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
    const { resume } = splitCoroutine(graph, classes, 0, promise, () => null);
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
    const { resume } = splitCoroutine(graph, classes, 0, promise, () => null);
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
