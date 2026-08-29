export type IrNode = {
  readonly key: string;
  readonly id: number;
  readonly opcode: string;
  readonly inputs: readonly string[];
  readonly text: string;
};

export type IrBlock = {
  readonly label: string;
  readonly id: number;
  readonly isLoopHeader: boolean;
  readonly successors: readonly string[];
  readonly predecessors: readonly string[];
  readonly nodes: readonly IrNode[];
};

export type IrGraphModel = {
  readonly name: string;
  readonly parameters: readonly IrNode[];
  readonly blocks: readonly IrBlock[];
  readonly orderOf: ReadonlyMap<string, number>;
};

const HEADER = /^\s*fn\s+(\S+)\s+params=(\d+)/;
const BLOCK_LINE = /^\s*(B(\d+))\b([^:]*):/;
const NODE_LINE = /^\s*v(\d+)\s*=\s*([A-Za-z][A-Za-z0-9_]*)(.*)$/;

function blockList(header: string, key: string): string[] {
  const found = new RegExp(`${key}=([B0-9,]*)`).exec(header);
  if (found === null) return [];
  return found[1]!.split(",").filter((name) => name !== "");
}

function inputsOf(tail: string): string[] {
  const opened = tail.indexOf("[");
  const head = (opened >= 0 ? tail.slice(0, opened) : tail).replace(/!fs\s*$/, "");
  return head
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^v\d+$/.test(part));
}

function nodeFrom(line: string): IrNode | null {
  const found = NODE_LINE.exec(line);
  if (found === null) return null;
  return {
    key: `v${found[1]!}`,
    id: Number(found[1]),
    opcode: found[2]!,
    inputs: inputsOf(found[3]!),
    text: line.trim(),
  };
}

export function parseGraphText(text: string): IrGraphModel | null {
  const lines = text.split("\n");
  const header = lines.map((line) => HEADER.exec(line)).find((match) => match !== null);
  if (header === undefined || header === null) return null;

  const parameters: IrNode[] = [];
  const blocks: IrBlock[] = [];
  let current: { block: Omit<IrBlock, "nodes">; nodes: IrNode[] } | null = null;

  const close = (): void => {
    if (current !== null) blocks.push({ ...current.block, nodes: current.nodes });
    current = null;
  };

  for (const line of lines) {
    if (HEADER.test(line) || line.trim() === "}" || /^\s*graph\s/.test(line)) continue;
    const opens = BLOCK_LINE.exec(line);
    if (opens !== null) {
      close();
      current = {
        block: {
          label: opens[1]!,
          id: Number(opens[2]),
          isLoopHeader: opens[3]!.includes("loop-header"),
          successors: blockList(opens[3]!, "succs"),
          predecessors: blockList(opens[3]!, "preds"),
        },
        nodes: [],
      };
      continue;
    }
    const node = nodeFrom(line);
    if (node === null) continue;
    if (current === null) parameters.push(node);
    else current.nodes.push(node);
  }
  close();

  return {
    name: header[1]!,
    parameters,
    blocks,
    orderOf: new Map(blocks.map((block, at) => [block.label, at])),
  };
}

export function layerBlocks(model: IrGraphModel): readonly (readonly IrBlock[])[] {
  const byLabel = new Map(model.blocks.map((block) => [block.label, block]));
  const depth = new Map<string, number>();
  const entry = model.blocks[0];
  if (entry === undefined) return [];

  const queue: string[] = [entry.label];
  depth.set(entry.label, 0);
  for (let at = 0; at < queue.length; at++) {
    const label = queue[at]!;
    const block = byLabel.get(label);
    if (block === undefined) continue;
    for (const next of block.successors) {
      if (!byLabel.has(next) || depth.has(next)) continue;
      depth.set(next, depth.get(label)! + 1);
      queue.push(next);
    }
  }

  const deepest = depth.size === 0 ? 0 : Math.max(...depth.values());
  const rows: IrBlock[][] = [];
  for (const block of model.blocks) {
    const at = depth.get(block.label) ?? deepest + 1;
    while (rows.length <= at) rows.push([]);
    rows[at]!.push(block);
  }
  return rows.filter((row) => row.length > 0);
}

export type NodeSite = {
  readonly node: IrNode;
  readonly block: string | null;
};

export function locateNode(model: IrGraphModel, key: string): NodeSite | null {
  for (const block of model.blocks) {
    for (const node of block.nodes) {
      if (node.key === key) return { node, block: block.label };
    }
  }
  const parameter = model.parameters.find((node) => node.key === key);
  return parameter === undefined ? null : { node: parameter, block: null };
}

export function nodeByKey(model: IrGraphModel, key: string): IrNode | null {
  return locateNode(model, key)?.node ?? null;
}

export function isBackEdge(model: IrGraphModel, from: string, to: string): boolean {
  return (model.orderOf.get(to) ?? 0) <= (model.orderOf.get(from) ?? 0);
}
