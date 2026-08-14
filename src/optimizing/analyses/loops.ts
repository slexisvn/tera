import type { CFGBlock, CFGFunction } from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import { DominatorTree, dominanceAnalysisId } from "./dominance.js";

const LOOP_ANALYSIS_NAME = "loops";
const OUT_OF_ORDER_BLOCK = Number.MAX_SAFE_INTEGER;

type LoopDraft = {
  loop: Loop;
  header: CFGBlock;
  ownBlocks: Set<CFGBlock>;
  parent: LoopDraft | null;
  children: LoopDraft[];
};

export class Loop {
  readonly header: CFGBlock;
  readonly latches: readonly CFGBlock[];
  private parentValue: Loop | null = null;
  private childrenValue: readonly Loop[] = Object.freeze([]);
  private blocksValue: ReadonlySet<CFGBlock> = new Set();
  private exitingBlocksValue: readonly CFGBlock[] = Object.freeze([]);
  private exitBlocksValue: readonly CFGBlock[] = Object.freeze([]);
  private preheaderValue: CFGBlock | null = null;
  private depthValue = 0;

  constructor(header: CFGBlock, latches: readonly CFGBlock[]) {
    this.header = header;
    this.latches = Object.freeze([...latches]);
  }

  get parent(): Loop | null {
    return this.parentValue;
  }

  get children(): readonly Loop[] {
    return this.childrenValue;
  }

  get blocks(): ReadonlySet<CFGBlock> {
    return this.blocksValue;
  }

  get exitingBlocks(): readonly CFGBlock[] {
    return this.exitingBlocksValue;
  }

  get exitBlocks(): readonly CFGBlock[] {
    return this.exitBlocksValue;
  }

  get preheader(): CFGBlock | null {
    return this.preheaderValue;
  }

  get depth(): number {
    return this.depthValue;
  }

  setTopology(parent: Loop | null, children: readonly Loop[], depth: number): void {
    this.parentValue = parent;
    this.childrenValue = Object.freeze([...children]);
    this.depthValue = depth;
  }

  setBlocks(blocks: ReadonlySet<CFGBlock>): void {
    this.blocksValue = blocks;
  }

  setBoundaries(
    exitingBlocks: readonly CFGBlock[],
    exitBlocks: readonly CFGBlock[],
    preheader: CFGBlock | null,
  ): void {
    this.exitingBlocksValue = Object.freeze([...exitingBlocks]);
    this.exitBlocksValue = Object.freeze([...exitBlocks]);
    this.preheaderValue = preheader;
  }
}

export class LoopForest {
  readonly roots: readonly Loop[];
  readonly irreducible: boolean;
  private readonly blockLoop = new Map<CFGBlock, Loop>();
  private readonly preorder: readonly Loop[];

  constructor(graph: CFGFunction, dominators: DominatorTree) {
    const rpoIndex = blockOrderIndex(dominators.reversePostorder());
    const headerLatches = collectBackEdges(graph, dominators);
    this.irreducible = hasIrreducibleEdge(graph, dominators, rpoIndex);

    const innermostDraft = new Map<CFGBlock, LoopDraft>();
    const headerPostorder = dominatorTreePostorder(graph, dominators)
      .filter((block) => headerLatches.has(block));
    const drafts = discoverNaturalLoops(
      headerPostorder,
      headerLatches,
      innermostDraft,
    );
    const compareDrafts = (left: LoopDraft, right: LoopDraft) =>
      compareBlocks(left.header, right.header, rpoIndex);
    const roots = drafts
      .filter((draft) => draft.parent === null)
      .sort(compareDrafts);

    assignTopology(roots, null, LoopForest.rootDepth, compareDrafts);
    for (const root of roots) assignBlocks(root, compareDrafts);
    for (const draft of drafts) {
      const boundaries = deriveBoundaries(draft.loop, rpoIndex);
      draft.loop.setBoundaries(
        boundaries.exitingBlocks,
        boundaries.exitBlocks,
        boundaries.preheader,
      );
    }
    for (const [block, draft] of innermostDraft) {
      this.blockLoop.set(block, draft.loop);
    }

    this.roots = Object.freeze(roots.map((draft) => draft.loop));
    this.preorder = Object.freeze(preorderLoops(roots, compareDrafts));
  }

  loopOf(block: CFGBlock): Loop | null {
    return this.blockLoop.get(block) ?? null;
  }

  isHeader(block: CFGBlock): boolean {
    return this.loopOf(block)?.header === block;
  }

  contains(loop: Loop, block: CFGBlock): boolean {
    return loop.blocks.has(block);
  }

  loops(): Iterable<Loop> {
    return this.preorder;
  }

  depthOf(block: CFGBlock): number {
    return this.loopOf(block)?.depth ?? 0;
  }

  private static readonly rootDepth = 1;
}

function collectBackEdges(
  graph: CFGFunction,
  dominators: DominatorTree,
): Map<CFGBlock, CFGBlock[]> {
  const headerLatches = new Map<CFGBlock, CFGBlock[]>();
  for (const latch of graph.blocks) {
    for (const header of latch.successors) {
      if (!isBackEdge(dominators, latch, header)) continue;
      const latches = headerLatches.get(header);
      if (latches) {
        latches.push(latch);
      } else {
        headerLatches.set(header, [latch]);
      }
    }
  }
  return headerLatches;
}

function isBackEdge(
  dominators: DominatorTree,
  latch: CFGBlock,
  header: CFGBlock,
): boolean {
  return dominators.dominates(header, latch);
}

function hasIrreducibleEdge(
  graph: CFGFunction,
  dominators: DominatorTree,
  rpoIndex: ReadonlyMap<CFGBlock, number>,
): boolean {
  for (const block of graph.blocks) {
    const blockIndex = rpoIndex.get(block);
    if (blockIndex === undefined) continue;
    for (const successor of block.successors) {
      const successorIndex = rpoIndex.get(successor);
      if (successorIndex === undefined) continue;
      if (
        successorIndex <= blockIndex &&
        !isBackEdge(dominators, block, successor)
      ) {
        return true;
      }
    }
  }
  return false;
}

function discoverNaturalLoops(
  headers: readonly CFGBlock[],
  headerLatches: ReadonlyMap<CFGBlock, readonly CFGBlock[]>,
  innermost: Map<CFGBlock, LoopDraft>,
): LoopDraft[] {
  const drafts: LoopDraft[] = [];
  const unionParent = new Map<LoopDraft, LoopDraft>();

  const find = (draft: LoopDraft): LoopDraft => {
    const parent = unionParent.get(draft);
    if (!parent || parent === draft) return draft;
    const root = find(parent);
    unionParent.set(draft, root);
    return root;
  };

  const union = (child: LoopDraft, parent: LoopDraft): void => {
    unionParent.set(find(child), parent);
  };

  const adopt = (child: LoopDraft, parent: LoopDraft): void => {
    if (child.parent === parent) return;
    if (child.parent) {
      child.parent.children = child.parent.children.filter(
        (candidate) => candidate !== child,
      );
    }
    child.parent = parent;
    parent.children.push(child);
  };

  for (const header of headers) {
    const latches = headerLatches.get(header);
    if (!latches || latches.length === 0) continue;
    const draft: LoopDraft = {
      loop: new Loop(header, latches),
      header,
      ownBlocks: new Set([header]),
      parent: null,
      children: [],
    };
    drafts.push(draft);
    unionParent.set(draft, draft);
    innermost.set(header, draft);

    const worklist = [...latches];
    while (worklist.length > 0) {
      const block = worklist.pop()!;
      const subloop = innermost.get(block);
      if (!subloop) {
        innermost.set(block, draft);
        draft.ownBlocks.add(block);
        if (block !== header) {
          for (const predecessor of block.predecessors) worklist.push(predecessor);
        }
        continue;
      }
      const outer = find(subloop);
      if (outer === draft) continue;
      adopt(outer, draft);
      union(outer, draft);
      for (const predecessor of outer.header.predecessors) {
        worklist.push(predecessor);
      }
    }
  }

  return drafts;
}

function dominatorTreePostorder(
  graph: CFGFunction,
  dominators: DominatorTree,
): CFGBlock[] {
  const entry = graph.entry;
  if (!entry) return [];
  const postorder: CFGBlock[] = [];
  const stack: Array<{ block: CFGBlock; index: number }> = [
    { block: entry, index: 0 },
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const children = dominators.childrenOf(top.block);
    if (top.index < children.length) {
      stack.push({ block: children[top.index++]!, index: 0 });
    } else {
      postorder.push(top.block);
      stack.pop();
    }
  }
  return postorder;
}

function assignTopology(
  drafts: readonly LoopDraft[],
  parent: Loop | null,
  depth: number,
  compareDrafts: (left: LoopDraft, right: LoopDraft) => number,
): void {
  for (const draft of drafts) {
    draft.children.sort(compareDrafts);
    draft.loop.setTopology(
      parent,
      draft.children.map((child) => child.loop),
      depth,
    );
    assignTopology(draft.children, draft.loop, depth + 1, compareDrafts);
  }
}

function assignBlocks(
  draft: LoopDraft,
  compareDrafts: (left: LoopDraft, right: LoopDraft) => number,
): ReadonlySet<CFGBlock> {
  const blocks = new Set(draft.ownBlocks);
  draft.children.sort(compareDrafts);
  for (const child of draft.children) {
    for (const block of assignBlocks(child, compareDrafts)) blocks.add(block);
  }
  draft.loop.setBlocks(blocks);
  return blocks;
}

function deriveBoundaries(
  loop: Loop,
  rpoIndex: ReadonlyMap<CFGBlock, number>,
): {
  exitingBlocks: readonly CFGBlock[];
  exitBlocks: readonly CFGBlock[];
  preheader: CFGBlock | null;
} {
  const exitingBlocks: CFGBlock[] = [];
  const exitBlocks = new Set<CFGBlock>();
  for (const block of loop.blocks) {
    let exits = false;
    for (const successor of block.successors) {
      if (loop.blocks.has(successor)) continue;
      exits = true;
      exitBlocks.add(successor);
    }
    if (exits) exitingBlocks.push(block);
  }
  const externalPredecessors = loop.header.predecessors.filter(
    (predecessor) => !loop.blocks.has(predecessor),
  );
  const preheader =
    externalPredecessors.length === 1 &&
    externalPredecessors[0]!.successors.length === 1 &&
    externalPredecessors[0]!.successors[0] === loop.header
      ? externalPredecessors[0]!
      : null;
  return {
    exitingBlocks: sortBlocks(exitingBlocks, rpoIndex),
    exitBlocks: sortBlocks([...exitBlocks], rpoIndex),
    preheader,
  };
}

function preorderLoops(
  roots: readonly LoopDraft[],
  compareDrafts: (left: LoopDraft, right: LoopDraft) => number,
): Loop[] {
  const ordered: Loop[] = [];
  const stack = [...roots].sort(compareDrafts).reverse();
  while (stack.length > 0) {
    const draft = stack.pop()!;
    ordered.push(draft.loop);
    const children = [...draft.children].sort(compareDrafts).reverse();
    for (const child of children) stack.push(child);
  }
  return ordered;
}

function blockOrderIndex(blocks: readonly CFGBlock[]): Map<CFGBlock, number> {
  const index = new Map<CFGBlock, number>();
  for (let i = 0; i < blocks.length; i++) index.set(blocks[i]!, i);
  return index;
}

function sortBlocks(
  blocks: readonly CFGBlock[],
  rpoIndex: ReadonlyMap<CFGBlock, number>,
): readonly CFGBlock[] {
  return Object.freeze([...blocks].sort((left, right) =>
    compareBlocks(left, right, rpoIndex),
  ));
}

function compareBlocks(
  left: CFGBlock,
  right: CFGBlock,
  rpoIndex: ReadonlyMap<CFGBlock, number>,
): number {
  const leftOrder = rpoIndex.get(left) ?? OUT_OF_ORDER_BLOCK;
  const rightOrder = rpoIndex.get(right) ?? OUT_OF_ORDER_BLOCK;
  return leftOrder - rightOrder || left.id - right.id;
}

export const loopForestAnalysisId = analysisId<LoopForest>(LOOP_ANALYSIS_NAME);

export const loopForestAnalysis: AnalysisPass<CFGFunction, LoopForest> = {
  id: loopForestAnalysisId,
  run: (graph, analyses) =>
    new LoopForest(graph, analyses.get(dominanceAnalysisId)),
};
