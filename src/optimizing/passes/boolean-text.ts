import {
  type CFGFunction,
  type CFGInstruction,
  IR_CALL_BUILTIN,
  IR_GENERIC_ADD,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_LOAD_GLOBAL,
  irBranch,
  irConstant,
  irJump,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { PRINT_BUILTIN, STRING_BUILTIN, TO_STRING_MEMBER } from "../metadata/builtin-methods.js";
import { BOOLEAN_TEXT } from "../metadata/printed-values.js";
import { TypeKind } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";

const RECEIVER_ONLY = 2;
const RENDERED_ONLY = 2;

type Stamp = (node: CFGInstruction) => CFGInstruction;

function isBoolean(value: CFGInstruction, types: TypeInference): boolean {
  return types.typeOf(value).kind === TypeKind.Boolean;
}

function readsText(node: CFGInstruction, types: TypeInference): boolean {
  if (node.type === IR_CALL_BUILTIN) return String(node.props.name) === PRINT_BUILTIN;
  return node.type === IR_GENERIC_ADD && types.typeOf(node).kind === TypeKind.String;
}

function spelledMethod(node: CFGInstruction): CFGInstruction | null {
  if (node.props.isMethod !== true || node.inputs.length !== RECEIVER_ONLY) return null;
  const callee = node.inputs[0]!;
  const receiver = node.inputs[1]!;
  if (callee.type !== IR_GENERIC_GET_PROP || callee.inputs[0] !== receiver) return null;
  return String(callee.props.propName) === TO_STRING_MEMBER ? receiver : null;
}

function renderedGlobal(node: CFGInstruction): CFGInstruction | null {
  if (node.props.isMethod === true || node.inputs.length !== RENDERED_ONLY) return null;
  const callee = node.inputs[0]!;
  if (callee.type !== IR_LOAD_GLOBAL || String(callee.props.name) !== STRING_BUILTIN) return null;
  return node.inputs[1]!;
}

function spelledBoolean(node: CFGInstruction, types: TypeInference): CFGInstruction | null {
  if (node.type !== IR_GENERIC_CALL) return null;
  const rendered = spelledMethod(node) ?? renderedGlobal(node);
  if (rendered === null) return null;
  return isBoolean(rendered, types) ? rendered : null;
}

export function lowerBooleanText(graph: CFGFunction, types: TypeInference): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (let at = 0; at < graph.blocks.length; at++) {
    const block = graph.blocks[at]!;
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const spelled = spelledBoolean(node, types);
      if (spelled !== null) {
        replaceWithText(graph, editor, node, spelled, stamp);
        count++;
        continue;
      }
      if (!readsText(node, types)) continue;
      const chosen = new Map<CFGInstruction, CFGInstruction>();
      node.inputs.forEach((input, index) => {
        if (!isBoolean(input, types)) return;
        const text = chosen.get(input) ?? selectBooleanText(graph, node, input, stamp);
        chosen.set(input, text);
        node.replaceInput(index, text);
        count++;
      });
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}

function replaceWithText(
  graph: CFGFunction,
  editor: GraphEditor,
  node: CFGInstruction,
  value: CFGInstruction,
  stamp: Stamp,
): void {
  const callee = node.inputs[0]!;
  const text = selectBooleanText(graph, node, value, stamp);
  editor.replaceAllUses(node, text);
  editor.remove(node);
  editor.removeIfDead(callee);
}

function selectBooleanText(
  graph: CFGFunction,
  node: CFGInstruction,
  value: CFGInstruction,
  stamp: Stamp,
): CFGInstruction {
  const test = node.block!;
  const after = splitBlockBefore(graph, test, node);
  const text = stamp(addPhi(after, []));
  const [whenFalse, whenTrue] = BOOLEAN_TEXT.map((word) => {
    const arm = graph.addBlock();
    const constant = stamp(irConstant(word));
    arm.addNode(constant);
    arm.addNode(stamp(irJump(after)));
    connect(arm, after, [constant]);
    return arm;
  });

  test.addNode(stamp(irBranch(value, whenTrue!, whenFalse!)));
  link(test, whenTrue!);
  link(test, whenFalse!);
  return text;
}
