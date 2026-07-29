import { describe, it, expect, beforeEach } from "vitest";
import {
  visitFrameStateValues,
  replaceGraphFrameStateValue,
  buildFrameStateIndex,
  clearFrameStateIndex,
  markFrameStateValues,
} from "../../src/optimizing/passes/frame-state-values.js";
import {
  CFGFunction,
  irConstant,
  irReturn,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

function makeFrameState(locals, stack, thisVal) {
  return {
    localValues: new Map(Object.entries(locals).map(([k, v]) => [Number(k), v])),
    stackValues: stack,
    thisValue: thisVal,
    callerFrameState: null,
  };
}

describe("visitFrameStateValues", () => {
  it("visits locals, stack, and thisValue with replacement callbacks", () => {
    const a = irConstant(1);
    const b = irConstant(2);
    const c = irConstant(3);
    const fs = makeFrameState({ 0: a }, [b], c);

    const visited = [];
    visitFrameStateValues(fs, (value) => visited.push(value));

    expect(visited).toContain(a);
    expect(visited).toContain(b);
    expect(visited).toContain(c);
    expect(visited).toHaveLength(3);
  });

  it("replacement callback actually replaces values in frame state", () => {
    const old = irConstant(1);
    const replacement = irConstant(999);
    const fs = makeFrameState({ 0: old }, [old], old);

    visitFrameStateValues(fs, (value, replace) => {
      if (value === old) replace(replacement);
    });

    expect(fs.localValues.get(0)).toBe(replacement);
    expect(fs.stackValues[0]).toBe(replacement);
    expect(fs.thisValue).toBe(replacement);
  });

  it("recursively visits callerFrameState", () => {
    const a = irConstant(1);
    const b = irConstant(2);
    const inner = makeFrameState({}, [b], irConstant(0));
    const outer = makeFrameState({ 0: a }, [], irConstant(0));
    outer.callerFrameState = inner;

    const visited = [];
    visitFrameStateValues(outer, (value) => visited.push(value));

    expect(visited).toContain(a);
    expect(visited).toContain(b);
  });

  it("does not infinite-loop on circular callerFrameState", () => {
    const a = irConstant(1);
    const fs = makeFrameState({ 0: a }, [], irConstant(0));
    fs.callerFrameState = fs;

    const visited = [];
    visitFrameStateValues(fs, (value) => visited.push(value));
    expect(visited.length).toBeGreaterThan(0);
  });
});

describe("replaceGraphFrameStateValue", () => {
  it("replaces old node with new node across all frame states in graph", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const oldNode = irConstant(1);
    const newNode = irConstant(2);
    block.addNode(oldNode);
    const ret = irReturn(oldNode);
    ret.frameState = makeFrameState({ 0: oldNode }, [oldNode], irConstant(0));
    block.addNode(ret);

    replaceGraphFrameStateValue(graph, oldNode, newNode);

    expect(ret.frameState.localValues.get(0)).toBe(newNode);
    expect(ret.frameState.stackValues[0]).toBe(newNode);
  });

  it("uses indexed fast path when _frameStateIndex is built", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const oldNode = irConstant(1);
    const newNode = irConstant(2);
    block.addNode(oldNode);
    const ret = irReturn(oldNode);
    ret.frameState = makeFrameState({ 0: oldNode }, [], irConstant(0));
    block.addNode(ret);

    buildFrameStateIndex(graph);
    expect(graph._frameStateIndex).toBeDefined();

    replaceGraphFrameStateValue(graph, oldNode, newNode);

    expect(ret.frameState.localValues.get(0)).toBe(newNode);
    expect(graph._frameStateIndex.has(oldNode)).toBe(false);
    expect(graph._frameStateIndex.has(newNode)).toBe(true);
  });
});

describe("buildFrameStateIndex / clearFrameStateIndex", () => {
  it("builds index mapping node → replacement locations, clearFrameStateIndex nulls it", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const node = irConstant(5);
    block.addNode(node);
    const ret = irReturn(node);
    ret.frameState = makeFrameState({ 0: node }, [node], node);
    block.addNode(ret);

    buildFrameStateIndex(graph);
    const locs = graph._frameStateIndex.get(node);
    expect(locs.length).toBe(3);

    clearFrameStateIndex(graph);
    expect(graph._frameStateIndex).toBeNull();
  });
});

describe("markFrameStateValues", () => {
  it("adds frame state values to liveNodes set and worklist", () => {
    const a = irConstant(1);
    const b = irConstant(2);
    const thisVal = irConstant(3);
    const fs = makeFrameState({ 0: a }, [b], thisVal);

    const liveNodes = new Set();
    const worklist = [];
    markFrameStateValues(fs, liveNodes, worklist);

    expect(liveNodes.has(a.id)).toBe(true);
    expect(liveNodes.has(b.id)).toBe(true);
    expect(liveNodes.has(thisVal.id)).toBe(true);
    expect(worklist).toContain(a);
    expect(worklist).toContain(b);
    expect(worklist).toContain(thisVal);
  });

  it("does not add already-live nodes again", () => {
    const a = irConstant(1);
    const fs = makeFrameState({ 0: a }, [a], irConstant(0));

    const liveNodes = new Set([a.id]);
    const worklist = [];
    markFrameStateValues(fs, liveNodes, worklist);

    expect(worklist.filter(n => n === a)).toHaveLength(0);
  });
});
