import * as ir from "../ir/index.js";
import { detachNode, replaceValueUses } from "../ir/graph-edit.js";
import { runSnapshotDataflow } from "../infra/snapshot-dataflow.js";

type IntrinsicNode = ir.CFGInstruction;
type IntrinsicBlock = ir.CFGBlock;
type IntrinsicGraph = ir.CFGFunction;
type AvailableEntry = {
  node: IntrinsicNode;
  reads: readonly string[] | null;
};
type AvailableState = {
  entries: Map<string, AvailableEntry>;
  domainIndex: Map<string, Set<string>>;
  unknownKeys: Set<string>;
};
type MaybeAvailableState = AvailableState | null;

export function commonSubexpressionIntrinsicReads(graph: IntrinsicGraph): number {
  return runSnapshotDataflow(graph, {
    empty: emptyState,
    clone: cloneState,
    meet: intersectStates,
    equals: stateEquals,
    transfer: transferBlock,
    rewrite: (block, state) => rewriteBlock(graph, block, state),
  });
}

function transferBlock(block: IntrinsicBlock, input: AvailableState): AvailableState {
  const state = cloneState(input);
  for (const node of block.nodes) {
    if (isCseEligibleIntrinsicRead(node)) {
      const key = intrinsicKey(node);
      const existing = state.entries.get(key);
      if (!existing) addEntry(state, key, node, intrinsicReadDomains(node));
      continue;
    }
    applyBarrier(state, node);
  }
  return state;
}

function rewriteBlock(graph: IntrinsicGraph, block: IntrinsicBlock, input: AvailableState): number {
  let eliminated = 0;
  const state = cloneState(input);
  const removed = new Set<IntrinsicNode>();

  for (const node of block.nodes) {
    if (isCseEligibleIntrinsicRead(node)) {
      const key = intrinsicKey(node);
      const existing = state.entries.get(key);
      if (existing && existing.node !== node) {
        replaceValueUses(graph, node, existing.node);
        detachNode(node);
        removed.add(node);
        eliminated++;
        continue;
      }
      if (!existing) addEntry(state, key, node, intrinsicReadDomains(node));
      continue;
    }
    applyBarrier(state, node);
  }

  if (removed.size > 0) block.nodes = block.nodes.filter((node) => !removed.has(node));
  return eliminated;
}

function meetPredecessors(
  block: IntrinsicBlock,
  outStates: ReadonlyMap<IntrinsicBlock, MaybeAvailableState>,
  reachable: ReadonlySet<IntrinsicBlock>,
): MaybeAvailableState {
  let merged: MaybeAvailableState = null;
  let sawKnown = false;

  for (const predecessor of block.predecessors) {
    if (!reachable.has(predecessor)) continue;
    const predecessorOut = outStates.get(predecessor) ?? null;
    if (!predecessorOut) continue;
    sawKnown = true;
    merged = merged === null ? cloneState(predecessorOut) : intersectStates(merged, predecessorOut);
  }

  return sawKnown ? (merged ?? emptyState()) : null;
}

function cloneState(state: AvailableState): AvailableState {
  return {
    entries: new Map(state.entries),
    domainIndex: cloneDomainIndex(state.domainIndex),
    unknownKeys: new Set(state.unknownKeys),
  };
}

function intersectStates(left: AvailableState, right: AvailableState): AvailableState {
  const out = emptyState();
  for (const [key, entry] of left.entries) {
    const other = right.entries.get(key);
    if (!other || other.node !== entry.node) continue;
    if (!sameDomains(entry.reads, other.reads)) continue;
    addEntry(out, key, entry.node, entry.reads);
  }
  return out;
}

function stateEquals(left: AvailableState, right: AvailableState): boolean {
  if (left.entries.size !== right.entries.size) return false;
  for (const [key, entry] of left.entries) {
    const other = right.entries.get(key);
    if (!other || other.node !== entry.node || !sameDomains(entry.reads, other.reads)) return false;
  }
  return true;
}

function isReactiveReadIntrinsic(node: IntrinsicNode): boolean {
  if (node.type !== ir.IR_CALL_INTRINSIC) return false;
  const effects = node.props.intrinsicEffects;
  return Array.isArray(effects) && effects.length === 1 && effects[0] === "reactive-read";
}

function isCseEligibleIntrinsicRead(node: IntrinsicNode): boolean {
  return node.type === ir.IR_CALL_INTRINSIC && (node.effectKind === ir.EFFECT_READ || isReactiveReadIntrinsic(node));
}

function applyBarrier(state: AvailableState, node: IntrinsicNode): void {
  if (node.effectKind === ir.EFFECT_CALL) {
    clearState(state);
    return;
  }
  if (node.effectKind !== ir.EFFECT_WRITE) return;
  const writes = intrinsicWriteDomains(node);
  if (!writes) {
    clearState(state);
    return;
  }
  invalidateUnknown(state);
  for (const domain of writes) invalidateDomain(state, domain);
}

function intrinsicKey(node: IntrinsicNode): string {
  let key = String(node.props.name);
  for (const input of node.inputs) key += `|${inputKey(input)}`;
  return key;
}

function inputKey(input: IntrinsicNode): string {
  if (input.type === ir.IR_LOAD_GLOBAL) return `global:${String(input.props.name)}`;
  if (input.type === ir.IR_CONSTANT && isPrimitiveKey(input.props.value)) {
    return `const:${typeof input.props.value}:${String(input.props.value)}`;
  }
  return `node:${input.id}`;
}

function isPrimitiveKey(value: ir.IRMetadataValue): boolean {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function emptyState(): AvailableState {
  return {
    entries: new Map(),
    domainIndex: new Map(),
    unknownKeys: new Set(),
  };
}

function intrinsicReadDomains(node: IntrinsicNode): readonly string[] | null {
  return stringArrayMetadata(node.props.intrinsicReads);
}

function intrinsicWriteDomains(node: IntrinsicNode): readonly string[] | null {
  return stringArrayMetadata(node.props.intrinsicWrites);
}

function stringArrayMetadata(value: ir.IRMetadataValue | undefined): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : null;
}

function sameDomains(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function addEntry(state: AvailableState, key: string, node: IntrinsicNode, reads: readonly string[] | null): void {
  state.entries.set(key, { node, reads });
  if (!reads) {
    state.unknownKeys.add(key);
    return;
  }
  for (const domain of reads) {
    let keys = state.domainIndex.get(domain);
    if (!keys) {
      keys = new Set();
      state.domainIndex.set(domain, keys);
    }
    keys.add(key);
  }
}

function removeEntry(state: AvailableState, key: string): void {
  const entry = state.entries.get(key);
  if (!entry) return;
  state.entries.delete(key);
  if (!entry.reads) {
    state.unknownKeys.delete(key);
    return;
  }
  for (const domain of entry.reads) {
    const keys = state.domainIndex.get(domain);
    if (!keys) continue;
    keys.delete(key);
    if (keys.size === 0) state.domainIndex.delete(domain);
  }
}

function clearState(state: AvailableState): void {
  state.entries.clear();
  state.domainIndex.clear();
  state.unknownKeys.clear();
}

function invalidateUnknown(state: AvailableState): void {
  for (const key of [...state.unknownKeys]) removeEntry(state, key);
}

function invalidateDomain(state: AvailableState, domain: string): void {
  const keys = state.domainIndex.get(domain);
  if (!keys) return;
  for (const key of [...keys]) removeEntry(state, key);
}

function cloneDomainIndex(index: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [domain, keys] of index) out.set(domain, new Set(keys));
  return out;
}
