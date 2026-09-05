import {
  irCallKnownFunction,
  IR_CALL_BUILTIN,
  type CFGFunction,
  type CFGInstruction,
  type IRValueLike,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { WHOLE_TEXT_PROP } from "../metadata/builtin-methods.js";
import { BYTEWISE_PROP, countsCharacters } from "../analyses/wide-text.js";
import {
  NUMBER_OF_FUNCTION,
  NUMBER_TEXT_READERS,
  PARSE_NUMBER_FUNCTIONS,
  PARSE_NUMBER_SIGNATURE,
} from "../prelude/parse-number.js";
import type { ModuleIR } from "../compilation-unit.js";

const TEXT = 0;
const READS_ONE_TEXT = 1;

function readerFor(node: CFGInstruction): string | null {
  if (node.type !== IR_CALL_BUILTIN || node.inputs.length !== READS_ONE_TEXT) return null;
  const reader = PARSE_NUMBER_FUNCTIONS.get(String(node.props.name));
  if (reader === undefined) return null;
  return node.props[WHOLE_TEXT_PROP] === true ? NUMBER_OF_FUNCTION : reader;
}

export function lowerParseNumbers(graph: CFGFunction): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let lowered = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const reader = readerFor(node);
      if (reader === null) continue;
      const call = stamp(
        irCallKnownFunction(
          { name: reader, declaredSignature: PARSE_NUMBER_SIGNATURE } as unknown as IRValueLike,
          [node.inputs[TEXT]!],
        ),
      );
      call.frameState = node.frameState;
      editor.insertBefore(node, call);
      editor.replaceAllUses(node, call);
      editor.remove(node);
      lowered += 1;
    }
  }
  if (lowered > 0) graph.rebuildUses();
  return lowered;
}

export function markNumberTextBytewise(module: ModuleIR): number {
  let marked = 0;
  for (const unit of module.units) {
    if (!NUMBER_TEXT_READERS.has(unit.graph.name)) continue;
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (!countsCharacters(node)) continue;
        node.props[BYTEWISE_PROP] = true;
        marked += 1;
      }
    }
  }
  return marked;
}
