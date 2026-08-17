import { describe, it, expect } from "vitest";
import * as ir from "../../../src/optimizing/ir/index.js";
import {
  detachUsesOfAll,
  dropUse,
  replaceValueUses,
} from "../../../src/optimizing/ir/graph-edit.js";
import { addPhi, connect, disconnectAt } from "../../../src/optimizing/ir/cfg-edit.js";

function graphWithEntry(name: string): { graph: ir.CFGFunction; entry: ir.CFGBlock } {
  const graph = new ir.CFGFunction(name);
  const entry = graph.addBlock();
  return { graph, entry };
}

describe("def-use edge maintenance", () => {
  it("keeps one use entry per input edge when a value feeds a node twice", () => {
    const value = ir.irConstant(7);
    const doubled = ir.irInt32Add(value, value);

    expect(doubled.inputs).toEqual([value, value]);
    expect(value.uses).toEqual([doubled, doubled]);
  });

  it("removes only the replaced edge, leaving the surviving edge listed", () => {
    const value = ir.irConstant(7);
    const other = ir.irConstant(9);
    const doubled = ir.irInt32Add(value, value);

    doubled.replaceInput(0, other);

    expect(doubled.inputs).toEqual([other, value]);
    expect(value.uses).toEqual([doubled]);
    expect(other.uses).toEqual([doubled]);
  });

  it("empties the use list only once every edge has been replaced", () => {
    const value = ir.irConstant(7);
    const other = ir.irConstant(9);
    const doubled = ir.irInt32Add(value, value);

    doubled.replaceInput(0, other);
    doubled.replaceInput(1, other);

    expect(value.uses).toEqual([]);
    expect(other.uses).toEqual([doubled, doubled]);
  });

  it("rewrites every edge of a repeated operand through replaceValueUses", () => {
    const { graph } = graphWithEntry("repeated");
    const value = ir.irConstant(7);
    const other = ir.irConstant(9);
    const doubled = ir.irInt32Add(value, value);

    replaceValueUses(graph, value, other);

    expect(doubled.inputs).toEqual([other, other]);
    expect(value.uses).toEqual([]);
    expect(other.uses).toEqual([doubled, doubled]);
  });

  it("drops a single use entry rather than every occurrence", () => {
    const value = ir.irConstant(7);
    const doubled = ir.irInt32Add(value, value);

    dropUse(value, doubled);

    expect(value.uses).toEqual([doubled]);
  });

  it("keeps the remaining phi edge listed when one predecessor is disconnected", () => {
    const { graph } = graphWithEntry("phi-edges");
    const left = graph.addBlock();
    const right = graph.addBlock();
    const join = graph.addBlock();
    const value = ir.irConstant(7);

    const phi = addPhi(join);
    connect(left, join, [value]);
    connect(right, join, [value]);

    expect(phi.inputs).toEqual([value, value]);
    expect(value.uses).toEqual([phi, phi]);

    disconnectAt(join, 0);

    expect(phi.inputs).toEqual([value]);
    expect(value.uses).toEqual([phi]);
  });

  it("detaches a batch of nodes from a shared producer in one pass", () => {
    const producer = ir.irConstant(7);
    const first = ir.irInt32Add(producer, producer);
    const second = ir.irInt32Add(producer, producer);
    const survivor = ir.irInt32Add(producer, producer);

    expect(producer.uses).toHaveLength(6);

    detachUsesOfAll(new Set([first, second]));

    expect(producer.uses).toEqual([survivor, survivor]);
  });

  it("leaves the producer untouched when the dead set is empty", () => {
    const producer = ir.irConstant(7);
    const user = ir.irInt32Add(producer, producer);

    detachUsesOfAll(new Set());

    expect(producer.uses).toEqual([user, user]);
  });
});

describe("dependency deduplication", () => {
  it("records a dependency once no matter how often it is added", () => {
    const graph = new ir.CFGFunction("deps");

    graph.addDependency("map", 3, 1);
    graph.addDependency("map", 3, 1);
    graph.addDependency("map", 3, 1);

    expect(graph.dependencies).toEqual([{ kind: "map", id: 3, version: 1 }]);
  });

  it("separates dependencies that differ in kind, id, or version", () => {
    const graph = new ir.CFGFunction("deps");

    graph.addDependency("map", 3, 1);
    graph.addDependency("map", 3, 2);
    graph.addDependency("map", 4, 1);
    graph.addDependency("proto", 3, 1);
    graph.addDependency("map", 3);

    expect(graph.dependencies).toHaveLength(5);
  });
});
