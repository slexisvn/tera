import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irCallKnownFunction,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  IR_AWAIT,
  IR_BRANCH,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { lowerPromiseSurface } from "../../../src/optimizing/passes/promise-surface.js";
import {
  forwardsPendingThrow,
  isPendingThrowReturn,
  raisesPendingThrow,
} from "../../../src/optimizing/builder/throw-recovery.js";
import { PRINT_BUILTIN } from "../../../src/optimizing/metadata/builtin-methods.js";

beforeEach(() => resetIRNodeIds());

const PRODUCER = "load";
const CALLBACK = "handle";

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const ofType = (graph: CFGFunction, type: string): CFGInstruction[] =>
  nodesOf(graph).filter((node) => node.type === type);

function promiseMethodCall(
  block: CFGFunction["blocks"][number],
  member: string,
  args: readonly CFGInstruction[],
): CFGInstruction {
  const namespace = block.addNode(irLoadGlobal("Promise"));
  const callee = block.addNode(irGenericGetProp(namespace, member));
  const call = block.addNode(irGenericCall(callee, [namespace, ...args]));
  call.props.isMethod = true;
  return call;
}

describe("Promise.reject lowered to a function that rejects", () => {
  function rejecting(argCount: number) {
    const owner = new CFGFunction("main");
    const block = owner.addBlock();
    const args = Array.from({ length: argCount }, (_unused, index) =>
      block.addNode(irConstant(`boom${index}`)),
    );
    const call = promiseMethodCall(block, "reject", args);
    block.addNode(irReturn(call));
    owner.rebuildUses();
    return { owner, call, added: lowerPromiseSurface(moduleFromGraphs([owner])) };
  }

  it("mints one function to stand for the rejection", () => {
    const { added } = rejecting(1);

    expect(added).toHaveLength(1);
    expect(added[0]!.graph.isAsync).toBe(true);
  });

  it("calls that function where the generic call stood", () => {
    const { owner, added } = rejecting(1);

    expect(ofType(owner, IR_GENERIC_CALL)).toHaveLength(0);
    const call = ofType(owner, IR_CALL_KNOWN_FUNCTION)[0]!;
    expect(call.props.target).toBe(added[0]!.graph);
    expect(call.inputs[0]!.props.value).toBe("boom0");
  });

  it("makes the minted function raise what it was handed rather than answer it", () => {
    const { added } = rejecting(1);
    const graph = added[0]!.graph;

    expect(graph.recoversThrows).toBe(true);
    const stores = nodesOf(graph).filter((node) => forwardsPendingThrow(node));
    expect(stores).toHaveLength(1);
    expect(stores[0]!.inputs[1]).toBe(graph.parameters[0]);
    expect(nodesOf(graph).some((node) => raisesPendingThrow(node))).toBe(true);
  });

  it("returns the pending-throw status rather than a settled value", () => {
    const { added } = rejecting(1);
    const returns = ofType(added[0]!.graph, "Return");

    expect(returns).toHaveLength(1);
    expect(isPendingThrowReturn(returns[0]!)).toBe(true);
  });

  it("takes the declared type from the value it was handed", () => {
    const { added } = rejecting(1);

    expect(added[0]!.graph.declaredSignature).toEqual({ params: ["string"], returns: "string" });
  });

  it("leaves a rejection given the wrong argument count alone", () => {
    for (const argCount of [0, 2]) {
      const { owner, added } = rejecting(argCount);

      expect(added).toHaveLength(0);
      expect(ofType(owner, IR_GENERIC_CALL)).toHaveLength(1);
    }
  });
});

describe("a continuation on a producer that may throw", () => {
  function continuation(
    member: "then" | "catch",
    settle: (block: CFGFunction["blocks"][number]) => void,
    produces: string | null,
  ) {
    const produced = new CFGFunction(PRODUCER);
    produced.isAsync = true;
    produced.declaredSignature = { params: [], returns: produces };
    const producedBlock = produced.addBlock();
    settle(producedBlock);
    produced.rebuildUses();

    const callback = new CFGFunction(CALLBACK);
    callback.declaredSignature = { params: [null], returns: "int" };
    const callbackBlock = callback.addBlock();
    callback.addParameter(0);
    callbackBlock.addNode(irReturn(callbackBlock.addNode(irConstant(0))));
    callback.rebuildUses();

    const owner = new CFGFunction("main");
    const block = owner.addBlock();
    const producer = block.addNode(irCallKnownFunction({ name: PRODUCER }, []));
    const callee = block.addNode(irGenericGetProp(producer, member));
    const call = block.addNode(irGenericCall(callee, [producer, block.addNode(irLoadGlobal(CALLBACK))]));
    call.props.isMethod = true;
    block.addNode(irReturn(call));
    owner.rebuildUses();

    const added = lowerPromiseSurface(moduleFromGraphs([owner, produced, callback]));
    return { owner, added, callback };
  }

  const answersAnInt = (block: CFGFunction["blocks"][number]) => {
    block.addNode(irReturn(block.addNode(irConstant(7))));
  };

  const answersAVoidBuiltin = (block: CFGFunction["blocks"][number]) => {
    const printed = block.addNode(irCallBuiltin(PRINT_BUILTIN, [block.addNode(irConstant(7))]));
    block.addNode(irReturn(printed));
  };

  const answersUndefined = (block: CFGFunction["blocks"][number]) => {
    block.addNode(irReturn(block.addNode(irConstant(undefined))));
  };

  it("branches on a pending throw before handing the value to the callback", () => {
    const { added } = continuation("then", answersAnInt, "int");
    const graph = added[0]!.graph;

    expect(graph.recoversThrows).toBe(true);
    expect(ofType(graph, IR_BRANCH)).toHaveLength(1);
  });

  it("forwards the pending throw rather than calling the callback with it", () => {
    const { added } = continuation("then", answersAnInt, "int");
    const graph = added[0]!.graph;

    const forwarded = ofType(graph, "Return").filter((node) => isPendingThrowReturn(node));
    expect(forwarded).toHaveLength(1);
    const handed = ofType(graph, IR_CALL_KNOWN_FUNCTION).find(
      (node) => node.props.target !== undefined && (node.props.target as CFGFunction).name === CALLBACK,
    )!;
    expect(handed.block).not.toBe(forwarded[0]!.block);
    expect(handed.inputs[0]!.type).toBe(IR_AWAIT);
  });

  it("answers a caught producer with nothing when it only ever answers an absence", () => {
    const { added } = continuation("catch", answersUndefined, null);
    const graph = added[0]!.graph;

    const resumed = ofType(graph, "Return").find((node) => node.inputs[0]?.type === IR_CONSTANT);
    expect(resumed!.inputs[0]!.props.value).toBeUndefined();
  });

  it("reads a producer declared any by what it answers, not by the word any", () => {
    const { added } = continuation("catch", answersAVoidBuiltin, "any");
    const graph = added[0]!.graph;

    const awaited = ofType(graph, IR_AWAIT)[0]!;
    expect(ofType(graph, "Return").some((node) => node.inputs[0] === awaited)).toBe(false);
    const resumed = ofType(graph, "Return").find((node) => node.inputs[0]?.type === IR_CONSTANT);
    expect(resumed!.inputs[0]!.props.value).toBeUndefined();
  });

  it("answers a caught producer with the awaited value when it settles one", () => {
    const { added } = continuation("catch", answersAnInt, "int");
    const graph = added[0]!.graph;

    const awaited = ofType(graph, IR_AWAIT)[0]!;
    expect(ofType(graph, "Return").some((node) => node.inputs[0] === awaited)).toBe(true);
  });

  it("teaches the callback the type the producer settles", () => {
    const { callback } = continuation("then", answersAnInt, "int");

    expect(callback.declaredSignature!.params[0]).toBe("int");
  });
});
