import * as ir from "../ir/index.js";
import { computeDominators, buildDominatorTree } from "./dominators.js";
import { replaceGraphFrameStateValue } from "./frame-state-values.js";

type GvnNode = ir.CFGInstruction;
type GvnBlock = ir.CFGBlock;
type GvnGraph = ir.CFGFunction;

const KEEP_ALIVE = new Set([ir.IR_PARAMETER, ir.IR_CONSTANT, ir.IR_PHI]);

const COMMUTATIVE_OPS = new Set([
  ir.IR_INT32_ADD,
  ir.IR_INT32_MUL,
  ir.IR_INT32_AND,
  ir.IR_INT32_OR,
  ir.IR_INT32_XOR,
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_MUL,
]);

function hashNode(node: GvnNode): string {
  let h = node.type;

  if (COMMUTATIVE_OPS.has(node.type) && node.inputs.length === 2) {
    const id0 = node.inputs[0]!.id;
    const id1 = node.inputs[1]!.id;
    if (id0 <= id1) {
      h += "|" + id0 + "|" + id1;
    } else {
      h += "|" + id1 + "|" + id0;
    }
  } else {
    for (const inp of node.inputs) {
      h += "|" + inp.id;
    }
  }

  if (node.props.op) h += "|op=" + String(node.props.op);
  if (node.props.offset !== undefined) h += "|off=" + String(node.props.offset);
  if (node.props.mapId !== undefined) h += "|map=" + String(node.props.mapId);
  if (node.props.propName) h += "|pn=" + String(node.props.propName);
  return h;
}

export function globalValueNumbering(graph: GvnGraph): number {
  let gvnCount = 0;
  const dominators = computeDominators(graph);
  const { children } = buildDominatorTree(graph, dominators);

  const replaceNode = (node: GvnNode, existing: GvnNode): void => {
    for (const use of [...node.uses]) {
      for (let i = 0; i < use.inputs.length; i++) {
        if (use.inputs[i] === node) {
          use.replaceInput(i, existing);
        }
      }
    }
    replaceGraphFrameStateValue(graph, node, existing);
    if (node.frameState && !existing.frameState) {
      existing.frameState = node.frameState;
    }
    for (const inp of node.inputs) {
      inp.uses = inp.uses.filter((u) => u !== node);
    }
    node.uses = [];
    node.inputs = [];
    gvnCount++;
  };

  const visit = (
    block: GvnBlock,
    inheritedTable: Map<string, GvnNode>,
  ): void => {
    const valueTable = new Map(inheritedTable);
    for (const node of block.nodes) {
      if (node.effectKind !== ir.EFFECT_NONE) continue;
      if (KEEP_ALIVE.has(node.type)) continue;
      if (node.inputs.length === 0) continue;

      const hash = hashNode(node);
      const existing = valueTable.get(hash);

      if (existing && existing !== node && existing.type === node.type) {
        replaceNode(node, existing);
      } else if (!existing) {
        valueTable.set(hash, node);
      }
    }
    for (const child of (children.get(block) || []) as GvnBlock[]) {
      visit(child, valueTable);
    }
  };

  if (graph.entry) {
    visit(graph.entry, new Map());
  }

  if (gvnCount > 0) {
    for (const block of graph.blocks) {
      block.nodes = block.nodes.filter(
        (n) =>
          n.inputs.length > 0 ||
          n.uses.length > 0 ||
          n.effectKind !== ir.EFFECT_NONE ||
          KEEP_ALIVE.has(n.type),
      );
    }
    graph.rebuildUses?.();
  }

  return gvnCount;
}
