import {
  irLoadGlobal,
  IR_GENERIC_ADD,
  IR_GENERIC_CALL,
  IR_GENERIC_DIV,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_MUL,
  IR_GENERIC_SUB,
  IR_ITERATOR_INIT,
  IR_LOAD_GLOBAL,
  IR_PHI,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { arrayElementNameOf, iteratedArrayOf } from "./array-shapes.js";
import {
  mapClassName,
  setClassName,
  COLLECTION_GLOBALS,
  MAP_GLOBAL,
  SET_GLOBAL,
  type KeyKind,
  type ValueKind,
} from "../prelude/collections.js";

const KEYED_MEMBERS: ReadonlySet<string> = new Set(["set", "get", "has", "add", "delete"]);
const LISTED_MEMBERS: ReadonlySet<string> = new Set(["keys", "values"]);
const SIZE_MEMBER = "size";
const VALUED_MEMBER = "set";
const RECEIVER = 1;
const KEY_ARGUMENT = 2;
const VALUE_ARGUMENT = 3;
const COUNTED_VALUE: ValueKind = "int";

const KEY_BY_KIND: ReadonlyMap<string, KeyKind> = new Map<string, KeyKind>([
  [TypeKind.String, "string"],
  [TypeKind.Smi, "int"],
]);

const KEY_BY_ELEMENT: ReadonlyMap<string, KeyKind> = new Map<string, KeyKind>([
  ["string", "string"],
  ["int", "int"],
]);

const VALUE_BY_KIND: ReadonlyMap<string, ValueKind> = new Map<string, ValueKind>([
  [TypeKind.String, "string"],
  [TypeKind.Smi, "int"],
  [TypeKind.Double, "float"],
  [TypeKind.Number, "float"],
]);

const TRANSPARENT: ReadonlySet<string> = new Set<string>([
  IR_GENERIC_ADD,
  IR_GENERIC_SUB,
  IR_GENERIC_MUL,
  IR_PHI,
]);

function namedConstruction(node: CFGInstruction, graph: CFGFunction): string | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const callee = node.inputs[0];
  if (callee?.type !== IR_LOAD_GLOBAL) return null;
  const name = String(callee.props.name);
  if (!COLLECTION_GLOBALS.has(name)) return null;
  return graph.classes?.shapeOf(name) === null ? name : null;
}

function calledMember(
  use: CFGInstruction,
  receivers: ReadonlySet<CFGInstruction>,
): string | null {
  if (use.type !== IR_GENERIC_CALL || use.props.isMethod !== true) return null;
  const receiver = use.inputs[RECEIVER];
  if (receiver === undefined || !receivers.has(receiver)) return null;
  const callee = use.inputs[0];
  return callee?.type === IR_GENERIC_GET_PROP ? String(callee.props.propName) : null;
}

function supported(member: string): boolean {
  return KEYED_MEMBERS.has(member) || LISTED_MEMBERS.has(member) || member === SIZE_MEMBER;
}

function iteratedOnly(call: CFGInstruction): boolean {
  for (const use of call.uses) if (use.type !== IR_ITERATOR_INIT) return false;
  return true;
}

function aliasesOf(node: CFGInstruction): ReadonlySet<CFGInstruction> {
  const aliases = new Set<CFGInstruction>([node]);
  const pending: CFGInstruction[] = [node];
  while (pending.length > 0) {
    for (const use of pending.pop()!.uses) {
      if (use.type !== IR_PHI || aliases.has(use)) continue;
      aliases.add(use);
      pending.push(use);
    }
  }
  return aliases;
}

function heldWithin(aliases: ReadonlySet<CFGInstruction>): boolean {
  for (const alias of aliases) {
    for (const use of alias.uses) {
      if (aliases.has(use)) continue;
      const called = calledMember(use, aliases);
      if (called !== null) {
        if (!supported(called)) return false;
        if (LISTED_MEMBERS.has(called) && !iteratedOnly(use)) return false;
        continue;
      }
      if (use.type !== IR_GENERIC_GET_PROP || use.inputs[0] !== alias) return false;
      if (!supported(String(use.props.propName))) return false;
    }
  }
  return true;
}

function keyedCall(use: CFGInstruction, aliases: ReadonlySet<CFGInstruction>): string | null {
  const member = calledMember(use, aliases);
  return member !== null && KEYED_MEMBERS.has(member) ? member : null;
}

function widened(carried: ValueKind | null, found: ValueKind): ValueKind | null {
  if (carried === null || carried === found) return found;
  return carried !== "string" && found !== "string" ? "float" : null;
}

function kindOf<T>(type: LatticeType, table: ReadonlyMap<string, T>): T | null {
  return table.get(type.kind) ?? null;
}

function keyKindOf(
  value: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): KeyKind | null {
  const named = kindOf(types.typeOf(value), KEY_BY_KIND);
  if (named !== null) return named;
  const classes = graph.classes;
  const array = iteratedArrayOf(value);
  if (classes === null || array === null) return null;
  const element = arrayElementNameOf(array, graph, classes, types);
  return element === null ? null : (KEY_BY_ELEMENT.get(element) ?? null);
}

function divided(node: CFGInstruction): ValueKind | null {
  return node.type === IR_GENERIC_DIV ? "float" : null;
}

function valueKindOf(
  stored: CFGInstruction,
  aliases: ReadonlySet<CFGInstruction>,
  types: TypeInference,
): ValueKind | null {
  const seen = new Set<CFGInstruction>();
  const pending: CFGInstruction[] = [stored];
  let carried: ValueKind | null = null;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (calledMember(node, aliases) !== null) continue;
    const named = kindOf(types.typeOf(node), VALUE_BY_KIND) ?? divided(node);
    if (named !== null) {
      carried = widened(carried, named);
      if (carried === null) return null;
      continue;
    }
    if (!TRANSPARENT.has(node.type)) return null;
    for (const input of node.inputs) pending.push(input);
  }
  return carried;
}

function collectionOf(
  aliases: ReadonlySet<CFGInstruction>,
  kind: string,
  graph: CFGFunction,
  types: TypeInference,
): string | null {
  let key: KeyKind | null = null;
  let value: ValueKind | null = null;
  for (const alias of aliases) {
    for (const use of alias.uses) {
      const member = keyedCall(use, aliases);
      if (member === null) continue;
      const held = use.inputs[KEY_ARGUMENT];
      if (held === undefined) return null;
      const named = keyKindOf(held, graph, types);
      if (named !== null) {
        if (key !== null && key !== named) return null;
        key = named;
      }
      if (member !== VALUED_MEMBER || kind !== MAP_GLOBAL) continue;
      const stored = use.inputs[VALUE_ARGUMENT];
      if (stored === undefined) return null;
      const found = valueKindOf(stored, aliases, types);
      if (found === null) continue;
      value = widened(value, found);
      if (value === null) return null;
    }
  }
  if (key === null) return null;
  return kind === SET_GLOBAL ? setClassName(key) : mapClassName(key, value ?? COUNTED_VALUE);
}

export function lowerCollectionSurface(graph: CFGFunction, types: TypeInference): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let lowered = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const kind = namedConstruction(node, graph);
      if (kind === null) continue;
      const aliases = aliasesOf(node);
      if (!heldWithin(aliases)) continue;
      const named = collectionOf(aliases, kind, graph, types);
      if (named === null) continue;
      const callee = stamp(irLoadGlobal(named));
      editor.insertBefore(node, callee);
      editor.setInput(node, 0, callee);
      lowered += 1;
    }
  }
  if (lowered > 0) graph.rebuildUses();
  return lowered;
}
