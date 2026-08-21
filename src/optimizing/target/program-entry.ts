import {
  type CFGFunction,
  type CFGInstruction,
  IR_RETURN,
  irCallBuiltin,
  irConstant,
  irJump,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { link } from "../ir/cfg-edit.js";
import {
  branchOnPendingThrow,
  clearPendingThrowReturn,
  takePendingThrow,
} from "../builder/throw-recovery.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  THROW_BUILTIN,
} from "../metadata/builtin-methods.js";

export const PROGRAM_ENTRY_NAME = "tera_program";
export const PROGRAM_ENTRY_STATUS = 0;
export const PROGRAM_ENTRY_RETURN = "int";

function returnsOf(graph: CFGFunction): CFGInstruction[] {
  const returns: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_RETURN) returns.push(node);
    }
  }
  return returns;
}

function reportUncaughtThrow(graph: CFGFunction, node: CFGInstruction): void {
  const block = node.block!;
  const exit = graph.addBlock();
  for (const moved of block.nodes.splice(block.nodes.indexOf(node))) exit.addNode(moved);

  const { taken, resumed } = branchOnPendingThrow(graph, block);
  const intrinsic = builtinGlobalIntrinsicByName(THROW_BUILTIN)!;
  const thrown = takePendingThrow(taken);
  taken.addNode(irCallBuiltin(THROW_BUILTIN, [thrown], builtinMethodCallMetadata(intrinsic)));
  taken.addNode(irJump(exit));
  link(taken, exit);
  resumed.addNode(irJump(exit));
  link(resumed, exit);
}

export function markProgramEntry(graph: CFGFunction): void {
  graph.name = PROGRAM_ENTRY_NAME;
  graph.declaredSignature = { params: [], returns: PROGRAM_ENTRY_RETURN };
  const editor = new GraphEditor(graph);
  for (const node of returnsOf(graph)) {
    const status = irConstant(PROGRAM_ENTRY_STATUS);
    editor.insertBefore(node, status);
    if (node.inputs.length === 0) node.addInput(status);
    else editor.setInput(node, 0, status);
    if (!graph.recoversThrows) continue;
    reportUncaughtThrow(graph, node);
    clearPendingThrowReturn(node);
  }
  graph.rebuildUses();
}
