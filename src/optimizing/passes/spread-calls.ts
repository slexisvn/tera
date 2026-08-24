import {
  irConstant,
  irGenericCall,
  irGenericGetIndex,
  IR_GENERIC_CALL,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { genericCalleeName } from "../metadata/call-signatures.js";
import { memberCallTargets } from "./class-member-lowering.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { DeclaredSignature } from "../types/signature.js";

export const SPREAD_ARGUMENTS_PROP = "spreadsArguments";

const RECEIVER_PARAMETER = 1;

export function spreadsArguments(node: CFGInstruction): boolean {
  return node.type === IR_GENERIC_CALL && node.props[SPREAD_ARGUMENTS_PROP] === true;
}

function suppliedCount(node: CFGInstruction, signature: DeclaredSignature): number | null {
  if (signature.rest !== undefined && signature.rest !== null) return null;
  if (signature.variadic === true) return null;
  const receivers = node.props.isMethod === true ? RECEIVER_PARAMETER : 0;
  const supplied = signature.params.length - receivers;
  return supplied < 0 ? null : supplied;
}

function memberSignature(
  node: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): DeclaredSignature | null {
  if (graph.classes === null) return null;
  const call = memberCallTargets(graph, node, graph.classes, types);
  if (call === null || call.symbols.length === 0) return null;
  let agreed: DeclaredSignature | null = null;
  for (const symbol of call.symbols) {
    const signature = graph.calleeSignatures?.get(symbol) ?? null;
    if (signature === null) return null;
    if (agreed !== null && agreed.params.length !== signature.params.length) return null;
    agreed = signature;
  }
  return agreed;
}

function spreadSignature(
  node: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): DeclaredSignature | null {
  if (node.props.isMethod === true) return memberSignature(node, graph, types);
  const name = genericCalleeName(node);
  if (name === null) return null;
  return graph.calleeSignatures?.get(name) ?? null;
}

function expand(
  editor: GraphEditor,
  graph: CFGFunction,
  types: TypeInference,
  node: CFGInstruction,
  stamp: (added: CFGInstruction) => CFGInstruction,
): boolean {
  const signature = spreadSignature(node, graph, types);
  if (signature === null) return false;
  const count = suppliedCount(node, signature);
  if (count === null) return false;
  const carried = node.inputs.slice(0, node.inputs.length - 1);
  const array = node.inputs[node.inputs.length - 1];
  if (array === undefined) return false;

  const taken: CFGInstruction[] = [];
  for (let at = 0; at < count; at++) {
    const index = stamp(irConstant(at));
    editor.insertBefore(node, index);
    const element = stamp(irGenericGetIndex(array, index));
    element.frameState = node.frameState;
    editor.insertBefore(node, element);
    taken.push(element);
  }

  const called = stamp(irGenericCall(carried[0]!, [...carried.slice(1), ...taken]));
  called.props = { ...node.props, [SPREAD_ARGUMENTS_PROP]: undefined };
  called.frameState = node.frameState;
  editor.insertBefore(node, called);
  editor.replaceAllUses(node, called);
  editor.remove(node);
  return true;
}

export function expandSpreadCalls(graph: CFGFunction, types: TypeInference): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let expanded = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block || !spreadsArguments(node)) continue;
      if (expand(editor, graph, types, node, stamp)) expanded++;
    }
  }
  if (expanded > 0) graph.rebuildUses();
  return expanded;
}
