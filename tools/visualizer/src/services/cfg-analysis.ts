import type { IrGraphModel } from "./ir-graph";

export type Dominance = {
  readonly order: readonly string[];
  readonly idom: ReadonlyMap<string, string | null>;
  readonly childrenOf: (label: string) => readonly string[];
  readonly dominates: (above: string, below: string) => boolean;
};

export type Loop = {
  readonly header: string;
  readonly depth: number;
  readonly blocks: readonly string[];
  readonly latches: readonly string[];
  readonly children: readonly Loop[];
};

function reachableOrder(model: IrGraphModel): string[] {
  const entry = model.blocks[0];
  if (entry === undefined) return [];
  const known = new Set(model.blocks.map((block) => block.label));
  const seen = new Set<string>([entry.label]);
  const order: string[] = [];
  const walk = (label: string): void => {
    const block = model.blocks.find((candidate) => candidate.label === label);
    if (block === undefined) return;
    for (const next of block.successors) {
      if (!known.has(next) || seen.has(next)) continue;
      seen.add(next);
      walk(next);
    }
    order.push(label);
  };
  walk(entry.label);
  return order.reverse();
}

export function dominanceOf(model: IrGraphModel): Dominance {
  const order = reachableOrder(model);
  const rank = new Map(order.map((label, at) => [label, at]));
  const predecessorsOf = new Map(
    model.blocks.map((block) => [block.label, block.predecessors.filter((label) => rank.has(label))]),
  );
  const idom = new Map<string, string | null>();
  const entry = order[0];
  if (entry === undefined) {
    return {
      order,
      idom,
      childrenOf: () => [],
      dominates: (above, below) => above === below,
    };
  }
  idom.set(entry, entry);

  const meet = (left: string, right: string): string => {
    let a = left;
    let b = right;
    while (a !== b) {
      while (rank.get(a)! > rank.get(b)!) a = idom.get(a)!;
      while (rank.get(b)! > rank.get(a)!) b = idom.get(b)!;
    }
    return a;
  };

  let settled = false;
  while (!settled) {
    settled = true;
    for (const label of order.slice(1)) {
      const known = (predecessorsOf.get(label) ?? []).filter((pred) => idom.has(pred));
      if (known.length === 0) continue;
      const next = known.reduce((left, right) => meet(left, right));
      if (idom.get(label) === next) continue;
      idom.set(label, next);
      settled = false;
    }
  }

  const children = new Map<string, string[]>();
  for (const [label, parent] of idom) {
    if (parent === null || parent === label) continue;
    const bucket = children.get(parent);
    if (bucket === undefined) children.set(parent, [label]);
    else bucket.push(label);
  }
  idom.set(entry, null);

  const dominates = (above: string, below: string): boolean => {
    let walk: string | null | undefined = below;
    while (walk !== null && walk !== undefined) {
      if (walk === above) return true;
      walk = idom.get(walk) ?? null;
    }
    return false;
  };

  return {
    order,
    idom,
    childrenOf: (label) => children.get(label) ?? [],
    dominates,
  };
}

function bodyOf(
  model: IrGraphModel,
  header: string,
  latches: readonly string[],
): Set<string> {
  const predecessorsOf = new Map(model.blocks.map((block) => [block.label, block.predecessors]));
  const blocks = new Set<string>([header]);
  const pending = [...latches];
  while (pending.length > 0) {
    const label = pending.pop()!;
    if (blocks.has(label)) continue;
    blocks.add(label);
    for (const pred of predecessorsOf.get(label) ?? []) pending.push(pred);
  }
  return blocks;
}

export function loopForestOf(model: IrGraphModel, dominance: Dominance): readonly Loop[] {
  const latchesOf = new Map<string, string[]>();
  for (const block of model.blocks) {
    for (const next of block.successors) {
      if (!dominance.dominates(next, block.label)) continue;
      const bucket = latchesOf.get(next);
      if (bucket === undefined) latchesOf.set(next, [block.label]);
      else bucket.push(block.label);
    }
  }

  const bodies = new Map<string, Set<string>>();
  for (const [header, latches] of latchesOf) bodies.set(header, bodyOf(model, header, latches));

  const headers = [...bodies.keys()];
  const parentOf = new Map<string, string | null>();
  for (const header of headers) {
    let parent: string | null = null;
    for (const other of headers) {
      if (other === header || !bodies.get(other)!.has(header)) continue;
      if (parent === null || bodies.get(parent)!.has(other)) parent = other;
    }
    parentOf.set(header, parent);
  }

  const build = (header: string, depth: number): Loop => ({
    header,
    depth,
    blocks: [...bodies.get(header)!].sort(
      (left, right) => (model.orderOf.get(left) ?? 0) - (model.orderOf.get(right) ?? 0),
    ),
    latches: latchesOf.get(header)!,
    children: headers
      .filter((candidate) => parentOf.get(candidate) === header)
      .map((child) => build(child, depth + 1)),
  });

  return headers.filter((header) => parentOf.get(header) === null).map((header) => build(header, 0));
}
