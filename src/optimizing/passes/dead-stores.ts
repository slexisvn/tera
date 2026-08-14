import * as ir from "../ir/index.js";
import { type ModRef } from "../analyses/mod-ref.js";
import { type PointsToResult } from "../analyses/points-to.js";
import {
  basesMayAlias,
  fieldOf,
  fieldsOverlap,
  locationKey,
  partitionKey,
  type Field,
  type Partition,
} from "../analyses/heap-model.js";
import { runSnapshotDataflow } from "../infra/snapshot-dataflow.js";
import { detachNode } from "../ir/graph-edit.js";

type StoreNode = ir.CFGInstruction;
type StoreGraph = ir.CFGFunction;

type MemoryLocation = {
  readonly key: string;
  readonly baseKey: string;
  readonly base: StoreNode | null;
  readonly partition: Partition;
  readonly field: Field;
  readonly visible: boolean;
};

type LocationUniverse = {
  readonly byKey: Map<string, MemoryLocation>;
  readonly byBase: Map<string, Set<string>>;
  readonly visibleKeys: Set<string>;
};

type LiveState = {
  readonly live: Set<string>;
};

export function deadStoreElimination(
  graph: StoreGraph,
  pointsTo: PointsToResult,
  modRef: ModRef,
): number {
  const universe = buildUniverse(graph, pointsTo);
  return runSnapshotDataflow(graph, {
    direction: "backward",
    empty: () => ({ live: new Set(universe.visibleKeys) }),
    clone: cloneState,
    meet: meetStates,
    equals: stateEquals,
    transfer: (block, output) => transferBlock(block, output, universe, pointsTo, modRef),
    rewrite: (block, output) => rewriteBlock(block, output, universe, pointsTo, modRef),
  });
}

function transferBlock(
  block: ir.CFGBlock,
  output: LiveState,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
  modRef: ModRef,
): LiveState {
  const state = cloneState(output);
  for (let index = block.nodes.length - 1; index >= 0; index--) {
    transferNode(state, block.nodes[index]!, universe, pointsTo, modRef);
  }
  return state;
}

function rewriteBlock(
  block: ir.CFGBlock,
  output: LiveState,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
  modRef: ModRef,
): number {
  const state = cloneState(output);
  const dead = new Set<StoreNode>();
  let eliminated = 0;

  for (let index = block.nodes.length - 1; index >= 0; index--) {
    const node = block.nodes[index]!;
    if (ir.isTrackedStore(node.type)) {
      const location = memoryLocation(node, pointsTo);
      if (location && !hasLiveAlias(state, location, universe, pointsTo)) {
        dead.add(node);
        eliminated++;
      }
      if (location) removeAliases(state, location, universe, pointsTo);
      continue;
    }
    transferNode(state, node, universe, pointsTo, modRef);
  }

  if (dead.size > 0) {
    for (const node of dead) detachNode(node);
    block.nodes = block.nodes.filter((node) => !dead.has(node));
  }

  return eliminated;
}

function transferNode(
  state: LiveState,
  node: StoreNode,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
  modRef: ModRef,
): void {
  if (ir.isTrackedLoad(node.type)) {
    const location = memoryLocation(node, pointsTo);
    if (location) addAliases(state, location, universe, pointsTo, true);
    return;
  }
  if (ir.isTrackedStore(node.type)) {
    const location = memoryLocation(node, pointsTo);
    if (location) removeAliases(state, location, universe, pointsTo);
    return;
  }
  if (node.type === ir.IR_RETURN) {
    for (const input of node.inputs) addBaseAliases(state, input, universe, pointsTo);
    return;
  }
  if (ir.isOpaquePropertyAccess(node.type)) {
    const location = memoryLocation(node, pointsTo);
    if (location) addAliases(state, location, universe, pointsTo, true);
  }
  if (modRef.killsEverything(node)) {
    for (const key of universe.visibleKeys) state.live.add(key);
    return;
  }
  for (const key of modRef.gref(node)) {
    if (universe.byKey.has(key)) state.live.add(key);
  }
  for (const key of modRef.gmod(node)) state.live.delete(key);
}

function buildUniverse(
  graph: StoreGraph,
  pointsTo: PointsToResult,
): LocationUniverse {
  const byKey = new Map<string, MemoryLocation>();
  const byBase = new Map<string, Set<string>>();
  const visibleKeys = new Set<string>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!ir.isTrackedLoad(node.type) && !ir.isTrackedStore(node.type)) continue;
      const location = memoryLocation(node, pointsTo);
      if (!location || byKey.has(location.key)) continue;
      byKey.set(location.key, location);
      let keys = byBase.get(location.baseKey);
      if (!keys) {
        keys = new Set();
        byBase.set(location.baseKey, keys);
      }
      keys.add(location.key);
      if (location.visible) visibleKeys.add(location.key);
    }
  }
  return { byKey, byBase, visibleKeys };
}

function memoryLocation(
  node: StoreNode,
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
      visible: true,
    };
  }
  const base = node.inputs[0];
  const field = fieldOf(node);
  if (!base || !field) return null;
  const partition = pointsTo.partitionOf(base);
  const baseKey = partitionKey(partition);
  const location = {
    key: locationKey(partition, field),
    baseKey,
    base,
    partition,
    field,
  };
  return {
    ...location,
    visible: isExternallyVisible(location, pointsTo),
  };
}

function addAliases(
  state: LiveState,
  location: MemoryLocation,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
  matchField: boolean,
): void {
  for (const key of aliasKeys(location, universe, pointsTo, matchField)) state.live.add(key);
}

function addBaseAliases(
  state: LiveState,
  base: StoreNode,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
): void {
  const partition = pointsTo.partitionOf(base);
  const location: MemoryLocation = {
    key: "",
    baseKey: partitionKey(partition),
    base,
    partition,
    field: { kind: "anyIndex" },
    visible: isExternallyVisible({ base, partition }, pointsTo),
  };
  addAliases(state, location, universe, pointsTo, false);
}

function removeAliases(
  state: LiveState,
  location: MemoryLocation,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
): void {
  for (const key of aliasKeys(location, universe, pointsTo, true)) state.live.delete(key);
}

function hasLiveAlias(
  state: LiveState,
  location: MemoryLocation,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
): boolean {
  for (const key of aliasKeys(location, universe, pointsTo, true)) {
    if (state.live.has(key)) return true;
  }
  return false;
}

function aliasKeys(
  location: MemoryLocation,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
  matchField: boolean,
): string[] {
  const out: string[] = [];
  for (const baseKey of candidateBaseKeys(location, universe, pointsTo)) {
    const keys = universe.byBase.get(baseKey);
    if (!keys) continue;
    for (const key of keys) {
      const other = universe.byKey.get(key);
      if (!other) continue;
      if (matchField && !fieldsOverlap(location.field, other.field)) continue;
      if (!basesMayAlias(location, other, pointsTo)) continue;
      out.push(key);
    }
  }
  return out;
}

function candidateBaseKeys(
  location: MemoryLocation,
  universe: LocationUniverse,
  pointsTo: PointsToResult,
): Set<string> {
  if (location.base === null || !isExternallyVisible(location, pointsTo)) {
    return new Set([location.baseKey]);
  }
  const visibleBaseKeys = new Set<string>();
  for (const key of universe.visibleKeys) {
    const visibleLocation = universe.byKey.get(key);
    if (visibleLocation) visibleBaseKeys.add(visibleLocation.baseKey);
  }
  visibleBaseKeys.add(location.baseKey);
  return visibleBaseKeys;
}

function isExternallyVisible(
  location: Pick<MemoryLocation, "base" | "partition">,
  pointsTo: PointsToResult,
): boolean {
  if (location.base === null) return true;
  return location.partition.kind !== "alloc" || pointsTo.escapes(location.base);
}

function cloneState(state: LiveState): LiveState {
  return { live: new Set(state.live) };
}

function meetStates(left: LiveState, right: LiveState): LiveState {
  return { live: new Set([...left.live, ...right.live]) };
}

function stateEquals(left: LiveState, right: LiveState): boolean {
  if (left.live.size !== right.live.size) return false;
  for (const key of left.live) {
    if (!right.live.has(key)) return false;
  }
  return true;
}
