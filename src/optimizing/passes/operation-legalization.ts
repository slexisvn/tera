import {
  irBranch,
  irJump,
  IR_SELECT,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { detachInputs, nodeIdStamper, type Stamp } from "../ir/graph-edit.js";

export type OperationExpansion = (
  graph: CFGFunction,
  node: CFGInstruction,
  stamp: Stamp,
) => readonly CFGBlock[];

function expandSelect(
  graph: CFGFunction,
  node: CFGInstruction,
  stamp: Stamp,
): readonly CFGBlock[] {
  const head = node.block!;
  const [condition, whenTrue, whenFalse] = node.inputs as [
    CFGInstruction,
    CFGInstruction,
    CFGInstruction,
  ];
  const join = splitBlockBefore(graph, head, node);
  join.nodes.splice(join.nodes.indexOf(node), 1);

  const taken = graph.addBlock();
  const otherwise = graph.addBlock();
  head.addNode(stamp(irBranch(condition, taken, otherwise)));
  link(head, taken);
  link(head, otherwise);
  taken.addNode(stamp(irJump(join)));
  otherwise.addNode(stamp(irJump(join)));

  const merged = stamp(addPhi(join));
  connect(taken, join, [whenTrue]);
  connect(otherwise, join, [whenFalse]);

  new GraphEditor(graph).replaceAllUses(node, merged);
  detachInputs(node);
  node.block = null;
  return [join];
}

const EXPANSIONS: ReadonlyMap<string, OperationExpansion> = new Map<
  string,
  OperationExpansion
>([[IR_SELECT, expandSelect]]);

export type ValueLegality = ReadonlyMap<string, (node: CFGInstruction) => boolean>;

function illegalIn(
  block: CFGBlock,
  legal: ReadonlySet<string>,
  admissible: ValueLegality,
): CFGInstruction | null {
  for (const node of block.nodes) {
    if (!EXPANSIONS.has(node.type)) continue;
    if (!legal.has(node.type)) return node;
    if (admissible.get(node.type)?.(node) === false) return node;
  }
  return null;
}

export function legalizeOperations(
  graph: CFGFunction,
  admissible: ValueLegality,
): number {
  const legal = graph.emits;
  if (legal === null) return 0;
  const stamp = nodeIdStamper(graph);
  const pending: CFGBlock[] = [...graph.blocks];
  let rewritten = 0;
  while (pending.length > 0) {
    const block = pending.pop()!;
    const node = illegalIn(block, legal, admissible);
    if (node === null) continue;
    pending.push(block, ...EXPANSIONS.get(node.type)!(graph, node, stamp));
    rewritten++;
  }
  if (rewritten > 0) graph.rebuildUses();
  return rewritten;
}
