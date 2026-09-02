import {
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_PHI,
  IR_RETURN,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { mergedTextInputs, StringBufferRules } from "../analyses/aot-legality.js";
import { UnionFind } from "../infra/union-find.js";
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

export type ReenteringCall = (node: CFGInstruction) => boolean;

const NEVER_REENTERS: ReenteringCall = () => false;

function feedsBuilder(value: CFGInstruction, rules: StringBufferRules): boolean {
  for (const alias of rules.walk(value).aliases) {
    if (alias.uses.some((use) => rules.buildsString(use))) return true;
  }
  return false;
}

function aliasesOwnBuffer(
  value: CFGInstruction,
  rules: StringBufferRules,
  reenters: ReenteringCall,
): boolean {
  return (
    value.type === IR_CALL_KNOWN_FUNCTION &&
    reenters(value) &&
    rules.borrowsBuffer(value) &&
    feedsBuilder(value, rules)
  );
}

function boxable(
  value: CFGInstruction,
  rules: StringBufferRules,
  types: TypeInference,
  positions: Positions,
  reenters: ReenteringCall,
): boolean {
  if (acceptsNull(types.typeOf(value))) return false;
  if (!answersString(value, rules)) return false;
  if (value.uses.length === 0) return false;
  if (aliasesOwnBuffer(value, rules, reenters)) return true;
  if (value.uses.every((use) => use.type === IR_RETURN || use.type === IR_PHI)) return false;
  return rules.walk(value).phis === 0 && livesAcrossCall(value, positions);
}

type Stamp = (node: CFGInstruction) => CFGInstruction;

function emitting(
  classes: ClassTable,
  block: CFGBlock,
  at: number,
  stamp: Stamp,
  build: (out: Emitter) => CFGInstruction,
): CFGInstruction {
  const standing = new Set(block.nodes);
  const made = build(new Emitter(classes, block, at));
  for (const node of block.nodes) if (!standing.has(node)) stamp(node);
  return made;
}

function endOf(block: CFGBlock): number {
  const terminator = block.getTerminator();
  return terminator === null ? block.nodes.length : block.nodes.indexOf(terminator);
}

function carriedWebs(graph: CFGFunction, rules: StringBufferRules): CFGInstruction[][] {
  const shared = new UnionFind<CFGInstruction>();
  const held = new Set<CFGInstruction>();
  for (const block of graph.blocks) {
    for (const phi of block.phis) {
      if (!rules.isStringValue(phi)) continue;
      held.add(phi);
      shared.makeSet(phi);
    }
  }
  for (const phi of held) {
    for (const input of phi.inputs) if (held.has(input)) shared.union(phi, input);
  }
  const byRoot = new Map<CFGInstruction, CFGInstruction[]>();
  for (const phi of held) {
    const root = shared.find(phi);
    const web = byRoot.get(root);
    if (web === undefined) byRoot.set(root, [phi]);
    else web.push(phi);
  }
  return [...byRoot.values()];
}

function mergesStorage(web: readonly CFGInstruction[], rules: StringBufferRules): boolean {
  const outside = mergedTextInputs(web, new Set(web));
  return outside.length > 1 && outside.every((value) => rules.isStringValue(value));
}

function boxWeb(
  graph: CFGFunction,
  classes: ClassTable,
  shape: ClassShape,
  web: readonly CFGInstruction[],
  stamp: Stamp,
): boolean {
  const inside = new Set(web);
  const editor = new GraphEditor(graph);
  const crossing: [CFGInstruction, number, CFGInstruction][] = [];
  const boxes = new Map<CFGBlock, Map<CFGInstruction, CFGInstruction>>();
  for (const phi of web) {
    const arriving = phi.block?.predecessors ?? [];
    if (arriving.length !== phi.inputs.length) return false;
    for (const [at, input] of phi.inputs.entries()) {
      if (inside.has(input)) {
        crossing.push([phi, at, input]);
        continue;
      }
      const from = arriving[at]!;
      let known = boxes.get(from);
      if (known === undefined) boxes.set(from, (known = new Map()));
      let box = known.get(input);
      if (box === undefined) {
        box = emitting(classes, from, endOf(from), stamp, (out) => {
          const made = out.allocate(shape);
          out.store(made, shape, TEXT_BOX_FIELD, input);
          return made;
        });
        known.set(input, box);
      }
      editor.setInput(phi, at, box);
    }
  }
  for (const phi of web) {
    const held = emitting(classes, phi.block!, 0, stamp, (out) =>
      out.load(phi, shape, TEXT_BOX_FIELD),
    );
    editor.replaceAllUses(phi, held);
    editor.setInput(held, 0, phi);
  }
  for (const [phi, at, input] of crossing) editor.setInput(phi, at, input);
  return true;
}

export function boxEscapingStrings(
  graph: CFGFunction,
  types: TypeInference,
  reenters: ReenteringCall = NEVER_REENTERS,
): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const rules = new StringBufferRules(types, null);
  const positions = positionsOf(graph);
  const boxed: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (boxable(node, rules, types, positions, reenters)) boxed.push(node);
    }
  }
  const merging = carriedWebs(graph, rules).filter((web) => mergesStorage(web, rules));
  if (boxed.length === 0 && merging.length === 0) return 0;

  const shape = textBoxShape(classes);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const web of merging) {
    if (boxWeb(graph, classes, shape, web, stamp)) count += 1;
  }
  for (const value of boxed) {
    if (boxAt(graph, classes, shape, value, stamp)) count += 1;
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
