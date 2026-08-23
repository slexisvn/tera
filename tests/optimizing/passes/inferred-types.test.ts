import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallKnownFunction,
  irConstant,
  irInt32Add,
  irReturn,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { adoptInferredTypes } from "../../../src/optimizing/passes/inferred-types.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";

beforeEach(() => resetIRNodeIds());

function adding(name = "add"): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: [null, null], names: ["a", "b"], returns: null };
  const left = graph.addParameter(0);
  const right = graph.addParameter(1);
  const block = graph.addBlock();
  block.addNode(irReturn(block.addNode(irInt32Add(left, right))));
  graph.rebuildUses();
  return graph;
}

function calling(callee: string, values: readonly (number | string)[]): CFGFunction {
  const graph = new CFGFunction("caller");
  graph.declaredSignature = { params: [], names: [], returns: "int" };
  const block = graph.addBlock();
  const args = values.map((value) => block.addNode(irConstant(value)));
  block.addNode(irReturn(block.addNode(irCallKnownFunction({ name: callee } as never, args))));
  graph.rebuildUses();
  return graph;
}

function adopt(graphs: readonly CFGFunction[]): void {
  const classes = buildClassTable([]);
  for (const graph of graphs) graph.classes = classes;
  adoptInferredTypes(moduleFromGraphs(graphs), classes);
}

describe("adopting parameter types from the call sites", () => {
  it("gives an undeclared parameter the type its caller passes", () => {
    const callee = adding();
    adopt([callee, calling("add", [3, 4])]);

    expect(callee.declaredSignature?.params).toEqual(["int", "int"]);
  });

  it("widens to the type that holds every caller", () => {
    const callee = adding();
    adopt([callee, calling("add", [3, 4]), calling("add", [2.5, 1])]);

    expect(callee.declaredSignature?.params[0]).toBe("float");
  });

  it("leaves a parameter undeclared when the callers disagree beyond numbers", () => {
    const callee = adding();
    adopt([callee, calling("add", [3, 4]), calling("add", ["a", 1])]);

    expect(callee.declaredSignature?.params[0]).toBeNull();
  });

  it("leaves a parameter undeclared when nobody calls the function", () => {
    const callee = adding();
    adopt([callee]);

    expect(callee.declaredSignature?.params).toEqual([null, null]);
  });

  it("keeps a type the source already declared", () => {
    const callee = adding();
    callee.declaredSignature = { params: ["float", null], names: ["a", "b"], returns: null };
    adopt([callee, calling("add", [3, 4])]);

    expect(callee.declaredSignature?.params).toEqual(["float", "int"]);
  });
});
