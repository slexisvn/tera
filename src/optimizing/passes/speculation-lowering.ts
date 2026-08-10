import {
  type CFGFunction,
  type CFGInstruction,
  speculationRoleOf,
  SPECULATION_BASE_GUARD,
  SPECULATION_NATIVE_GUARD,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_DIV,
  IR_INT32_COMPARE,
  IR_GENERIC_ADD,
  IR_GENERIC_SUB,
  IR_GENERIC_MUL,
  IR_GENERIC_DIV,
  IR_GENERIC_COMPARE,
  IR_GENERIC_CALL,
  IR_GENERIC_BITAND,
  IR_GENERIC_BITOR,
  IR_GENERIC_BITXOR,
  IR_GENERIC_BITNOT,
  IR_GENERIC_SHL,
  IR_GENERIC_SHR,
  IR_GENERIC_USHR,
  IR_LOAD_GLOBAL,
  irFloat64Add,
  irFloat64Sub,
  irFloat64Mul,
  irFloat64Div,
  irFloat64Compare,
  irCallKnownFunction,
  irInt32And,
  irInt32Or,
  irInt32Xor,
  irInt32Not,
  irInt32Shl,
  irInt32Shr,
  irInt32Ushr,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { TypeKind } from "../types/lattice.js";
import type { TargetModel } from "../target/model.js";
import type { SpeculationKind } from "../target/speculation.js";

const NUMERIC_OR_UNKNOWN = new Set<string>([
  TypeKind.Smi,
  TypeKind.Double,
  TypeKind.Number,
  TypeKind.Boolean,
  TypeKind.Any,
  TypeKind.Never,
]);


type Rewrite = (node: CFGInstruction) => CFGInstruction;

const DESPECIALIZE = new Map<string, Rewrite>([
  [IR_INT32_ADD, (node) => irFloat64Add(node.inputs[0]!, node.inputs[1]!)],
  [IR_INT32_SUB, (node) => irFloat64Sub(node.inputs[0]!, node.inputs[1]!)],
  [IR_INT32_MUL, (node) => irFloat64Mul(node.inputs[0]!, node.inputs[1]!)],
  [IR_INT32_DIV, (node) => irFloat64Div(node.inputs[0]!, node.inputs[1]!)],
  [
    IR_INT32_COMPARE,
    (node) => irFloat64Compare(String(node.props.op), node.inputs[0]!, node.inputs[1]!),
  ],
]);

type Lowering = { readonly arity: number; readonly rewrite: Rewrite };

const GENERIC_LOWERINGS = new Map<string, Lowering>([
  [IR_GENERIC_ADD, { arity: 2, rewrite: (node) => irFloat64Add(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_SUB, { arity: 2, rewrite: (node) => irFloat64Sub(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_MUL, { arity: 2, rewrite: (node) => irFloat64Mul(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_DIV, { arity: 2, rewrite: (node) => irFloat64Div(node.inputs[0]!, node.inputs[1]!) }],
  [
    IR_GENERIC_COMPARE,
    {
      arity: 2,
      rewrite: (node) =>
        irFloat64Compare(String(node.props.op), node.inputs[0]!, node.inputs[1]!),
    },
  ],
  [IR_GENERIC_BITAND, { arity: 2, rewrite: (node) => irInt32And(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_BITOR, { arity: 2, rewrite: (node) => irInt32Or(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_BITXOR, { arity: 2, rewrite: (node) => irInt32Xor(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_SHL, { arity: 2, rewrite: (node) => irInt32Shl(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_SHR, { arity: 2, rewrite: (node) => irInt32Shr(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_USHR, { arity: 2, rewrite: (node) => irInt32Ushr(node.inputs[0]!, node.inputs[1]!) }],
  [IR_GENERIC_BITNOT, { arity: 1, rewrite: (node) => irInt32Not(node.inputs[0]!) }],
]);

function knownCallTarget(node: CFGInstruction): string | null {
  const callee = node.inputs[0];
  if (callee === undefined || callee.type !== IR_LOAD_GLOBAL) return null;
  const name = callee.props.name;
  return typeof name === "string" ? name : null;
}

function maxNodeId(graph: CFGFunction): number {
  let max = -1;
  for (const param of graph.parameters) max = Math.max(max, param.id);
  for (const block of graph.blocks) {
    for (const phi of block.phis) max = Math.max(max, phi.id);
    for (const node of block.nodes) max = Math.max(max, node.id);
  }
  return max;
}

function replaceNode(editor: GraphEditor, node: CFGInstruction, lowered: CFGInstruction): void {
  editor.insertBefore(node, lowered);
  editor.replaceAllUses(node, lowered);
  editor.remove(node);
}

function isProven(node: CFGInstruction): boolean {
  return node.props.noOverflow === true;
}

function mayBeNumeric(node: CFGInstruction, types: TypeInference): boolean {
  return node.inputs.every((input) => NUMERIC_OR_UNKNOWN.has(types.typeOf(input).kind));
}

function proveOrGeneric(
  graph: CFGFunction,
  editor: GraphEditor,
  types: TypeInference,
  lowerGenerics: boolean,
): number {
  const passthrough: CFGInstruction[] = [];
  const specialized: CFGInstruction[] = [];
  const genericArith: CFGInstruction[] = [];
  const genericCalls: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const role = speculationRoleOf(node.type);
      if (role === SPECULATION_BASE_GUARD || (lowerGenerics && role === SPECULATION_NATIVE_GUARD)) {
        passthrough.push(node);
      } else if (DESPECIALIZE.has(node.type) && !isProven(node)) specialized.push(node);
      else if (
        lowerGenerics &&
        node.inputs.length >= (GENERIC_LOWERINGS.get(node.type)?.arity ?? Infinity) &&
        mayBeNumeric(node, types)
      ) {
        genericArith.push(node);
      } else if (lowerGenerics && node.type === IR_GENERIC_CALL && knownCallTarget(node) !== null) {
        genericCalls.push(node);
      }
    }
  }

  let nextId = maxNodeId(graph) + 1;
  const stamp = (node: CFGInstruction): CFGInstruction => {
    node.id = nextId++;
    return node;
  };

  let changed = 0;
  for (const node of passthrough) {
    editor.replaceAllUses(node, node.inputs[0]!);
    editor.remove(node);
    changed++;
  }
  for (const node of [...specialized, ...genericArith]) {
    const rewrite = DESPECIALIZE.get(node.type) ?? GENERIC_LOWERINGS.get(node.type)!.rewrite;
    replaceNode(editor, node, stamp(rewrite(node)));
    changed++;
  }
  for (const node of genericCalls) {
    const name = knownCallTarget(node)!;
    replaceNode(editor, node, stamp(irCallKnownFunction({ name } as never, node.inputs.slice(1))));
    changed++;
  }

  if (changed > 0) graph.rebuildUses();
  return changed;
}

type Strategy = (
  graph: CFGFunction,
  editor: GraphEditor,
  types: TypeInference,
) => number;

const STRATEGIES = new Map<SpeculationKind, Strategy>([
  ["deopt-to-interpreter", () => 0],
  ["guard-with-slowpath", (graph, editor, types) => proveOrGeneric(graph, editor, types, false)],
  ["prove-or-generic", (graph, editor, types) => proveOrGeneric(graph, editor, types, true)],
]);

export function speculationLowering(
  graph: CFGFunction,
  target: TargetModel,
  types: TypeInference,
): number {
  const strategy = STRATEGIES.get(target.speculation.kind);
  if (strategy === undefined) return 0;
  return strategy(graph, new GraphEditor(graph), types);
}
