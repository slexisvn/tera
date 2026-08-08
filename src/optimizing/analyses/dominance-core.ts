export type DominatorBlock = {
  successors: DominatorBlock[];
  predecessors: DominatorBlock[];
};

export type DominatorGraph = {
  entry: DominatorBlock | null;
  blocks: DominatorBlock[];
};

export function computeDominators(
  graph: DominatorGraph,
): Map<DominatorBlock, DominatorBlock> {
  const idom = new Map<DominatorBlock, DominatorBlock>();
  const entry = graph.entry;
  if (!entry) return idom;

  const postorder: DominatorBlock[] = [];
  const visited = new Set([entry]);
  const stack = [{ block: entry, i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.i < top.block.successors.length) {
      const succ = top.block.successors[top.i++];
      if (!visited.has(succ)) {
        visited.add(succ);
        stack.push({ block: succ, i: 0 });
      }
    } else {
      postorder.push(top.block);
      stack.pop();
    }
  }

  const postNum = new Map<DominatorBlock, number>();
  for (let i = 0; i < postorder.length; i++) postNum.set(postorder[i]!, i);

  idom.set(entry, entry);

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = postorder.length - 1; i >= 0; i--) {
      const b = postorder[i];
      if (b === entry) continue;
      let newIdom: DominatorBlock | null = null;
      for (const pred of b.predecessors) {
        if (!postNum.has(pred) || !idom.has(pred)) continue;
        newIdom =
          newIdom === null ? pred : intersect(pred, newIdom, idom, postNum);
      }
      if (newIdom !== null && idom.get(b) !== newIdom) {
        idom.set(b, newIdom);
        changed = true;
      }
    }
  }

  for (const block of graph.blocks) {
    if (!idom.has(block)) idom.set(block, block);
  }
  return idom;
}

function intersect(
  b1: DominatorBlock,
  b2: DominatorBlock,
  idom: Map<DominatorBlock, DominatorBlock>,
  postNum: Map<DominatorBlock, number>,
): DominatorBlock {
  let f1 = b1;
  let f2 = b2;
  while (f1 !== f2) {
    while (postNum.get(f1)! < postNum.get(f2)!) f1 = idom.get(f1)!;
    while (postNum.get(f2)! < postNum.get(f1)!) f2 = idom.get(f2)!;
  }
  return f1;
}

export function buildDominatorTree(
  graph: DominatorGraph,
  idom: Map<DominatorBlock, DominatorBlock>,
): {
  children: Map<DominatorBlock, DominatorBlock[]>;
  idomMap: Map<DominatorBlock, DominatorBlock | null>;
} {
  const children = new Map<DominatorBlock, DominatorBlock[]>(
    graph.blocks.map((block) => [block, []]),
  );
  const idomMap = new Map<DominatorBlock, DominatorBlock | null>();
  for (const block of graph.blocks) {
    const parent = idom.get(block);
    if (block === graph.entry || !parent || parent === block) {
      idomMap.set(block, null);
      continue;
    }
    idomMap.set(block, parent);
    if (children.has(parent)) children.get(parent)!.push(block);
  }
  return { children, idomMap };
}

export function dominates(
  idom: Map<DominatorBlock, DominatorBlock>,
  a: DominatorBlock,
  b: DominatorBlock,
): boolean {
  let cur = b;
  while (cur) {
    if (cur === a) return true;
    const next = idom.get(cur);
    if (!next || next === cur) break;
    cur = next;
  }
  return false;
}
