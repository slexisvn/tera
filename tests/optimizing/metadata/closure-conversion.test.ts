import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericAdd,
  irLoadContextSlot,
  irMakeClosure,
  irReturn,
  irStoreContextSlot,
  resetIRNodeIds,
  IR_LOAD_CONTEXT_SLOT,
  IR_LOAD_FIELD,
  IR_MAKE_CLOSURE,
  IR_NEW_OBJECT,
  IR_STORE_CONTEXT_SLOT,
  IR_STORE_FIELD,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { createCompilationUnit, createModuleIR } from "../../../src/optimizing/compilation-unit.js";
import { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";
import { buildClassTable, type ClassTable } from "../../../src/optimizing/metadata/class-table.js";
import { convertClosures } from "../../../src/optimizing/metadata/closure-conversion.js";

beforeEach(() => resetIRNodeIds());

const MAKER = "make";
const CLOSURE = "go";
const CAPTURED = "captured";
const FRAME = `tera_closure$${CLOSURE}`;

function compiledFunction(name: string): RegisterCompiledFunction {
  return new RegisterCompiledFunction(name, 0);
}

function closureGraph(slots: readonly number[]): CFGFunction {
  const graph = new CFGFunction(CLOSURE);
  graph.declaredSignature = { params: [], returns: "int" };
  const block = graph.addBlock();
  const read = slots.map((slot) => block.addNode(irLoadContextSlot(slot, "upvalue")));
  const joined = read.reduce((carried, held) => block.addNode(irGenericAdd(carried, held)));
  block.addNode(irReturn(joined));
  graph.rebuildUses();
  return graph;
}

interface Built {
  readonly maker: CFGFunction;
  readonly closure: CFGFunction;
  readonly classes: ClassTable;
  readonly converted: number;
}

function converted(captures: readonly number[], slots = captures.map((_, at) => at)): Built {
  const inner = compiledFunction(CLOSURE);
  inner.upvalues = slots.map((slot) => ({
    name: `${CAPTURED}${slot}`,
    outerType: "local" as const,
    outerSlot: slot,
  }));
  const outer = compiledFunction(MAKER);
  outer.constants.push(inner);

  const maker = new CFGFunction(MAKER);
  maker.declaredSignature = { params: [], returns: "int" };
  const block = maker.addBlock();
  slots.forEach((slot, at) => {
    block.addNode(irStoreContextSlot(slot, block.addNode(irConstant(captures[at]!)), "local"));
  });
  const made = block.addNode(irMakeClosure(0, inner as never, []));
  block.addNode(irReturn(made));
  maker.rebuildUses();

  const closure = closureGraph(slots);
  const classes = buildClassTable([]);
  const module = createModuleIR([
    createCompilationUnit(maker, [], outer),
    createCompilationUnit(closure, [], inner),
  ]);
  return { maker, closure, classes, converted: convertClosures(module, classes) };
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const opcodesIn = (graph: CFGFunction): string[] => nodesOf(graph).map((node) => node.type);

const fieldNamesIn = (graph: CFGFunction, type: string): unknown[] =>
  nodesOf(graph)
    .filter((node) => node.type === type)
    .map((node) => node.props.propName);

describe("a closure over one value", () => {
  it("takes what it captured as its own first parameter", () => {
    const { closure } = converted([7]);

    expect(closure.parameterCount).toBe(1);
    expect(closure.declaredSignature?.params).toEqual(["int"]);
  });

  it("leaves no context slot for a backend to refuse", () => {
    const { maker, closure } = converted([7]);

    expect(opcodesIn(closure)).not.toContain(IR_LOAD_CONTEXT_SLOT);
    expect(opcodesIn(maker)).not.toContain(IR_STORE_CONTEXT_SLOT);
    expect(opcodesIn(maker)).not.toContain(IR_MAKE_CLOSURE);
  });

  it("hands the captured value over without building a frame for it", () => {
    const { maker, closure } = converted([7]);

    expect(opcodesIn(maker)).not.toContain(IR_NEW_OBJECT);
    expect(opcodesIn(closure)).not.toContain(IR_LOAD_FIELD);
  });
});

describe("a closure over more than one value", () => {
  it("takes one frame carrying every value it captured", () => {
    const { closure } = converted([1, 2]);

    expect(closure.parameterCount).toBe(1);
    expect(closure.declaredSignature?.params).toEqual([FRAME]);
  });

  it("names one field of that frame for every slot the closure reads", () => {
    const { classes } = converted([1, 2]);

    expect([...(classes.shapeOf(FRAME)?.fields.keys() ?? [])]).toEqual([
      `${CAPTURED}0`,
      `${CAPTURED}1`,
    ]);
  });

  it("builds the frame in the maker and stores every captured value into it", () => {
    const { maker } = converted([1, 2]);

    expect(opcodesIn(maker)).toContain(IR_NEW_OBJECT);
    expect(fieldNamesIn(maker, IR_STORE_FIELD)).toEqual([`${CAPTURED}0`, `${CAPTURED}1`]);
  });

  it("reads each captured value back off the frame inside the closure", () => {
    const { closure } = converted([1, 2]);

    expect(fieldNamesIn(closure, IR_LOAD_FIELD)).toEqual([`${CAPTURED}0`, `${CAPTURED}1`]);
    expect(opcodesIn(closure)).not.toContain(IR_LOAD_CONTEXT_SLOT);
  });

  it("carries the values in the order the slots were captured, not merged into one", () => {
    const { maker } = converted([1, 2]);
    const stored = nodesOf(maker)
      .filter((node) => node.type === IR_STORE_FIELD)
      .map((node) => node.inputs[1]!.props.value);

    expect(stored).toEqual([1, 2]);
  });

  it("gives the maker its own frame type as what it answers", () => {
    const { maker } = converted([1, 2]);

    expect(maker.declaredSignature?.returns).toBe(FRAME);
  });

  it("keeps a frame with three captures just as wide", () => {
    const { classes } = converted([1, 2, 3]);

    expect(classes.shapeOf(FRAME)?.fields.size).toBe(3);
  });
});

describe("what closure conversion leaves alone", () => {
  it("leaves a closure whose captured value it cannot name", () => {
    const inner = compiledFunction(CLOSURE);
    inner.upvalues = [{ name: CAPTURED, outerType: "upvalue", outerSlot: 0 }];
    const outer = compiledFunction(MAKER);
    outer.constants.push(inner);
    const maker = new CFGFunction(MAKER);
    const block = maker.addBlock();
    block.addNode(irReturn(block.addNode(irMakeClosure(0, inner as never, []))));
    maker.rebuildUses();
    const closure = closureGraph([0]);
    const module = createModuleIR([
      createCompilationUnit(maker, [], outer),
      createCompilationUnit(closure, [], inner),
    ]);

    expect(convertClosures(module, buildClassTable([]))).toBe(0);
    expect(opcodesIn(closure)).toContain(IR_LOAD_CONTEXT_SLOT);
  });

  it("leaves everything alone when the module carries no class table", () => {
    const module = createModuleIR([createCompilationUnit(new CFGFunction(MAKER))]);

    expect(convertClosures(module, null)).toBe(0);
  });
});
