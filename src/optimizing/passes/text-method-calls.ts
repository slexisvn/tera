import {
  irCallKnownFunction,
  irConstant,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { producedType } from "../metadata/produced-type.js";
import { TypeKind } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { DeclaredSignature } from "../types/signature.js";
import { spreadsArguments } from "./spread-calls.js";
import { textMethodNamed, type TextMethod } from "../prelude/text-methods.js";

const CALLEE = 0;
const RECEIVER = 1;
const FIRST_ARGUMENT = 2;

interface Rewrite {
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction;
  readonly receiver: CFGInstruction;
  readonly given: readonly CFGInstruction[];
  readonly method: TextMethod;
  readonly signature: DeclaredSignature;
}

function rewriteFor(
  node: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): Rewrite | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod !== true) return null;
  if (spreadsArguments(node)) return null;
  const callee = node.inputs[CALLEE];
  const receiver = node.inputs[RECEIVER];
  if (callee === undefined || receiver === undefined) return null;
  if (callee.type !== IR_GENERIC_GET_PROP || callee.inputs[0] !== receiver) return null;
  const method = textMethodNamed(String(callee.props.propName));
  if (method === null || !method.sharedName) return null;
  if (producedType(receiver, types, graph.classes).kind !== TypeKind.String) return null;
  const given = node.inputs.slice(FIRST_ARGUMENT);
  if (given.length > method.arity || given.length < method.arity - method.defaults.length) {
    return null;
  }
  const signature = graph.calleeSignatures?.get(method.fn);
  if (signature === undefined) return null;
  return { node, callee, receiver, given, method, signature };
}

function applyRewrite(
  editor: GraphEditor,
  rewrite: Rewrite,
  stamp: (added: CFGInstruction) => CFGInstruction,
): void {
  const { node, callee, receiver, given, method, signature } = rewrite;
  const args: CFGInstruction[] = [receiver, ...given];
  for (const omitted of method.defaults.slice(given.length)) {
    const supplied = stamp(irConstant(omitted));
    editor.insertBefore(node, supplied);
    args.push(supplied);
  }
  const call = stamp(
    irCallKnownFunction({ name: method.fn, declaredSignature: signature } as never, args),
  );
  call.frameState = node.frameState;
  editor.insertBefore(node, call);
  editor.replaceAllUses(node, call);
  editor.remove(node);
  editor.removeIfDead(callee);
}

export function lowerTextMethodCalls(graph: CFGFunction, types: TypeInference): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const rewrite = rewriteFor(node, graph, types);
      if (rewrite === null) continue;
      applyRewrite(editor, rewrite, stamp);
      count++;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
