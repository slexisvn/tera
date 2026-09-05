import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  calleeNameOf,
  irConstant,
  irGenericCall,
  irLoadGlobal,
  irNewObject,
  irReturn,
  resetIRNodeIds,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { createCompilationUnit, createModuleIR } from "../../../src/optimizing/compilation-unit.js";
import { CLOSURE_CAPTURE_PROP } from "../../../src/optimizing/metadata/closure-conversion.js";
import { FUNCTION_TARGET_PROP } from "../../../src/optimizing/metadata/module-functions.js";
import { specializeFunctionArguments } from "../../../src/optimizing/passes/function-argument-specialization.js";

beforeEach(() => resetIRNodeIds());

const APPLY = "apply";
const PLAIN = "double";
const CLOSURE = "go";
const FRAME = "tera_closure$go";
const HANDED = "fn(int) -> int";

function applying(): CFGFunction {
  const graph = new CFGFunction(APPLY);
  graph.declaredSignature = { params: [HANDED, "int"], returns: "int" };
  const handed = graph.addParameter(0);
  const value = graph.addParameter(1);
  const block = graph.addBlock();
  block.addNode(irReturn(block.addNode(irGenericCall(handed, [value]))));
  graph.rebuildUses();
  return graph;
}

function takingOne(name: string, params: readonly string[]): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: [...params], returns: "int" };
  params.forEach((_, index) => graph.addParameter(index));
  const block = graph.addBlock();
  block.addNode(irReturn(block.addNode(irConstant(0))));
  graph.rebuildUses();
  return graph;
}

type Handed = "plain" | "closure";

function callerHanding(...handed: readonly Handed[]): CFGFunction {
  const graph = new CFGFunction("main");
  graph.declaredSignature = { params: [], returns: "int" };
  const block = graph.addBlock();
  let last: CFGInstruction | null = null;
  for (const kind of handed) {
    const argument =
      kind === "plain" ? block.addNode(irLoadGlobal(PLAIN)) : block.addNode(irNewObject());
    if (kind === "closure") {
      argument.props[FUNCTION_TARGET_PROP] = CLOSURE;
      argument.props[CLOSURE_CAPTURE_PROP] = true;
    }
    last = block.addNode(
      irGenericCall(block.addNode(irLoadGlobal(APPLY)), [argument, block.addNode(irConstant(1))]),
    );
  }
  block.addNode(irReturn(last!));
  graph.rebuildUses();
  return graph;
}

function specialized(...handed: readonly Handed[]) {
  const apply = applying();
  const module = createModuleIR(
    [
      callerHanding(...handed),
      apply,
      takingOne(PLAIN, ["int"]),
      takingOne(CLOSURE, [FRAME, "int"]),
    ].map((graph) => createCompilationUnit(graph)),
  );
  return { apply, ...specializeFunctionArguments(module) };
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const calleesIn = (graph: CFGFunction): (string | null)[] =>
  nodesOf(graph)
    .filter((node) => node.type === IR_CALL_KNOWN_FUNCTION || node.type === IR_GENERIC_CALL)
    .map((node) => calleeNameOf(node));

describe("specializing a function on the plain function handed to it", () => {
  it("clones the taker once for the function it was handed", () => {
    const { added } = specialized("plain");

    expect(added.map((unit) => unit.graph.name)).toEqual([`${APPLY}$${PLAIN}`]);
  });

  it("calls the handed function by name inside the clone", () => {
    const { added } = specialized("plain");

    expect(calleesIn(added[0]!.graph)).toEqual([PLAIN]);
  });

  it("drops the parameter the function arrived in, since the name says it all", () => {
    const { added } = specialized("plain");

    expect(added[0]!.graph.declaredSignature?.params).toEqual(["int"]);
    expect(added[0]!.graph.parameterCount).toBe(1);
  });
});

describe("specializing a function on a closure handed to it", () => {
  it("clones the taker for the closure the caller built", () => {
    const { added } = specialized("closure");

    expect(added.map((unit) => unit.graph.name)).toEqual([`${APPLY}$${CLOSURE}`]);
  });

  it("calls the closure body by name inside the clone", () => {
    const { added } = specialized("closure");

    expect(calleesIn(added[0]!.graph)).toEqual([CLOSURE]);
  });

  it("keeps the parameter, because the frame it carries is still needed", () => {
    const { added } = specialized("closure");

    expect(added[0]!.graph.parameterCount).toBe(2);
  });

  it("retypes that parameter as the frame the closure body reads", () => {
    const { added } = specialized("closure");

    expect(added[0]!.graph.declaredSignature?.params).toEqual([FRAME, "int"]);
  });

  it("hands the frame over as the first argument of the closure body", () => {
    const { added } = specialized("closure");
    const clone = added[0]!.graph;
    const call = nodesOf(clone).find((node) => node.type === IR_CALL_KNOWN_FUNCTION)!;

    expect(call.inputs).toHaveLength(2);
    expect(call.inputs[0]).toBe(clone.parameters[0]);
  });
});

describe("one taker handed both a plain function and a closure", () => {
  it("clones it once for each, keeping the parameter both need", () => {
    const { added } = specialized("plain", "closure");

    expect(added.map((unit) => unit.graph.name)).toEqual([
      `${APPLY}$${PLAIN}`,
      `${APPLY}$${CLOSURE}`,
    ]);
    expect(added.map((unit) => unit.graph.parameterCount)).toEqual([2, 2]);
  });

  it("retires the taker every caller was rewritten away from", () => {
    const { retired } = specialized("plain", "closure");

    expect([...retired]).toEqual([APPLY]);
  });
});

describe("what the specializer will not take on", () => {
  it("leaves a taker whose argument names neither a function nor a closure", () => {
    const apply = applying();
    const caller = new CFGFunction("main");
    const block = caller.addBlock();
    block.addNode(
      irReturn(
        block.addNode(
          irGenericCall(block.addNode(irLoadGlobal(APPLY)), [
            block.addNode(irNewObject()),
            block.addNode(irConstant(1)),
          ]),
        ),
      ),
    );
    caller.rebuildUses();
    const module = createModuleIR([caller, apply].map((graph) => createCompilationUnit(graph)));

    expect(specializeFunctionArguments(module).added).toEqual([]);
  });

  it("leaves a closure whose body the module does not carry", () => {
    const apply = applying();
    const module = createModuleIR(
      [callerHanding("closure"), apply].map((graph) => createCompilationUnit(graph)),
    );

    expect(specializeFunctionArguments(module).added).toEqual([]);
  });
});
