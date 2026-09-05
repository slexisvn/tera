import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericAdd,
  irNewArray,
  irReturn,
  irYield,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import { generatorYieldType } from "../../../src/optimizing/passes/generators.js";

beforeEach(() => resetIRNodeIds());

type Held = number | string | boolean | readonly number[] | readonly string[];

function yielding(...held: readonly Held[]): CFGFunction {
  const graph = new CFGFunction("gen");
  graph.isGenerator = true;
  graph.classes = buildClassTable([]);
  const block = graph.addBlock();
  for (const one of held) {
    const value: CFGInstruction = Array.isArray(one)
      ? block.addNode(irNewArray(one.map((element) => block.addNode(irConstant(element)))))
      : block.addNode(irConstant(one as number | string | boolean));
    block.addNode(irYield(value));
  }
  block.addNode(irReturn(block.addNode(irConstant(0))));
  graph.rebuildUses();
  return graph;
}

const yields = (graph: CFGFunction) => generatorYieldType(graph);

function elementOf(graph: CFGFunction, named: string): string | null {
  const shape = graph.classes!.shapeOf(named);
  return shape === null ? null : graph.classes!.arrayLayoutOf(shape)?.declaredType ?? null;
}

describe("naming what a generator yields", () => {
  it("names a generator yielding whole numbers", () => {
    expect(yields(yielding(1, 2))).toEqual({ yields: "int" });
  });

  it("widens a generator yielding whole and fractional numbers to the wider one", () => {
    expect(yields(yielding(1, 2.5))).toEqual({ yields: "float" });
  });

  it("names a generator yielding text", () => {
    expect(yields(yielding("a", "b"))).toEqual({ yields: "string" });
  });

  it("names a generator that yields whole arrays by the shape those arrays have", () => {
    const graph = yielding([1, 2], [3]);
    const answered = yields(graph) as { yields: string };

    expect(elementOf(graph, answered.yields)).toBe("int");
  });

  it("names an array of text the same way", () => {
    const graph = yielding(["a"], ["b", "c"]);
    const answered = yields(graph) as { yields: string };

    expect(elementOf(graph, answered.yields)).toBe("string");
  });

  it("names a generator that yields nothing at all", () => {
    const graph = new CFGFunction("gen");
    graph.isGenerator = true;
    graph.classes = buildClassTable([]);
    const block = graph.addBlock();
    block.addNode(irReturn(block.addNode(irConstant(0))));
    graph.rebuildUses();

    expect(yields(graph)).toEqual({ yields: "int" });
  });
});

describe("a generator whose yields do not agree", () => {
  it("refuses one that yields both a number and text", () => {
    expect(yields(yielding(1, "two"))).toHaveProperty("reason");
  });

  it("refuses one that yields both an array and a number", () => {
    const answered = yields(yielding([1, 2], 3));

    expect(answered).toHaveProperty("reason");
    expect(answered).not.toHaveProperty("yields");
  });

  it("names both types it could not join in the reason it gives", () => {
    const graph = yielding([1, 2], 3);
    const array = yields(yielding([1, 2])) as { yields: string };
    const answered = yields(graph) as { reason: string };

    expect(answered.reason).toContain(`yields both ${array.yields} and int`);
  });

  it("refuses one that yields arrays holding different things", () => {
    expect(yields(yielding([1], ["a"]))).toHaveProperty("reason");
  });
});

describe("what arithmetic over yielded values is named", () => {
  it("widens a sum of a whole and a fractional number", () => {
    const graph = new CFGFunction("gen");
    graph.isGenerator = true;
    graph.classes = buildClassTable([]);
    const block = graph.addBlock();
    const sum = block.addNode(
      irGenericAdd(block.addNode(irConstant(1)), block.addNode(irConstant(2.5))),
    );
    block.addNode(irYield(sum));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    graph.rebuildUses();

    expect(yields(graph)).toEqual({ yields: "float" });
  });

  it("refuses a sum the compiler cannot read as a number", () => {
    const graph = new CFGFunction("gen");
    graph.isGenerator = true;
    graph.classes = buildClassTable([]);
    const block = graph.addBlock();
    const array = block.addNode(irNewArray([block.addNode(irConstant(1))]));
    const sum = block.addNode(irGenericAdd(array, block.addNode(irConstant(1))));
    block.addNode(irYield(sum));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    graph.rebuildUses();

    expect(yields(graph)).toHaveProperty("reason");
  });
});
