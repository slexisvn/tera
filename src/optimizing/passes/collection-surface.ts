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
  IR_RETURN,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { arrayElementNameOf, iteratedArrayOf } from "./array-shapes.js";
import { memberCallTargets } from "./class-member-lowering.js";
import { genericCalleeName } from "../metadata/call-signatures.js";
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
const CALLEE_INPUT = 1;
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

export interface CollectionUnit {
  readonly graph: CFGFunction;
  readonly types: TypeInference;
}

interface CollectionFlavour {
  key: KeyKind | null;
  value: ValueKind | null;
}

interface CollectionSeed {
  readonly unit: CollectionUnit;
  readonly kind: string;
  readonly aliases: ReadonlySet<CFGInstruction>;
  readonly construction: CFGInstruction | null;
}

function collectionTypeNameOf(declared: string | null | undefined): string | null {
  if (typeof declared !== "string") return null;
  const named = declared.split("<")[0]!.trim();
  return COLLECTION_GLOBALS.has(named) ? named : null;
}

function calledGraphsOf(
  use: CFGInstruction,
  unit: CollectionUnit,
  byName: ReadonlyMap<string, CFGFunction>,
): readonly CFGFunction[] | null {
  const named = genericCalleeName(use);
  if (named !== null) {
    const graph = byName.get(named);
    return graph === undefined ? null : [graph];
  }
  const classes = unit.graph.classes;
  if (classes === null) return null;
  const targets = memberCallTargets(unit.graph, use, classes, unit.types);
  if (targets === null) return null;
  const graphs: CFGFunction[] = [];
  for (const symbol of targets.symbols) {
    const graph = byName.get(symbol);
    if (graph === undefined) return null;
    graphs.push(graph);
  }
  return graphs;
}

function passedAlong(
  use: CFGInstruction,
  value: CFGInstruction,
  kind: string,
  unit: CollectionUnit,
  byName: ReadonlyMap<string, CFGFunction>,
): boolean {
  if (use.type !== IR_GENERIC_CALL || use.inputs[0] === value) return false;
  const at = use.inputs.indexOf(value) - CALLEE_INPUT;
  const graphs = calledGraphsOf(use, unit, byName);
  if (graphs === null || at < 0) return false;
  return graphs.every(
    (graph) => collectionTypeNameOf(graph.declaredSignature?.params[at]) === kind,
  );
}

function sharedAcross(
  aliases: ReadonlySet<CFGInstruction>,
  kind: string,
  unit: CollectionUnit,
  byName: ReadonlyMap<string, CFGFunction>,
): boolean {
  for (const alias of aliases) {
    for (const use of alias.uses) {
      if (aliases.has(use)) continue;
      const called = calledMember(use, aliases);
      if (called !== null) {
        if (!supported(called)) return false;
        if (LISTED_MEMBERS.has(called) && !iteratedOnly(use)) return false;
        continue;
      }
      if (use.type === IR_RETURN) continue;
      if (passedAlong(use, alias, kind, unit, byName)) continue;
      if (use.type !== IR_GENERIC_GET_PROP || use.inputs[0] !== alias) return false;
      if (!supported(String(use.props.propName))) return false;
    }
  }
  return true;
}

function seedsOf(
  unit: CollectionUnit,
  byName: ReadonlyMap<string, CFGFunction>,
): readonly CollectionSeed[] | null {
  const seeds: CollectionSeed[] = [];
  const held: CFGInstruction[] = [];
  const kinds: string[] = [];
  for (const block of unit.graph.blocks) {
    for (const node of block.nodes) {
      const kind = namedConstruction(node, unit.graph);
      if (kind === null) continue;
      held.push(node);
      kinds.push(kind);
    }
  }
  const declared = unit.graph.declaredSignature;
  for (const parameter of unit.graph.parameters) {
    const named = collectionTypeNameOf(declared?.params[Number(parameter.props.index)]);
    if (named === null) continue;
    held.push(parameter);
    kinds.push(named);
  }
  for (const [at, value] of held.entries()) {
    const aliases = aliasesOf(value);
    const kind = kinds[at]!;
    if (!sharedAcross(aliases, kind, unit, byName)) return null;
    seeds.push({
      unit,
      kind,
      aliases,
      construction: value.type === IR_GENERIC_CALL ? value : null,
    });
  }
  return seeds;
}

function agreeOn(carried: CollectionFlavour, seed: CollectionSeed): boolean {
  for (const alias of seed.aliases) {
    for (const use of alias.uses) {
      const member = keyedCall(use, seed.aliases);
      if (member === null) continue;
      const held = use.inputs[KEY_ARGUMENT];
      if (held === undefined) return false;
      const named = keyKindOf(held, seed.unit.graph, seed.unit.types);
      if (named !== null) {
        if (carried.key !== null && carried.key !== named) return false;
        carried.key = named;
      }
      if (member !== VALUED_MEMBER || seed.kind !== MAP_GLOBAL) continue;
      const stored = use.inputs[VALUE_ARGUMENT];
      if (stored === undefined) return false;
      const found = valueKindOf(stored, seed.aliases, seed.unit.types);
      if (found === null) continue;
      const widest = widened(carried.value, found);
      if (widest === null) return false;
      carried.value = widest;
    }
  }
  return true;
}

function substituted(
  declared: string | null,
  named: ReadonlyMap<string, string>,
): string | null {
  const kind = collectionTypeNameOf(declared);
  return kind === null ? declared : named.get(kind) ?? declared;
}

function renameCollectionTypes(graph: CFGFunction, named: ReadonlyMap<string, string>): boolean {
  const declared = graph.declaredSignature;
  if (declared === undefined || declared === null) return false;
  const params = declared.params.map((param) => substituted(param, named));
  const returns = substituted(declared.returns, named);
  if (params.every((param, at) => param === declared.params[at]) && returns === declared.returns) {
    return false;
  }
  graph.declaredSignature = { ...declared, params, returns };
  return true;
}

export function shapeModuleCollections(
  units: readonly CollectionUnit[],
): readonly CFGFunction[] {
  const byName = new Map(units.map((unit) => [unit.graph.name, unit.graph]));
  const seeds: CollectionSeed[] = [];
  for (const unit of units) {
    const held = seedsOf(unit, byName);
    if (held === null) return [];
    seeds.push(...held);
  }
  if (seeds.length === 0) return [];

  const flavours = new Map<string, CollectionFlavour>();
  for (const seed of seeds) {
    let carried = flavours.get(seed.kind);
    if (carried === undefined) {
      carried = { key: null, value: null };
      flavours.set(seed.kind, carried);
    }
    if (!agreeOn(carried, seed)) return [];
  }

  const named = new Map<string, string>();
  for (const [kind, flavour] of flavours) {
    if (flavour.key === null) return [];
    named.set(
      kind,
      kind === SET_GLOBAL
        ? setClassName(flavour.key)
        : mapClassName(flavour.key, flavour.value ?? COUNTED_VALUE),
    );
  }

  const changed = new Set<CFGFunction>();
  for (const seed of seeds) {
    if (seed.construction === null) continue;
    const graph = seed.unit.graph;
    const editor = new GraphEditor(graph);
    const callee = nodeIdStamper(graph)(irLoadGlobal(named.get(seed.kind)!));
    editor.insertBefore(seed.construction, callee);
    editor.setInput(seed.construction, 0, callee);
    changed.add(graph);
  }
  for (const unit of units) {
    if (renameCollectionTypes(unit.graph, named)) changed.add(unit.graph);
  }
  for (const graph of changed) graph.rebuildUses();
  return [...changed];
}
