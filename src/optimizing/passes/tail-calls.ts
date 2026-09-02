import {
  irJump,
  IR_RETURN,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi, connect, link } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { NAMED_ARGUMENTS_PROP } from "../metadata/call-signatures.js";
import type { ModuleFunctions } from "../metadata/module-functions.js";
import { callSiteOf } from "./inlining.js";

interface TailSite {
  readonly block: CFGBlock;
  readonly call: CFGInstruction;
  readonly returned: CFGInstruction;
  readonly args: readonly CFGInstruction[];
}

function tailSiteOf(
  block: CFGBlock,
  graph: CFGFunction,
  functions: ModuleFunctions,
): TailSite | null {
  const returned = block.getTerminator();
  if (returned === null || returned.type !== IR_RETURN) return null;
  const call = block.nodes[block.nodes.indexOf(returned) - 1];
  if (call === undefined || call.props[NAMED_ARGUMENTS_PROP] !== undefined) return null;
  const site = callSiteOf(call, functions);
  if (site === null || site.callee !== graph) return null;
  if (site.args.length !== graph.parameters.length) return null;
  const answered = returned.inputs[0];
  if (answered !== undefined && answered !== call) return null;
  if (call.uses.some((use) => use !== returned)) return null;
  return { block, call, returned, args: [...site.args] };
}

function rewritable(graph: CFGFunction): boolean {
  if (graph.isAsync || graph.isGenerator) return false;
  if (graph.gatheredArguments !== null) return false;
  if (graph.recoversThrows) return false;
  const entry = graph.entry;
  return entry !== null && entry.predecessors.length === 0 && entry.phis.length === 0;
}

export function rewriteSelfTailCalls(
  graph: CFGFunction,
  functions: ModuleFunctions,
): number {
  if (!rewritable(graph)) return 0;
  const entry = graph.entry!;
  const sites = graph.blocks.flatMap((block) => tailSiteOf(block, graph, functions) ?? []);
  if (sites.length === 0) return 0;

  const stamp = nodeIdStamper(graph);
  const editor = new GraphEditor(graph);
  const preamble = graph.addBlock();
  graph.blocks = [preamble, ...graph.blocks.filter((block) => block !== preamble)];
  graph.entry = preamble;
  link(preamble, entry);

  const carriedBy = new Map<CFGInstruction, CFGInstruction>();
  for (const parameter of graph.parameters) {
    const carried = stamp(addPhi(entry, []));
    editor.replaceAllUses(parameter, carried);
    carried.addInput(parameter);
    carriedBy.set(parameter, carried);
  }
  entry.isLoopHeader = true;
  preamble.addNode(stamp(irJump(entry)));

  for (const site of sites) {
    editor.remove(site.returned);
    editor.remove(site.call);
    connect(
      site.block,
      entry,
      site.args.map((argument) => carriedBy.get(argument) ?? argument),
    );
    site.block.addNode(stamp(irJump(entry)));
  }
  return sites.length;
}
