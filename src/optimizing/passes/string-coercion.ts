import {
  type CFGFunction,
  irCallBuiltin,
  IR_GENERIC_ADD,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
  TO_STRING_MEMBER,
} from "../metadata/builtin-methods.js";
import { TypeKind } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";

export function coerceStringOperands(graph: CFGFunction, types: TypeInference): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.type !== IR_GENERIC_ADD || node.block !== block) continue;
      if (types.typeOf(node).kind !== TypeKind.String) continue;
      node.inputs.forEach((input, index) => {
        const type = types.typeOf(input);
        if (type.kind === TypeKind.String) return;
        const intrinsic = builtinMethodIntrinsicFor(type, TO_STRING_MEMBER);
        if (intrinsic === null) return;
        const coerced = stamp(
          irCallBuiltin(
            intrinsic.qualifiedName,
            [input],
            builtinMethodCallMetadata(intrinsic),
          ),
        );
        editor.insertBefore(node, coerced);
        node.replaceInput(index, coerced);
        count++;
      });
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
