import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irGenericCall,
  irJump,
  irNewArray,
  irNewObject,
  irReturn,
  irStoreField,
  irCheckArray,
  irCheckElementsKind,
  irCheckMap,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry, pointsToAnalysisId } from "../../../src/optimizing/analyses/index.js";

beforeEach(() => resetIRNodeIds());

function pointsTo(graph: CFGFunction) {
  return new AnalysisManager(graph, createAnalysisRegistry()).get(pointsToAnalysisId);
}

describe("pointsToAnalysis", () => {
  it("proves two fresh allocations do not alias", () => {
    const graph = new CFGFunction("fresh");
    const block = graph.addBlock();
    const left = irNewObject();
    const right = irNewObject();
    block.addNode(left);
    block.addNode(right);
    block.addNode(irReturn(irConstant(0)));

    const result = pointsTo(graph);

    expect(result.mayAlias(left, right)).toBe(false);
  });

  it("marks an allocation escaping through a phi and call argument", () => {
    const graph = new CFGFunction("phiCall");
    const entry = graph.addBlock();
    const merge = graph.addBlock();
    const alloc = irNewObject();
    entry.addNode(alloc);
    entry.addNode(irJump(merge));
    link(entry, merge);
    const phi = addPhi(merge, [alloc]);
    const callee = irConstant("fn");
    merge.addNode(callee);
    merge.addNode(irGenericCall(callee, [phi]));
    merge.addNode(irReturn(irConstant(0)));

    const result = pointsTo(graph);

    expect(result.escapes(alloc)).toBe(true);
    expect(result.allocClassOf(phi)).toBe(alloc.id);
  });

  it("proves different map-guarded pointers do not alias", () => {
    const graph = new CFGFunction("maps");
    const block = graph.addBlock();
    const leftParam = graph.addParameter(0);
    const rightParam = graph.addParameter(1);
    const left = irCheckMap(leftParam, 1);
    const right = irCheckMap(rightParam, 2);
    block.addNode(left);
    block.addNode(right);
    block.addNode(irReturn(irConstant(0)));

    const result = pointsTo(graph);

    expect(result.mayAlias(left, right)).toBe(false);
  });

  it("proves an unescaped allocation cannot alias an unguarded parameter", () => {
    const graph = new CFGFunction("paramAlloc");
    const block = graph.addBlock();
    const param = graph.addParameter(0);
    const alloc = irNewObject();
    block.addNode(alloc);
    block.addNode(irReturn(irConstant(0)));

    const result = pointsTo(graph);

    expect(result.mayAlias(param, alloc)).toBe(false);
  });

  it("marks an allocation stored into another object field as escaping", () => {
    const graph = new CFGFunction("storeEscape");
    const block = graph.addBlock();
    const inner = irNewObject();
    const outer = irNewObject();
    block.addNode(inner);
    block.addNode(outer);
    block.addNode(irStoreField(outer, 0, inner));
    block.addNode(irReturn(irConstant(0)));

    const result = pointsTo(graph);

    expect(result.escapes(inner)).toBe(true);
    expect(result.escapes(outer)).toBe(false);
  });

  it("propagates escape through returned array elements", () => {
    const graph = new CFGFunction("arrayContainment");
    const block = graph.addBlock();
    const inner = irNewObject();
    const outer = irNewArray([inner]);
    block.addNode(inner);
    block.addNode(outer);
    block.addNode(irReturn(outer));

    const result = pointsTo(graph);

    expect(result.escapes(outer)).toBe(true);
    expect(result.escapes(inner)).toBe(true);
  });

  it("keeps array element-kind checks in the allocation class", () => {
    const graph = new CFGFunction("arrayKindGuard");
    const block = graph.addBlock();
    const value = irConstant(1);
    const array = irNewArray([value]);
    const checkedArray = irCheckArray(array);
    const checkedKind = irCheckElementsKind(checkedArray, "PACKED_SMI");
    block.addNode(value);
    block.addNode(array);
    block.addNode(checkedArray);
    block.addNode(checkedKind);
    block.addNode(irReturn(irConstant(0)));

    const result = pointsTo(graph);

    expect(result.allocClassOf(checkedKind)).toBe(array.id);
    expect(result.mayAlias(array, checkedKind)).toBe(true);
    expect(result.partitionOf(checkedKind)).toEqual({ kind: "alloc", site: array.id });
  });

  it("keeps a loop-carried allocation in the same class", () => {
    const graph = new CFGFunction("loopObject");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    const alloc = irNewObject();
    entry.addNode(alloc);
    entry.addNode(irJump(header));
    link(entry, header);

    const obj = addPhi(header, [alloc]);
    const cond = irConstant(1);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    link(header, body);
    link(header, exit);

    body.addNode(irJump(header));
    connect(body, header, [obj]);

    exit.addNode(irReturn(irConstant(0)));

    const result = pointsTo(graph);

    expect(result.escapes(alloc)).toBe(false);
    expect(result.allocClassOf(obj)).toBe(alloc.id);
  });
});
