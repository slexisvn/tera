import {
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_PHI,
  IR_RETURN,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { StringBufferRules } from "../analyses/aot-legality.js";
import { Emitter } from "./coroutines.js";
import { syntheticSurface } from "../metadata/coroutines.js";
import type { ClassShape, ClassTable } from "../metadata/class-table.js";
import { acceptsNull } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";

const TEXT_BOX_SHAPE = "tera_text";
const TEXT_BOX_FIELD = "text";
const STRING_TYPE = "string";
const STORED_VALUE = 1;

function textBoxShape(classes: ClassTable): ClassShape {
  return classes.defineSynthetic(
    syntheticSurface(TEXT_BOX_SHAPE, null, [[TEXT_BOX_FIELD, STRING_TYPE]]),
  );
}

function definitionEnd(value: CFGInstruction): number {
  const block = value.block!;
  return block.nodes.indexOf(value) + 1;
}

function boxAt(
  graph: CFGFunction,
  classes: ClassTable,
  shape: ClassShape,
  value: CFGInstruction,
  stamp: (node: CFGInstruction) => CFGInstruction,
): boolean {
  const block = value.block;
  if (block === null) return false;
  const editor = new GraphEditor(graph);
  const standing = new Set(block.nodes);
  const out = new Emitter(classes, block, definitionEnd(value));
  const box = out.allocate(shape);
  const store = out.store(box, shape, TEXT_BOX_FIELD, value);
  const held = out.load(box, shape, TEXT_BOX_FIELD);
  for (const node of block.nodes) if (!standing.has(node)) stamp(node);
  editor.replaceAllUses(value, held);
  editor.setInput(store, STORED_VALUE, value);
  return true;
}

function answersString(value: CFGInstruction, rules: StringBufferRules): boolean {
  if (rules.ownsBuffer(value)) return true;
  return value.type === IR_CALL_KNOWN_FUNCTION && rules.borrowsBuffer(value);
}

const CALLS: ReadonlySet<string> = new Set<string>([
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
]);

type Positions = ReadonlyMap<CFGInstruction, number>;

function positionsOf(graph: CFGFunction): Positions {
  const positions = new Map<CFGInstruction, number>();
  for (const block of graph.blocks) {
    for (let index = 0; index < block.nodes.length; index += 1) {
      positions.set(block.nodes[index]!, index);
    }
  }
  return positions;
}

function livesAcrossCall(value: CFGInstruction, positions: Positions): boolean {
  const block = value.block!;
  const defined = positions.get(value)!;
  let last = defined;
  for (const use of value.uses) {
    if (use.block !== block) return true;
    const at = positions.get(use);
    if (at !== undefined) last = Math.max(last, at);
  }
  for (let index = defined + 1; index < last; index += 1) {
    if (CALLS.has(block.nodes[index]!.type)) return true;
  }
  return false;
}

function boxable(
  value: CFGInstruction,
  rules: StringBufferRules,
  types: TypeInference,
  positions: Positions,
): boolean {
  if (acceptsNull(types.typeOf(value))) return false;
  if (!answersString(value, rules)) return false;
  if (value.uses.length === 0) return false;
  if (value.uses.every((use) => use.type === IR_RETURN || use.type === IR_PHI)) return false;
  return rules.walk(value).phis === 0 && livesAcrossCall(value, positions);
}

export function boxEscapingStrings(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const rules = new StringBufferRules(types, null);
  const positions = positionsOf(graph);
  const boxed: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (boxable(node, rules, types, positions)) boxed.push(node);
    }
  }
  if (boxed.length === 0) return 0;

  const shape = textBoxShape(classes);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const value of boxed) {
    if (boxAt(graph, classes, shape, value, stamp)) count += 1;
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
