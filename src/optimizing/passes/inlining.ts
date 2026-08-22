import {
  irRequiresFrameState,
  IR_AWAIT,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_DEOPTIMIZE,
  IR_LOAD_CONTEXT_SLOT,
  IR_LOAD_TEXT,
  IR_RETURN,
  IR_STORE_CONTEXT_SLOT,
  IR_STORE_TEXT,
  IR_YIELD,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { cloneGraph } from "../ir/clone.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { calleeSymbolName, NAMED_ARGUMENTS_PROP } from "../metadata/call-signatures.js";
import type { ModuleFunctions } from "../metadata/module-functions.js";
import type { CompilerOptions } from "../options.js";

const OPAQUE_TO_INLINING: ReadonlySet<string> = new Set<string>([
  IR_LOAD_CONTEXT_SLOT,
  IR_STORE_CONTEXT_SLOT,
  IR_DEOPTIMIZE,
  IR_AWAIT,
  IR_YIELD,
  IR_LOAD_TEXT,
  IR_STORE_TEXT,
]);

const STRING_TYPE = "string";

interface CallSite {
  readonly callee: CFGFunction;
  readonly args: readonly CFGInstruction[];
}

interface StraightLineBody {
  readonly nodes: readonly CFGInstruction[];
  readonly returned: CFGInstruction | null;
}

function straightLineBody(callee: CFGFunction): StraightLineBody | null {
  if (callee.blocks.length !== 1) return null;
  const block = callee.blocks[0]!;
  if (block.phis.length > 0) return null;
  const terminator = block.terminator;
  if (terminator === null || terminator.type !== IR_RETURN) return null;
  const nodes: CFGInstruction[] = [];
  for (const node of block.nodes) {
    if (node === terminator) continue;
    if (OPAQUE_TO_INLINING.has(node.type)) return null;
    nodes.push(node);
  }
  return { nodes, returned: terminator.inputs[0] ?? null };
}

function callSiteOf(
  node: CFGInstruction,
  functions: ModuleFunctions,
): CallSite | null {
  if (node.type === IR_CALL_KNOWN_FUNCTION) {
    const name = calleeSymbolName(node);
    const named = name === null ? null : functions.named(name);
    return named === null ? null : { callee: named, args: node.inputs };
  }
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const callee = functions.referenced(node.inputs[0]);
  return callee === null ? null : { callee, args: node.inputs.slice(1) };
}

function inlinable(
  site: CallSite,
  call: CFGInstruction,
  caller: CFGFunction,
  body: StraightLineBody,
  budget: number,
): boolean {
  const callee = site.callee;
  if (call.props[NAMED_ARGUMENTS_PROP] !== undefined) return false;
  if (callee === caller) return false;
  if (callee.isAsync || callee.isGenerator) return false;
  if (callee.gatheredArguments !== null) return false;
  if (callee.receiver) return false;
  if (callee.declaredSignature?.returns === STRING_TYPE) return false;
  if (callee.parameters.length !== site.args.length) return false;
  if (body.nodes.length > budget) return false;
  return body.returned !== null || call.uses.length === 0;
}

function spliceBody(
  caller: CFGFunction,
  call: CFGInstruction,
  site: CallSite,
  editor: GraphEditor,
  stamp: (node: CFGInstruction) => CFGInstruction,
): boolean {
  const copy = cloneGraph(site.callee, `${caller.name}$inline`);
  const cloned = straightLineBody(copy.graph);
  if (cloned === null) return false;

  const parameters = copy.graph.parameters;
  const inside = new GraphEditor(copy.graph);
  for (let at = 0; at < parameters.length; at++) {
    inside.replaceAllUses(parameters[at]!, site.args[at]!);
  }

  for (const node of cloned.nodes) {
    stamp(node);
    if (node.frameState === null && irRequiresFrameState(node)) node.frameState = call.frameState;
    editor.insertBefore(call, node);
  }
  if (cloned.returned !== null) editor.replaceAllUses(call, cloned.returned);
  editor.remove(call);
  return true;
}

export function inlineKnownCalls(
  graph: CFGFunction,
  functions: ModuleFunctions,
  options: CompilerOptions,
): number {
  if (options.inlineBudget === 0) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let remaining = options.inlineBudget;
  let inlined = 0;

  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const site = callSiteOf(node, functions);
      if (site === null) continue;
      const body = straightLineBody(site.callee);
      if (body === null || !inlinable(site, node, graph, body, remaining)) continue;
      if (!spliceBody(graph, node, site, editor, stamp)) continue;
      remaining -= body.nodes.length;
      inlined++;
    }
  }

  if (inlined > 0) graph.rebuildUses();
  return inlined;
}
