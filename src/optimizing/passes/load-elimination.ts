import * as ir from "../ir/index.js";
import { type ModRef } from "../analyses/mod-ref.js";
import { type PointsToResult } from "../analyses/points-to.js";
import {
  fieldOf,
  fieldsOverlap,
  locationKey,
  partitionKey,
  type Field,
  type Partition,
} from "../analyses/heap-model.js";
import { runSnapshotDataflow } from "../infra/snapshot-dataflow.js";
import { detachNode, replaceValueUses } from "../ir/graph-edit.js";

type LoadNode = ir.CFGInstruction;
type LoadGraph = ir.CFGFunction;

type MemoryLocation = {
  readonly key: string;
  readonly baseKey: string;
  readonly base: LoadNode | null;
  readonly partition: Partition;
  readonly field: Field;
};

type MemoryEntry = MemoryLocation & {
  readonly value: LoadNode;
  readonly visible: boolean;
};

type MemoryState = {
  byLocation: Map<string, MemoryEntry>;
  byBase: Map<string, Set<string>>;
  visibleBaseKeys: Set<string>;
};

const LOADS = new Set([ir.IR_LOAD_FIELD, ir.IR_LOAD_ELEMENT, ir.IR_LOAD_GLOBAL]);
const STORES = new Set([ir.IR_STORE_FIELD, ir.IR_STORE_ELEMENT, ir.IR_STORE_GLOBAL]);
const GENERIC_BASE_ACCESSES = new Set([
  ir.IR_GENERIC_GET_PROP,
  ir.IR_GENERIC_SET_PROP,
  ir.IR_GENERIC_DELETE_PROP,
  ir.IR_GENERIC_GET_INDEX,
  ir.IR_GENERIC_SET_INDEX,
]);

export function loadElimination(
  graph: LoadGraph,
  pointsTo: PointsToResult,
  modRef: ModRef,
): number {
  return runSnapshotDataflow(graph, {
    empty: emptyState,
    clone: cloneState,
    meet: meetStates,
    equals: stateEquals,
    transfer: (block, input) => transferBlock(block, input, pointsTo, modRef),
    rewrite: (block, input) => rewriteBlock(graph, block, input, pointsTo, modRef),
  });
}

function transferBlock(
  block: ir.CFGBlock,
  input: MemoryState,
  pointsTo: PointsToResult,
  modRef: ModRef,
): MemoryState {
  const state = cloneState(input);
  for (const node of block.nodes) transferNode(state, node, pointsTo, modRef);
  return state;
}

function rewriteBlock(
  graph: LoadGraph,
  block: ir.CFGBlock,
  input: MemoryState,
  pointsTo: PointsToResult,
  modRef: ModRef,
): number {
  const state = cloneState(input);
  const removed = new Set<LoadNode>();
  let eliminated = 0;

  for (const node of block.nodes) {
    if (LOADS.has(node.type)) {
      const location = memoryLocation(node, pointsTo);
      const existing = location ? state.byLocation.get(location.key) : undefined;
      if (existing && existing.value !== node) {
        replaceValueUses(graph, node, existing.value);
        detachNode(node);
        removed.add(node);
        eliminated++;
        continue;
      }
      if (location) addLocation(state, location, node, pointsTo);
      continue;
    }
    transferNode(state, node, pointsTo, modRef);
  }

  if (removed.size > 0) block.nodes = block.nodes.filter((node) => !removed.has(node));
  return eliminated;
}

function transferNode(
  state: MemoryState,
  node: LoadNode,
  pointsTo: PointsToResult,
  modRef: ModRef,
): void {
  if (LOADS.has(node.type)) {
    const location = memoryLocation(node, pointsTo);
    if (location && !state.byLocation.has(location.key)) addLocation(state, location, node, pointsTo);
    return;
  }
  if (STORES.has(node.type)) {
    const location = memoryLocation(node, pointsTo);
    const value = storeValue(node);
    if (location && value) {
      killAliases(state, location, pointsTo);
      addLocation(state, location, value, pointsTo);
    }
    return;
  }
  if (GENERIC_BASE_ACCESSES.has(node.type)) {
    const location = memoryLocation(node, pointsTo);
    if (location) killAliases(state, location, pointsTo);
  }
  if (modRef.killsEverything(node)) {
    killVisible(state);
    return;
  }
  for (const key of modRef.gmod(node)) removeLocation(state, key);
}

function memoryLocation(
  node: LoadNode,
  pointsTo: PointsToResult,
): MemoryLocation | null {
  if (node.type === ir.IR_LOAD_GLOBAL || node.type === ir.IR_STORE_GLOBAL) {
    if (typeof node.props.name !== "string") return null;
    const partition: Partition = { kind: "global", name: node.props.name };
    const field: Field = { kind: "anyIndex" };
    const baseKey = partitionKey(partition);
    return {
      key: locationKey(partition, field),
      baseKey,
      base: null,
      partition,
      field,
    };
  }
  const base = node.inputs[0];
  const field = fieldOf(node);
  if (!base || !field) return null;
  const partition = pointsTo.partitionOf(base);
  const baseKey = partitionKey(partition);
  return {
    key: locationKey(partition, field),
    baseKey,
    base,
    partition,
    field,
  };
}

function storeValue(node: LoadNode): LoadNode | null {
  if (node.type === ir.IR_STORE_FIELD) return node.inputs[1] ?? null;
  if (node.type === ir.IR_STORE_ELEMENT) return node.inputs[2] ?? null;
  if (node.type === ir.IR_STORE_GLOBAL) return node.inputs[0] ?? null;
  return null;
}

function killAliases(
  state: MemoryState,
  location: MemoryLocation,
  pointsTo: PointsToResult,
): void {
  const candidates = candidateBaseKeys(state, location, pointsTo);
  for (const baseKey of candidates) {
    const keys = state.byBase.get(baseKey);
    if (!keys) continue;
    for (const key of [...keys]) {
      const entry = state.byLocation.get(key);
      if (!entry) continue;
      if (!fieldsOverlap(entry.field, location.field)) continue;
      if (!locationsMayAlias(entry, location, pointsTo)) continue;
      removeLocation(state, key);
    }
  }
}

function candidateBaseKeys(
  state: MemoryState,
  location: MemoryLocation,
  pointsTo: PointsToResult,
): Set<string> {
  if (location.base === null || !isExternallyVisible(location, pointsTo)) {
    return new Set([location.baseKey]);
  }
  return new Set([...state.visibleBaseKeys, location.baseKey]);
}

function locationsMayAlias(
  left: MemoryLocation,
  right: MemoryLocation,
  pointsTo: PointsToResult,
): boolean {
  if (left.base === null || right.base === null) return left.baseKey === right.baseKey;
  return pointsTo.mayAlias(left.base, right.base);
}

function addLocation(
  state: MemoryState,
  location: MemoryLocation,
  value: LoadNode,
  pointsTo: PointsToResult,
): void {
  removeLocation(state, location.key);
  const entry: MemoryEntry = { ...location, value, visible: isExternallyVisible(location, pointsTo) };
  state.byLocation.set(location.key, entry);
  let keys = state.byBase.get(location.baseKey);
  if (!keys) {
    keys = new Set();
    state.byBase.set(location.baseKey, keys);
  }
  keys.add(location.key);
  if (entry.visible) state.visibleBaseKeys.add(location.baseKey);
}

function removeLocation(state: MemoryState, key: string): void {
  const entry = state.byLocation.get(key);
  if (!entry) return;
  state.byLocation.delete(key);
  const keys = state.byBase.get(entry.baseKey);
  if (keys) {
    keys.delete(key);
    if (keys.size === 0) {
      state.byBase.delete(entry.baseKey);
      state.visibleBaseKeys.delete(entry.baseKey);
    }
  }
}

function killVisible(state: MemoryState): void {
  for (const baseKey of [...state.visibleBaseKeys]) {
    const keys = state.byBase.get(baseKey);
    if (!keys) continue;
    for (const key of [...keys]) removeLocation(state, key);
  }
}

function isExternallyVisible(
  location: MemoryLocation,
  pointsTo: PointsToResult,
): boolean {
  if (location.base === null) return true;
  return location.partition.kind !== "alloc" || pointsTo.escapes(location.base);
}

function emptyState(): MemoryState {
  return {
    byLocation: new Map(),
    byBase: new Map(),
    visibleBaseKeys: new Set(),
  };
}

function cloneState(state: MemoryState): MemoryState {
  const byBase = new Map<string, Set<string>>();
  for (const [base, keys] of state.byBase) byBase.set(base, new Set(keys));
  return {
    byLocation: new Map(state.byLocation),
    byBase,
    visibleBaseKeys: new Set(state.visibleBaseKeys),
  };
}

function meetStates(left: MemoryState, right: MemoryState): MemoryState {
  const out = emptyState();
  for (const [key, entry] of left.byLocation) {
    const other = right.byLocation.get(key);
    if (!other || !sameEntry(entry, other)) continue;
    addEntry(out, entry);
  }
  return out;
}

function stateEquals(left: MemoryState, right: MemoryState): boolean {
  if (left.byLocation.size !== right.byLocation.size) return false;
  for (const [key, entry] of left.byLocation) {
    const other = right.byLocation.get(key);
    if (!other || !sameEntry(entry, other)) return false;
  }
  return true;
}

function sameEntry(left: MemoryEntry, right: MemoryEntry): boolean {
  return left.value === right.value && left.base === right.base && left.key === right.key && left.visible === right.visible;
}

function addEntry(state: MemoryState, entry: MemoryEntry): void {
  state.byLocation.set(entry.key, entry);
  let keys = state.byBase.get(entry.baseKey);
  if (!keys) {
    keys = new Set();
    state.byBase.set(entry.baseKey, keys);
  }
  keys.add(entry.key);
  if (entry.visible) state.visibleBaseKeys.add(entry.baseKey);
}
