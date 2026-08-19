import {
  IR_CONSTANT,
  IR_INT32_DIV,
  IR_INT32_MOD,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { faultWhenZero } from "./guards.js";

const NO_DIVISOR = 0;
const DIVISOR = 1;

const BY_ZERO: ReadonlyMap<string, string> = new Map<string, string>([
  [IR_INT32_DIV, "cannot divide by zero"],
  [IR_INT32_MOD, "cannot take the remainder by zero"],
]);

function provenNonZero(divisor: CFGInstruction): boolean {
  return divisor.type === IR_CONSTANT && divisor.props.value !== NO_DIVISOR;
}

/**
 * `n / 0` and `n % 0` answer `Infinity` and `NaN`, which an int32 result has no room
 * for, so a target that cannot fall back to a tagged number faults rather than hand
 * back the zero its hardware guard would.
 */
export function faultOnZeroDivisor(graph: CFGFunction): number {
  const exposed = graph.blocks.flatMap((block) =>
    block.nodes.filter(
      (node) => BY_ZERO.has(node.type) && !provenNonZero(node.inputs[DIVISOR]!),
    ),
  );
  if (exposed.length === 0) return 0;

  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  for (const node of exposed) {
    const divisor = node.inputs[DIVISOR]!;
    faultWhenZero(graph, editor, node, divisor, BY_ZERO.get(node.type)!, stamp);
  }
  graph.rebuildUses();
  return exposed.length;
}
