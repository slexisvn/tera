import {
  irGenericCall,
  irGenericGetProp,
  irLoadGlobal,
  IR_GENERIC_ADD,
  IR_GENERIC_CALL,
  IR_GENERIC_DIV,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_PROP,
  IR_GENERIC_MUL,
  IR_GENERIC_SUB,
  IR_ITERATOR_INIT,
  IR_LOAD_GLOBAL,
  IR_PARAMETER,
  IR_STORE_GLOBAL,
  IR_PHI,
  IR_RETURN,
  type CFGFunction,
  type CFGInstruction,
  calleeSymbolName,
  genericCalleeName,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";

import type { ClassTable } from "../metadata/class-table.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { producedTypeName } from "./array-shapes.js";
import { memberCallTargets } from "./class-member-lowering.js";

import {
  mapClassName,
  setClassName,
  COLLECTION_GLOBALS,
  MAP_GLOBAL,
  SET_GLOBAL,
  type KeyKind,
  type ValueKind,
} from "../prelude/collections.js";

type Stamp = (node: CFGInstruction) => CFGInstruction;

const KEYED_MEMBERS: ReadonlySet<string> = new Set(["set", "get", "has", "add", "delete"]);
const CALLEE_INPUT = 1;
const VALUES_MEMBER = "values";
const ENTRIES_MEMBER = "entries";
const LISTED_MEMBERS: ReadonlySet<string> = new Set(["keys", VALUES_MEMBER, ENTRIES_MEMBER]);
const SIZE_MEMBER = "size";
const VALUED_MEMBER = "set";
const RECEIVER = 1;
const KEY_ARGUMENT = 2;
const VALUE_ARGUMENT = 3;
const COUNTED_VALUE: ValueKind = "int";
const RECEIVER_SLOT = 0;
const MEMBER_SLOT_PREFIX = "member:";

const KEY_BY_KIND: ReadonlyMap<string, KeyKind> = new Map<string, KeyKind>([
  [TypeKind.String, "string"],
  [TypeKind.Smi, "int"],
  [TypeKind.Double, "float"],
]);

const KIND_BY_NAME: ReadonlyMap<string, KeyKind> = new Map<string, KeyKind>([
  ["string", "string"],
  ["int", "int"],
  ["float", "float"],
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

function iteratesDirectly(use: CFGInstruction, kind: string): boolean {
  return use.type === IR_ITERATOR_INIT;
}

function listingMemberFor(kind: string): string {
  return kind === SET_GLOBAL ? VALUES_MEMBER : ENTRIES_MEMBER;
}

function heldWithin(aliases: ReadonlySet<CFGInstruction>, kind: string): boolean {
  for (const alias of aliases) {
    for (const use of alias.uses) {
      if (aliases.has(use)) continue;
      if (iteratesDirectly(use, kind)) continue;
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

const NUMERIC_VALUES: ReadonlySet<string> = new Set<string>(["int", "float"]);

function widened(carried: ValueKind | null, found: ValueKind): ValueKind | null {
  if (carried === null || carried === found) return found;
  if (!NUMERIC_VALUES.has(carried) || !NUMERIC_VALUES.has(found)) return null;
  return "float";
}

const GENERATED_PREFIX = "Tera";

function programClass(name: string | null, classes: ClassTable | null): ValueKind | null {
  if (name === null || classes === null || name.startsWith(GENERATED_PREFIX)) return null;
  return classes.shapeOf(name) === null ? null : name;
}

function classValueKind(
  node: CFGInstruction,
  types: TypeInference,
  classes: ClassTable | null,
): ValueKind | null {
  const type = types.typeOf(node);
  if (type.kind === TypeKind.Object && typeof type.map === "number" && classes !== null) {
    const shape = classes.shapeById(type.map);
    const named = programClass(shape?.name ?? null, classes);
    if (named !== null) return named;
  }
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const callee = node.inputs[0];
  if (callee?.type !== IR_LOAD_GLOBAL) return null;
  const name = callee.props.name;
  return programClass(typeof name === "string" ? name : null, classes);
}

function kindOf<T>(type: LatticeType, table: ReadonlyMap<string, T>): T | null {
  return table.get(type.kind) ?? null;
}

function producedName(
  value: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): string | null {
  const classes = graph.classes;
  return classes === null ? null : producedTypeName(value, graph, classes, types);
}

function keyKindOf(
  value: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): KeyKind | null {
  const named = kindOf(types.typeOf(value), KEY_BY_KIND);
  if (named !== null) return named;
  const produced = producedName(value, graph, types);
  return produced === null ? null : (KIND_BY_NAME.get(produced) ?? null);
}

function divided(node: CFGInstruction): ValueKind | null {
  return node.type === IR_GENERIC_DIV ? "float" : null;
}

function producedValueKind(
  node: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): ValueKind | null {
  const produced = producedName(node, graph, types);
  if (produced === null) return null;
  return KIND_BY_NAME.get(produced) ?? programClass(produced, graph.classes);
}

function valueKindOf(
  stored: CFGInstruction,
  aliases: ReadonlySet<CFGInstruction>,
  graph: CFGFunction,
  types: TypeInference,
): ValueKind | null {
  const classes = graph.classes;
  const seen = new Set<CFGInstruction>();
  const pending: CFGInstruction[] = [stored];
  let carried: ValueKind | null = null;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (calledMember(node, aliases) !== null) continue;
    const named =
      kindOf(types.typeOf(node), VALUE_BY_KIND) ??
      classValueKind(node, types, classes) ??
      divided(node) ??
      producedValueKind(node, graph, types);
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
      const found = valueKindOf(stored, aliases, graph, types);
      if (found === null) return null;
      value = widened(value, found);
      if (value === null) return null;
    }
  }
  if (key === null) return null;
  return kind === SET_GLOBAL ? setClassName(key) : mapClassName(key, value ?? COUNTED_VALUE);
}

function listDirectIteration(
  editor: GraphEditor,
  aliases: ReadonlySet<CFGInstruction>,
  kind: string,
  stamp: Stamp,
): number {
  let listed = 0;
  for (const alias of aliases) {
    for (const use of [...alias.uses]) {
      if (!iteratesDirectly(use, kind)) continue;
      const member = stamp(irGenericGetProp(alias, listingMemberFor(kind)));
      const call = stamp(irGenericCall(member, [alias]));
      call.props.isMethod = true;
      call.frameState = use.frameState;
      editor.insertBefore(use, member);
      editor.insertBefore(use, call);
      editor.setInput(use, use.inputs.indexOf(alias), call);
      listed += 1;
    }
  }
  return listed;
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
      if (!heldWithin(aliases, kind)) continue;
      const named = collectionOf(aliases, kind, graph, types);
      if (named === null) continue;
      const callee = stamp(irLoadGlobal(named));
      editor.insertBefore(node, callee);
      editor.setInput(node, 0, callee);
      listDirectIteration(editor, aliases, kind, stamp);
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
  readonly staticSlot: string | null;
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

type UnitLookup = (node: CFGInstruction) => CollectionUnit;

function ownersOf(units: readonly CollectionUnit[]): UnitLookup {
  const owner = new Map<CFGInstruction, CollectionUnit>();
  for (const unit of units) {
    for (const parameter of unit.graph.parameters) owner.set(parameter, unit);
    for (const block of unit.graph.blocks) {
      for (const phi of block.phis) owner.set(phi, unit);
      for (const node of block.nodes) owner.set(node, unit);
    }
  }
  return (node) => owner.get(node) ?? units[0]!;
}

function heldFieldKeyOf(node: CFGInstruction, graph: CFGFunction): string | null {
  const owner = node.inputs[0];
  if (owner === undefined) return null;
  const member = String(node.props.propName);
  if (owner.type === IR_LOAD_GLOBAL) return `field:${String(owner.props.name)}.${member}`;
  if (graph.classOwner === null || graph.receiver !== true) return null;
  if (owner.type !== IR_PARAMETER || Number(owner.props.index) !== RECEIVER_SLOT) return null;
  return `${MEMBER_SLOT_PREFIX}${graph.classOwner}.${member}`;
}

function slotKeyOf(node: CFGInstruction, graph: CFGFunction): string | null {
  if (node.type === IR_STORE_GLOBAL || node.type === IR_LOAD_GLOBAL) {
    const name = node.props.name;
    return typeof name === "string" ? `global:${name}` : null;
  }
  if (node.type === IR_GENERIC_SET_PROP || node.type === IR_GENERIC_GET_PROP) {
    return heldFieldKeyOf(node, graph);
  }
  return null;
}

function storesHeld(use: CFGInstruction, held: CFGInstruction): boolean {
  if (use.type === IR_STORE_GLOBAL) return use.inputs[0] === held;
  return use.type === IR_GENERIC_SET_PROP && use.inputs[1] === held;
}

function slotReads(units: readonly CollectionUnit[]): ReadonlyMap<string, CFGInstruction[]> {
  const reads = new Map<string, CFGInstruction[]>();
  for (const unit of units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_LOAD_GLOBAL && node.type !== IR_GENERIC_GET_PROP) continue;
        const key = slotKeyOf(node, unit.graph);
        if (key === null) continue;
        const bucket = reads.get(key);
        if (bucket === undefined) reads.set(key, [node]);
        else bucket.push(node);
      }
    }
  }
  return reads;
}

function slotBehind(
  aliases: ReadonlySet<CFGInstruction>,
  unitOf: UnitLookup,
): string | null {
  let key: string | null = null;
  for (const alias of aliases) {
    for (const use of alias.uses) {
      if (!storesHeld(use, alias)) continue;
      const found = slotKeyOf(use, unitOf(use).graph);
      if (found === null || (key !== null && key !== found)) return null;
      key = found;
    }
  }
  return key;
}

function sharedAcross(
  aliases: ReadonlySet<CFGInstruction>,
  kind: string,
  unit: CollectionUnit,
  byName: ReadonlyMap<string, CFGFunction>,
  unitOf: UnitLookup,
): boolean {
  for (const alias of aliases) {
    for (const use of alias.uses) {
      if (aliases.has(use)) continue;
      if (iteratesDirectly(use, kind)) continue;
      const called = calledMember(use, aliases);
      if (called !== null) {
        if (!supported(called)) return false;
        if (LISTED_MEMBERS.has(called) && !iteratedOnly(use)) return false;
        continue;
      }
      if (use.type === IR_RETURN) continue;
      if (storesHeld(use, alias) && slotKeyOf(use, unitOf(use).graph) !== null) continue;
      if (passedAlong(use, alias, kind, unit, byName)) continue;
      if (use.type !== IR_GENERIC_GET_PROP || use.inputs[0] !== alias) return false;
      if (!supported(String(use.props.propName))) return false;
    }
  }
  return true;
}

function callsTo(units: readonly CollectionUnit[]): ReadonlyMap<string, CFGInstruction[]> {
  const called = new Map<string, CFGInstruction[]>();
  for (const unit of units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        const name = calledFunctionName(node);
        if (name === null) continue;
        const bucket = called.get(name);
        if (bucket === undefined) called.set(name, [node]);
        else bucket.push(node);
      }
    }
  }
  return called;
}

function calledFunctionName(node: CFGInstruction): string | null {
  if (node.type === IR_CALL_KNOWN_FUNCTION) return calleeSymbolName(node);
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const callee = node.inputs[0];
  if (callee?.type !== IR_LOAD_GLOBAL) return null;
  const name = callee.props.name;
  return typeof name === "string" ? name : null;
}

interface SlotIndex {
  readonly reads: ReadonlyMap<string, readonly CFGInstruction[]>;
  readonly calls: ReadonlyMap<string, readonly CFGInstruction[]>;
}

const STATIC_INIT_SUFFIX = "$init";

function staticSlotOf(graph: CFGFunction): string | null {
  const owner = graph.classOwner;
  if (owner === null || !graph.name.endsWith(STATIC_INIT_SUFFIX)) return null;
  const field = graph.name.slice(owner.length + 1, -STATIC_INIT_SUFFIX.length);
  return field.length === 0 ? null : `field:${owner}.${field}`;
}

function widenedThroughSlot(
  held: ReadonlySet<CFGInstruction>,
  owner: CollectionUnit,
  index: SlotIndex,
  unitOf: UnitLookup,
): ReadonlySet<CFGInstruction> {
  let aliases = held;
  for (let round = 0; round < 2; round++) {
    const widened = new Set(aliases);
    const key = slotBehind(aliases, unitOf) ?? staticSlotOf(owner.graph);
    for (const read of key === null ? [] : index.reads.get(key) ?? []) {
      for (const alias of aliasesOf(read)) widened.add(alias);
    }
    if ([...aliases].some((alias) => alias.uses.some((use) => use.type === IR_RETURN))) {
      for (const call of index.calls.get(owner.graph.name) ?? []) {
        for (const alias of aliasesOf(call)) widened.add(alias);
      }
    }
    if (widened.size === aliases.size) return aliases;
    aliases = widened;
  }
  return aliases;
}

function calledCollection(
  node: CFGInstruction,
  unit: CollectionUnit,
  byName: ReadonlyMap<string, CFGFunction>,
): string | null {
  if (node.type !== IR_GENERIC_CALL && node.type !== IR_CALL_KNOWN_FUNCTION) return null;
  const graphs = calledGraphsOf(node, unit, byName);
  if (graphs === null || graphs.length === 0) return null;
  let carried: string | null = null;
  for (const graph of graphs) {
    const named = collectionTypeNameOf(graph.declaredSignature?.returns);
    if (named === null || (carried !== null && carried !== named)) return null;
    carried = named;
  }
  return carried;
}

function seedsOf(
  unit: CollectionUnit,
  byName: ReadonlyMap<string, CFGFunction>,
  index: SlotIndex,
  unitOf: UnitLookup,
): readonly CollectionSeed[] | null {
  const seeds: CollectionSeed[] = [];
  const held: CFGInstruction[] = [];
  const kinds: string[] = [];
  for (const block of unit.graph.blocks) {
    for (const node of block.nodes) {
      const kind = namedConstruction(node, unit.graph);
      if (kind !== null) {
        held.push(node);
        kinds.push(kind);
        continue;
      }
      const answered = calledCollection(node, unit, byName);
      if (answered === null) continue;
      held.push(node);
      kinds.push(answered);
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
    const aliases = widenedThroughSlot(aliasesOf(value), unit, index, unitOf);
    const kind = kinds[at]!;
    if (!sharedAcross(aliases, kind, unit, byName, unitOf)) return null;
    seeds.push({
      unit,
      kind,
      aliases,
      construction: value.type === IR_GENERIC_CALL ? value : null,
      staticSlot: staticSlotOf(unit.graph),
    });
  }
  return seeds;
}

function agreeOn(
  carried: CollectionFlavour,
  seed: CollectionSeed,
  unitOf: UnitLookup,
): boolean {
  for (const alias of seed.aliases) {
    const owner = unitOf(alias);
    for (const use of alias.uses) {
      const member = keyedCall(use, seed.aliases);
      if (member === null) continue;
      const held = use.inputs[KEY_ARGUMENT];
      if (held === undefined) return false;
      const named = keyKindOf(held, owner.graph, owner.types);
      if (named !== null) {
        if (carried.key !== null && carried.key !== named) return false;
        carried.key = named;
      }
      if (member !== VALUED_MEMBER || seed.kind !== MAP_GLOBAL) continue;
      const stored = use.inputs[VALUE_ARGUMENT];
      if (stored === undefined) return false;
      const found = valueKindOf(stored, seed.aliases, owner.graph, owner.types);
      if (found === null) return false;
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

function retypeHeldFields(
  units: readonly CollectionUnit[],
  named: ReadonlyMap<string, string>,
): void {
  const classes = units[0]?.graph.classes ?? null;
  if (classes === null) return;
  for (const shape of classes.shapes()) {
    for (const field of [...shape.fields.values(), ...shape.staticFields.values()]) {
      const held = named.get(field.declaredType);
      if (held === undefined) continue;
      classes.retypeField(shape.name, field.name, held);
    }
  }
}

export function shapeModuleCollections(
  units: readonly CollectionUnit[],
): readonly CFGFunction[] {
  const byName = new Map(units.map((unit) => [unit.graph.name, unit.graph]));
  const index: SlotIndex = { reads: slotReads(units), calls: callsTo(units) };
  const unitOf = ownersOf(units);
  const seeds: CollectionSeed[] = [];
  for (const unit of units) {
    const held = seedsOf(unit, byName, index, unitOf);
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
    if (!agreeOn(carried, seed, unitOf)) return [];
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

  retypeHeldFields(units, named);

  for (const seed of seeds) {
    if (seed.staticSlot === null) continue;
    const [owner, field] = seed.staticSlot.slice("field:".length).split(".");
    const classes = seed.unit.graph.classes;
    if (owner === undefined || field === undefined || classes === null) continue;
    classes.declareStaticField(owner, field, named.get(seed.kind)!);
  }

  const changed = new Set<CFGFunction>();
  for (const seed of seeds) {
    const graph = seed.unit.graph;
    const editor = new GraphEditor(graph);
    const stamp = nodeIdStamper(graph);
    if (listDirectIteration(editor, seed.aliases, seed.kind, stamp) > 0) changed.add(graph);
    if (seed.construction === null) continue;
    const callee = stamp(irLoadGlobal(named.get(seed.kind)!));
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
