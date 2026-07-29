import * as ir from "../ir/index.js";
import { computeDominators, buildDominatorTree } from "./dominators.js";
import { replaceGraphFrameStateValue } from "./frame-state-values.js";
import { detachNode } from "./graph-edit.js";

type LoadNode = ir.CFGInstruction;
type LoadBlock = ir.CFGBlock;
type LoadGraph = ir.CFGFunction;
type OffsetKey = ir.IRMetadataValue;
type ObjectState = Map<OffsetKey, LoadNode>;
type LoadState = Map<number, ObjectState>;

const CALL_LIKE = new Set([
  ir.IR_GENERIC_CALL,
  ir.IR_CALL_BUILTIN,
  ir.IR_CALL_KNOWN_FUNCTION,
]);

const ARBITRARY_WRITE = new Set([
  ir.IR_GENERIC_SET_PROP,
  ir.IR_GENERIC_SET_INDEX,
]);

function cloneState(state: LoadState): LoadState {
  const copy: LoadState = new Map();
  for (const [objId, offsets] of state) {
    copy.set(objId, new Map(offsets));
  }
  return copy;
}

function stateGet(
  state: LoadState,
  objId: number,
  offset: OffsetKey,
): LoadNode | undefined {
  const offsets = state.get(objId);
  return offsets ? offsets.get(offset) : undefined;
}

function stateSet(
  state: LoadState,
  objId: number,
  offset: OffsetKey,
  val: LoadNode,
): void {
  let offsets = state.get(objId);
  if (!offsets) {
    offsets = new Map();
    state.set(objId, offsets);
  }
  offsets.set(offset, val);
}

function stateDeleteObj(state: LoadState, objId: number): void {
  state.delete(objId);
}

export function loadElimination(graph: LoadGraph): number {
  const dominators = computeDominators(graph);
  const { children } = buildDominatorTree(graph, dominators);
  let eliminatedCount = 0;

  const freshAllocations = new Set<number>();
  const escapedAllocations = new Set<number>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === ir.IR_NEW_OBJECT || node.type === ir.IR_NEW_ARRAY) {
        freshAllocations.add(node.id);
      }
    }
  }
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (CALL_LIKE.has(node.type)) {
        for (const input of node.inputs) {
          if (input && freshAllocations.has(input.id)) {
            escapedAllocations.add(input.id);
          }
        }
      }
      if (ARBITRARY_WRITE.has(node.type)) {
        for (let i = 1; i < node.inputs.length; i++) {
          const input = node.inputs[i];
          if (input && freshAllocations.has(input.id)) {
            escapedAllocations.add(input.id);
          }
        }
      }
    }
  }

  const definiteNoAlias = (id1: number, id2: number): boolean => {
    if (id1 !== id2 && freshAllocations.has(id1) && freshAllocations.has(id2)) {
      return true;
    }
    return false;
  };

  const walkDomTree = (block: LoadBlock, parentState: LoadState): void => {
    const state = cloneState(parentState);
    const nodesToRemove: LoadNode[] = [];

    for (const node of block.nodes) {
      if (node.type === ir.IR_STORE_FIELD) {
        const obj = node.inputs[0];
        const val = node.inputs[1];
        const offset = node.props.offset;
        if (obj && val && offset !== undefined) {
          const objOffsets = state.get(obj.id);
          if (objOffsets) {
            objOffsets.delete(offset);
            if (objOffsets.size === 0) state.delete(obj.id);
          }
          for (const [oid, offsets] of [...state]) {
            if (oid === obj.id) continue;
            if (definiteNoAlias(oid, obj.id)) continue;
            if (freshAllocations.has(oid) || freshAllocations.has(obj.id)) {
              continue;
            }
            if (offsets.has(offset)) {
              offsets.delete(offset);
              if (offsets.size === 0) state.delete(oid);
            }
          }
          stateSet(state, obj.id, offset, val);
        }
        continue;
      }

      if (node.type === ir.IR_LOAD_FIELD) {
        const obj = node.inputs[0];
        const offset = node.props.offset;
        if (obj && offset !== undefined) {
          const available = stateGet(state, obj.id, offset);
          if (available) {
            for (const use of [...node.uses]) {
              for (let i = 0; i < use.inputs.length; i++) {
                if (use.inputs[i] === node) {
                  use.replaceInput(i, available);
                }
              }
            }
            replaceGraphFrameStateValue(graph, node, available);
            detachNode(node);
            nodesToRemove.push(node);
            eliminatedCount++;
          } else {
            stateSet(state, obj.id, offset, node);
          }
        }
        continue;
      }

      if (CALL_LIKE.has(node.type)) {
        if (node.props && node.props.pure) continue;
        for (const oid of [...state.keys()]) {
          if (freshAllocations.has(oid) && !escapedAllocations.has(oid)) {
            continue;
          }
          stateDeleteObj(state, oid);
        }
        continue;
      }

      if (ARBITRARY_WRITE.has(node.type)) {
        const obj = node.inputs[0];
        if (obj) {
          for (const key of [...state.keys()]) {
            if (!definiteNoAlias(key, obj.id)) {
              stateDeleteObj(state, key);
            }
          }
        } else {
          state.clear();
        }
        continue;
      }
    }

    if (nodesToRemove.length > 0) {
      const deadSet = new Set(nodesToRemove);
      block.nodes = block.nodes.filter((n) => !deadSet.has(n));
    }

    const childBlocks = (children.get(block) || []) as LoadBlock[];
    for (const child of childBlocks) {
      walkDomTree(child, state);
    }
  };

  const entry = graph.blocks[0];
  if (entry) {
    walkDomTree(entry, new Map());
  }

  return eliminatedCount;
}
