import {
  type CFGFunction,
  type CFGInstruction,
  irConstant,
  IR_CALL_KNOWN_FUNCTION,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  declaredDefaultsByName,
  NAMED_ARGUMENTS_PROP,
  calleeSymbolName,
} from "../metadata/call-signatures.js";
import { metadataStringArray } from "../ir/metadata.js";
import type { DeclaredDefault, DeclaredSignature } from "../types/signature.js";

type Match = {
  readonly names: readonly string[];
  readonly defaults: ReadonlyMap<string, DeclaredDefault>;
  readonly arguments: readonly (CFGInstruction | undefined)[];
};

function place(
  node: CFGInstruction,
  supplied: readonly string[],
  names: readonly string[],
): (CFGInstruction | undefined)[] | null {
  const positional = node.inputs.slice(0, node.inputs.length - supplied.length);
  if (positional.length > names.length) return null;

  const ordered: (CFGInstruction | undefined)[] = names.map((_, at) => positional[at]);
  for (let index = 0; index < supplied.length; index++) {
    const at = names.indexOf(supplied[index]!);
    if (at < positional.length || at < 0) return null;
    if (ordered[at] !== undefined) return null;
    ordered[at] = node.inputs[positional.length + index];
  }
  return ordered;
}

function matchOf(node: CFGInstruction, signature: DeclaredSignature): Match | null {
  const names = signature.names;
  if (names === undefined) return null;
  const supplied = metadataStringArray(node.props[NAMED_ARGUMENTS_PROP]) ?? [];
  const ordered = place(node, supplied, names);
  if (ordered === null) return null;
  const defaults = declaredDefaultsByName(signature);
  const known = ordered.map(
    (argument, index) => argument !== undefined || defaults.has(names[index]!),
  );
  const gap = known.indexOf(false);
  const length = gap < 0 ? ordered.length : gap;
  if (ordered.slice(length).some((argument) => argument !== undefined)) return null;
  return { names, defaults, arguments: ordered.slice(0, length) };
}

function isRewrite(node: CFGInstruction, match: Match): boolean {
  if (node.props[NAMED_ARGUMENTS_PROP] !== undefined) return true;
  if (node.inputs.length !== match.arguments.length) return true;
  return match.arguments.some((argument, index) => argument !== node.inputs[index]);
}

export function lowerNamedArguments(graph: CFGFunction): number {
  const signatures = graph.calleeSignatures;
  if (signatures === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.type !== IR_CALL_KNOWN_FUNCTION) continue;
      const symbol = calleeSymbolName(node);
      const signature = symbol === null ? undefined : signatures.get(symbol);
      if (signature === undefined) continue;
      const match = matchOf(node, signature);
      if (match === null || !isRewrite(node, match)) continue;
      const arguments_ = match.arguments.map((argument, index) => {
        if (argument !== undefined) return argument;
        const value = stamp(irConstant(match.defaults.get(match.names[index]!)));
        editor.insertBefore(node, value);
        return value;
      });
      node.inputs.splice(0, node.inputs.length, ...arguments_);
      delete node.props[NAMED_ARGUMENTS_PROP];
      count++;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
