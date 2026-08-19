import {
  IR_CALL_BUILTIN,
  irCallBuiltin,
  irRequiresFrameState,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { DominatorTree } from "../analyses/dominance.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  qualifiedMethodName,
  type BuiltinMethodIntrinsic,
} from "../metadata/builtin-methods.js";
import { faultOutsideRange, measuredAlready, type Stamp } from "./guards.js";

const RECEIVER = 0;
const FIRST_ARGUMENT = 1;
const COUNTED_CHARACTERS = qualifiedMethodName("string", "length");

/**
 * An argument a compiled call has no answer outside `[0, countedBy)` for, where the
 * source answers `NaN` or raises. A member with no `countedBy` only rules out negatives.
 */
type Domain = {
  readonly argument: number;
  readonly countedBy: string | null;
  readonly message: string;
};

const DOMAINS: ReadonlyMap<string, Domain> = new Map<string, Domain>([
  [
    qualifiedMethodName("string", "char_code_at"),
    {
      argument: FIRST_ARGUMENT,
      countedBy: COUNTED_CHARACTERS,
      message: "no character code at that index",
    },
  ],
  [
    qualifiedMethodName("string", "repeat"),
    {
      argument: FIRST_ARGUMENT,
      countedBy: null,
      message: "cannot repeat text a negative number of times",
    },
  ],
]);

function domainOf(node: CFGInstruction): Domain | null {
  if (node.type !== IR_CALL_BUILTIN) return null;
  const demanded = DOMAINS.get(String(node.props.name));
  if (demanded === undefined) return null;
  return node.inputs[demanded.argument] === undefined ? null : demanded;
}

function measure(
  editor: GraphEditor,
  node: CFGInstruction,
  intrinsic: BuiltinMethodIntrinsic,
  reaching: DominatorTree,
  stamp: Stamp,
): CFGInstruction {
  const receiver = node.inputs[RECEIVER]!;
  const reused = measuredAlready(node, intrinsic.qualifiedName, receiver, reaching);
  if (reused !== null) return reused;
  const call = stamp(
    irCallBuiltin(intrinsic.qualifiedName, [receiver], builtinMethodCallMetadata(intrinsic)),
  );
  if (irRequiresFrameState(call)) call.frameState = node.frameState;
  editor.insertBefore(node, call);
  return call;
}

/**
 * Holds a builtin call inside the arguments it can answer for, faulting where the source
 * would have answered `NaN` or raised. A target carrying tagged values has room for those
 * answers already, so this only runs where the pipeline includes it.
 */
export function faultOutsideBuiltinDomains(graph: CFGFunction): number {
  const guarded = graph.blocks.flatMap((block) =>
    block.nodes.flatMap((node) => {
      const demanded = domainOf(node);
      return demanded === null ? [] : [{ node, demanded }];
    }),
  );
  if (guarded.length === 0) return 0;

  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  const reaching = new DominatorTree(graph);
  for (const { node, demanded } of guarded) {
    const counted =
      demanded.countedBy === null ? null : builtinMethodIntrinsicByName(demanded.countedBy);
    faultOutsideRange(
      graph,
      editor,
      node,
      node.inputs[demanded.argument]!,
      counted === null ? null : measure(editor, node, counted, reaching, stamp),
      demanded.message,
      stamp,
    );
  }
  graph.rebuildUses();
  return guarded.length;
}
