import {
  homeInstruction,
  irConstant,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_LOAD_GLOBAL,
  IR_STORE_GLOBAL,
} from "../ir/index.js";
import { addPhi } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { eliminateTrivialPhis } from "./dce.js";

type BlockState = Map<string, CFGInstruction>;

interface PendingPhi {
  readonly block: CFGBlock;
  readonly name: string;
  readonly phi: CFGInstruction;
}

function assignedGlobals(graph: CFGFunction): Set<string> {
  const names = new Set<string>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_STORE_GLOBAL) names.add(String(node.props.name));
    }
  }
  return names;
}

function seedEntry(block: CFGBlock, names: Iterable<string>): BlockState {
  const state: BlockState = new Map();
  for (const name of names) {
    state.set(name, homeInstruction(irConstant(undefined), block));
  }
  return state;
}

function openBlock(
  block: CFGBlock,
  names: Iterable<string>,
  pending: PendingPhi[],
): BlockState {
  const state: BlockState = new Map();
  for (const name of names) {
    const phi = addPhi(block);
    pending.push({ block, name, phi });
    state.set(name, phi);
  }
  return state;
}

function rewriteBlock(
  block: CFGBlock,
  names: ReadonlySet<string>,
  entering: BlockState,
  editor: GraphEditor,
): BlockState {
  const current: BlockState = new Map(entering);
  for (const node of [...block.nodes]) {
    const name = String(node.props.name);
    if (!names.has(name)) continue;
    if (node.type === IR_STORE_GLOBAL) {
      current.set(name, node.inputs[0]!);
      editor.remove(node);
    } else if (node.type === IR_LOAD_GLOBAL) {
      editor.replaceAllUses(node, current.get(name)!);
      editor.remove(node);
    }
  }
  return current;
}

export function promoteAssignedGlobals(graph: CFGFunction): number {
  const names = assignedGlobals(graph);
  if (names.size === 0) return 0;

  const editor = new GraphEditor(graph);
  const pending: PendingPhi[] = [];
  const entering = new Map<CFGBlock, BlockState>();
  for (const block of graph.blocks) {
    entering.set(
      block,
      block.predecessors.length === 0
        ? seedEntry(block, names)
        : openBlock(block, names, pending),
    );
  }

  const leaving = new Map<CFGBlock, BlockState>();
  for (const block of graph.blocks) {
    leaving.set(block, rewriteBlock(block, names, entering.get(block)!, editor));
  }

  for (const { block, name, phi } of pending) {
    for (const predecessor of block.predecessors) {
      phi.addInput(leaving.get(predecessor)!.get(name)!);
    }
  }

  graph.rebuildUses();
  eliminateTrivialPhis(graph);
  return names.size;
}
