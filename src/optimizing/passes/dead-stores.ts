import * as ir from "../ir/index.js";
import { computeDominators, buildDominatorTree } from "./dominators.js";
import { detachNode } from "./graph-edit.js";

type StoreNode = ir.CFGInstruction;
type StoreBlock = ir.CFGBlock;
type StoreGraph = ir.CFGFunction;

type StoreKey = string;
type AccessKind = "store" | "load";

function storeKey(node: StoreNode): StoreKey {
  return `${node.inputs[0]!.id}:${String(node.props.offset)}`;
}

function removeDeadNodes(block: StoreBlock, deadNodes: Set<StoreNode>): void {
  if (deadNodes.size === 0) return;
  for (const node of deadNodes) detachNode(node);
  block.nodes = block.nodes.filter((node) => !deadNodes.has(node));
}

export function deadStoreElimination(graph: StoreGraph): number {
  let eliminatedCount = 0;

  for (const block of graph.blocks) {
    const lastStore = new Map<StoreKey, StoreNode>();
    const deadStores = new Set<StoreNode>();

    for (const node of block.nodes) {
      if (node.type === ir.IR_STORE_FIELD && node.inputs[0]) {
        const key = storeKey(node);
        const prev = lastStore.get(key);
        if (prev) {
          deadStores.add(prev);
          eliminatedCount++;
        }
        lastStore.set(key, node);
        continue;
      }

      if (node.type === ir.IR_LOAD_FIELD && node.inputs[0]) {
        lastStore.delete(storeKey(node));
        continue;
      }

      if (
        node.type === ir.IR_GENERIC_CALL ||
        node.type === ir.IR_CALL_BUILTIN ||
        node.type === ir.IR_RETURN
      ) {
        lastStore.clear();
        continue;
      }
    }

    removeDeadNodes(block, deadStores);
  }

  const dominators = computeDominators(graph);
  buildDominatorTree(graph, dominators);

  const blockStores = new Map<number, Map<StoreKey, StoreNode>>();
  const blockLoads = new Map<number, Set<StoreKey>>();
  const blockCalls = new Map<number, boolean>();
  const blockFirstAccess = new Map<number, Map<StoreKey, AccessKind>>();
  const blockFirstStoreIndex = new Map<number, Map<StoreKey, number>>();
  const blockFirstCallIndex = new Map<number, number>();

  for (const block of graph.blocks) {
    const stores = new Map<StoreKey, StoreNode>();
    const loads = new Set<StoreKey>();
    const firstAccess = new Map<StoreKey, AccessKind>();
    const firstStoreIndex = new Map<StoreKey, number>();
    let firstCallIndex = Infinity;
    let hasCalls = false;

    for (let idx = 0; idx < block.nodes.length; idx++) {
      const node = block.nodes[idx]!;
      if (node.type === ir.IR_STORE_FIELD && node.inputs[0]) {
        const key = storeKey(node);
        stores.set(key, node);
        if (!firstAccess.has(key)) firstAccess.set(key, "store");
        if (!firstStoreIndex.has(key)) firstStoreIndex.set(key, idx);
      } else if (node.type === ir.IR_LOAD_FIELD && node.inputs[0]) {
        const key = storeKey(node);
        loads.add(key);
        if (!firstAccess.has(key)) firstAccess.set(key, "load");
      } else if (
        node.type === ir.IR_GENERIC_CALL ||
        node.type === ir.IR_CALL_BUILTIN ||
        node.type === ir.IR_RETURN
      ) {
        hasCalls = true;
        if (firstCallIndex === Infinity) firstCallIndex = idx;
      }
    }

    blockStores.set(block.id, stores);
    blockLoads.set(block.id, loads);
    blockCalls.set(block.id, hasCalls);
    blockFirstAccess.set(block.id, firstAccess);
    blockFirstStoreIndex.set(block.id, firstStoreIndex);
    blockFirstCallIndex.set(block.id, firstCallIndex);
  }

  const crossBlockDead = new Set<StoreNode>();

  for (const block of graph.blocks) {
    const stores = blockStores.get(block.id);
    if (!stores || stores.size === 0) continue;

    for (const [key, storeNode] of stores) {
      const loads = blockLoads.get(block.id);
      if (loads && loads.has(key)) continue;
      if (blockCalls.get(block.id)) continue;

      if (block.successors.length === 0) continue;

      let allSuccessorsOverwrite = true;
      for (const succ of block.successors) {
        const succStores = blockStores.get(succ.id);
        const succLoads = blockLoads.get(succ.id);

        if (succLoads && succLoads.has(key)) {
          const storeBeforeLoad =
            blockFirstAccess.get(succ.id)?.get(key) === "store";
          if (!storeBeforeLoad) {
            allSuccessorsOverwrite = false;
            break;
          }
        } else if (!succStores || !succStores.has(key)) {
          allSuccessorsOverwrite = false;
          break;
        }

        if (blockCalls.get(succ.id)) {
          const succFirstStore = blockFirstStoreIndex.get(succ.id);
          const storeIdx = succFirstStore?.has(key)
            ? succFirstStore.get(key)!
            : Infinity;
          const callBeforeStore = blockFirstCallIndex.get(succ.id)! < storeIdx;
          if (callBeforeStore) {
            allSuccessorsOverwrite = false;
            break;
          }
        }
      }

      if (allSuccessorsOverwrite) {
        crossBlockDead.add(storeNode);
        eliminatedCount++;
      }
    }
  }

  if (crossBlockDead.size > 0) {
    for (const block of graph.blocks) {
      const blockDead = new Set<StoreNode>();
      for (const node of block.nodes) {
        if (crossBlockDead.has(node)) blockDead.add(node);
      }
      removeDeadNodes(block, blockDead);
    }
  }

  return eliminatedCount;
}
