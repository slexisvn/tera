import type * as ir from "../../ir/index.js";

type AnyBlock = ir.CFGBlock;

export type StructuredLabel = { type: string; targetId: number | null };

export type MergeResolver = {
  find(trueBlockId: number, falseBlockId: number): number | null;
};

export function findLabelDepth(
  labelStack: readonly StructuredLabel[],
  type: string,
  targetId: number | null,
): number {
  for (let i = labelStack.length - 1; i >= 0; i--) {
    if (labelStack[i].type === type && labelStack[i].targetId === targetId) {
      return labelStack.length - 1 - i;
    }
  }
  return -1;
}

export function buildMergeResolver(
  order: AnyBlock[],
  orderIndex: Map<number, number>,
): MergeResolver {
  const blockCount = order.length;
  const syntheticExit = blockCount;
  const blockIdToNode = new Map<number, number>();
  const nodeToBlockId = new Map<number, number>();
  for (let i = 0; i < blockCount; i++) {
    blockIdToNode.set(order[i].id, i);
    nodeToBlockId.set(i, order[i].id);
  }

  const graph: number[][] = Array.from({ length: blockCount + 1 }, () => []);
  for (let i = 0; i < blockCount; i++) {
    const block = order[i];
    if (block.successors.length === 0) {
      graph[syntheticExit].push(i);
    }
    for (const pred of block.predecessors) {
      const predNode = blockIdToNode.get(pred.id);
      if (predNode !== undefined) graph[i].push(predNode);
    }
  }

  const state = computePostDominators(graph, syntheticExit);
  const depth = new Int32Array(blockCount + 1).fill(-1);
  depth[syntheticExit] = 0;

  const depthOf = (node: number): number => {
    const known = depth[node];
    if (known >= 0) return known;
    const parent = state.idom[node];
    if (parent < 0 || parent === node) return -1;
    const parentDepth = depthOf(parent);
    if (parentDepth < 0) return -1;
    depth[node] = parentDepth + 1;
    return depth[node];
  };

  for (let i = 0; i <= blockCount; i++) depthOf(i);

  const lca = (left: number, right: number): number => {
    let a = left;
    let b = right;
    let da = depthOf(a);
    let db = depthOf(b);
    while (a >= 0 && da > db) {
      a = state.idom[a];
      da--;
    }
    while (b >= 0 && db > da) {
      b = state.idom[b];
      db--;
    }
    while (a !== b && a >= 0 && b >= 0) {
      a = state.idom[a];
      b = state.idom[b];
    }
    return a === b ? a : -1;
  };

  return {
    find(trueBlockId, falseBlockId) {
      const trueNode = blockIdToNode.get(trueBlockId);
      const falseNode = blockIdToNode.get(falseBlockId);
      if (trueNode === undefined || falseNode === undefined) return null;
      const mergeNode = lca(trueNode, falseNode);
      if (mergeNode < 0 || mergeNode === syntheticExit) return null;
      const mergeBlockId = nodeToBlockId.get(mergeNode);
      if (mergeBlockId === undefined) return null;
      const minMergeIndex = Math.max(
        orderIndex.get(trueBlockId) ?? -1,
        orderIndex.get(falseBlockId) ?? -1,
      );
      const mergeIndex = orderIndex.get(mergeBlockId) ?? -1;
      if (
        mergeBlockId === trueBlockId ||
        mergeBlockId === falseBlockId ||
        mergeIndex <= minMergeIndex
      ) {
        return null;
      }
      return mergeBlockId;
    },
  };
}


function computePostDominators(
  graph: readonly number[][],
  start: number,
): { idom: Int32Array } {
  const size = graph.length;
  const semi = new Int32Array(size).fill(-1);
  const vertex: number[] = [-1];
  const parent = new Int32Array(size).fill(-1);
  const ancestor = new Int32Array(size).fill(-1);
  const label = new Int32Array(size);
  const idom = new Int32Array(size).fill(-1);
  const bucket: number[][] = Array.from({ length: size }, () => []);
  const preds: number[][] = Array.from({ length: size }, () => []);

  const dfs = (node: number): void => {
    semi[node] = vertex.length;
    vertex.push(node);
    label[node] = node;
    for (const succ of graph[node]) {
      if (semi[succ] < 0) {
        parent[succ] = node;
        dfs(succ);
      }
      preds[succ].push(node);
    }
  };

  const compress = (node: number): void => {
    const anc = ancestor[node];
    if (anc < 0 || ancestor[anc] < 0) return;
    compress(anc);
    if (semi[label[anc]] < semi[label[node]]) label[node] = label[anc];
    ancestor[node] = ancestor[anc];
  };

  const evalNode = (node: number): number => {
    if (ancestor[node] < 0) return label[node];
    compress(node);
    return label[node];
  };

  const linkNode = (parentNode: number, childNode: number): void => {
    ancestor[childNode] = parentNode;
  };

  dfs(start);

  for (let i = vertex.length - 1; i >= 2; i--) {
    const node = vertex[i];
    for (const pred of preds[node]) {
      const candidate = evalNode(pred);
      if (semi[candidate] < semi[node]) semi[node] = semi[candidate];
    }
    bucket[vertex[semi[node]]].push(node);
    linkNode(parent[node], node);
    const parentBucket = bucket[parent[node]];
    for (const bucketNode of parentBucket) {
      const candidate = evalNode(bucketNode);
      idom[bucketNode] =
        semi[candidate] < semi[bucketNode] ? candidate : parent[node];
    }
    parentBucket.length = 0;
  }

  for (let i = 2; i < vertex.length; i++) {
    const node = vertex[i];
    if (idom[node] !== vertex[semi[node]]) idom[node] = idom[idom[node]];
  }
  idom[start] = -1;
  return { idom };
}
