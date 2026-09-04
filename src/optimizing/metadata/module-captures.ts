import {
  irConstant,
  irLoadGlobal,
  irStoreGlobal,
  IR_CONSTANT,
  IR_MAKE_CLOSURE,
  IR_LOAD_CONTEXT_SLOT,
  IR_STORE_CONTEXT_SLOT,
  type CFGFunction,
  type CFGInstruction,
  type ContextSlotSource,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import { superClassBindingOwner } from "../../core/class-member.js";
import type { ClassTable } from "./class-table.js";
import type { ModuleIR } from "../compilation-unit.js";
import { cellKey } from "../../runtime/intrinsics/global-cells.js";

const LOCAL_CAPTURE: ContextSlotSource = "local";
const UPVALUE_CAPTURE: ContextSlotSource = "upvalue";

type Creators = ReadonlyMap<RegisterCompiledFunction, RegisterCompiledFunction>;

function nestedFunctionsOf(fn: RegisterCompiledFunction): readonly RegisterCompiledFunction[] {
  const nested: RegisterCompiledFunction[] = [];
  for (const value of fn.constants) {
    if (value instanceof RegisterCompiledFunction) nested.push(value);
  }
  return nested;
}

function creatorsIn(module: ModuleIR): Creators {
  const creators = new Map<RegisterCompiledFunction, RegisterCompiledFunction>();
  for (const unit of module.units) {
    if (unit.compiledFunction === null) continue;
    for (const nested of nestedFunctionsOf(unit.compiledFunction)) {
      creators.set(nested, unit.compiledFunction);
    }
  }
  return creators;
}

type NameFilter = (name: string | null) => string | null;

function scopedName(
  scope: RegisterCompiledFunction,
  slot: number,
  fallback: string | null,
  isVariable: NameFilter,
): string | null {
  const held = isVariable(scope.localNames[slot] ?? fallback);
  return held === null ? null : cellKey(scope.moduleSpec, held);
}

function moduleVariableOf(
  fn: RegisterCompiledFunction,
  index: number,
  creators: Creators,
  scopes: ReadonlySet<RegisterCompiledFunction>,
  isVariable: NameFilter,
): string | null {
  const upvalue = fn.upvalues[index];
  const creator = creators.get(fn);
  if (upvalue === undefined || creator === undefined || upvalue.outerSlot === undefined) {
    return null;
  }
  if (upvalue.outerType === UPVALUE_CAPTURE) {
    return moduleVariableOf(creator, upvalue.outerSlot, creators, scopes, isVariable);
  }
  if (upvalue.outerType !== LOCAL_CAPTURE || !scopes.has(creator)) return null;
  return scopedName(creator, upvalue.outerSlot, upvalue.name ?? null, isVariable);
}

function isUndefinedConstant(value: CFGInstruction | undefined): boolean {
  return value !== undefined && value.type === IR_CONSTANT && value.props.value === undefined;
}

function rewrite(
  graph: CFGFunction,
  nameOf: (node: CFGInstruction) => string | null,
): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let rewritten = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.type !== IR_LOAD_CONTEXT_SLOT && node.type !== IR_STORE_CONTEXT_SLOT) continue;
      const name = nameOf(node);
      if (name === null) continue;
      if (node.type === IR_STORE_CONTEXT_SLOT && isUndefinedConstant(node.inputs[0])) {
        editor.remove(node);
        rewritten += 1;
        continue;
      }
      const replacement = stamp(
        node.type === IR_LOAD_CONTEXT_SLOT
          ? irLoadGlobal(name)
          : irStoreGlobal(name, node.inputs[0]!),
      );
      replacement.frameState = node.frameState;
      editor.insertBefore(node, replacement);
      editor.replaceAllUses(node, replacement);
      editor.remove(node);
      rewritten += 1;
    }
  }
  if (rewritten > 0) graph.rebuildUses();
  return rewritten;
}

const CLOSURE_PROPS: ReadonlySet<string> = new Set(["constIdx", "compiled", "captures"]);

function unwrapClosures(
  graph: CFGFunction,
  lowered: ReadonlySet<RegisterCompiledFunction>,
): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let unwrapped = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.type !== IR_MAKE_CLOSURE) continue;
      const compiled = node.props.compiled;
      if (!(compiled instanceof RegisterCompiledFunction) || !lowered.has(compiled)) continue;
      const replacement = stamp(irConstant(compiled));
      for (const [key, value] of Object.entries(node.props)) {
        if (!CLOSURE_PROPS.has(key)) replacement.props[key] = value;
      }
      replacement.frameState = node.frameState;
      editor.insertBefore(node, replacement);
      editor.replaceAllUses(node, replacement);
      editor.remove(node);
      unwrapped += 1;
    }
  }
  if (unwrapped > 0) graph.rebuildUses();
  return unwrapped;
}

function sourceOf(node: CFGInstruction): string {
  return String(node.props.source);
}

function slotOf(node: CFGInstruction): number {
  return Number(node.props.slot);
}

export function lowerModuleCaptures(module: ModuleIR, entryName: string): number {
  const entryUnit = module.units.find((unit) => unit.graph.name === entryName);
  const entry = entryUnit?.compiledFunction ?? null;
  if (entryUnit === undefined || entry === null) return 0;
  const creators = creatorsIn(module);
  const classes: ClassTable | null = entryUnit.graph.classes;
  const isVariable = (name: string | null): string | null => {
    if (name === null || superClassBindingOwner(name) !== null) return null;
    return classes?.shapeOf(name) == null ? name : null;
  };

  const scopes = new Set<RegisterCompiledFunction>();
  for (const unit of module.units) {
    const compiled = unit.compiledFunction;
    if (compiled !== null && !creators.has(compiled)) scopes.add(compiled);
  }
  scopes.add(entry);

  let rewritten = 0;
  for (const unit of module.units) {
    const compiled = unit.compiledFunction;
    if (compiled === null || !scopes.has(compiled)) continue;
    const changed = rewrite(unit.graph, (node) =>
      sourceOf(node) === LOCAL_CAPTURE
        ? scopedName(compiled, slotOf(node), null, isVariable)
        : null,
    );
    if (changed > 0) unit.analyses?.invalidateAll();
    rewritten += changed;
  }

  const lowered = new Set<RegisterCompiledFunction>();
  for (const unit of module.units) {
    const compiled = unit.compiledFunction;
    if (compiled === null || scopes.has(compiled)) continue;
    const variableOf = (index: number) =>
      moduleVariableOf(compiled, index, creators, scopes, isVariable);
    if (
      compiled.upvalues.length > 0 &&
      compiled.upvalues.every((_, index) => variableOf(index) !== null)
    ) {
      lowered.add(compiled);
    }
    const changed = rewrite(unit.graph, (node) =>
      sourceOf(node) === UPVALUE_CAPTURE ? variableOf(slotOf(node)) : null,
    );
    if (changed > 0) unit.analyses?.invalidateAll();
    rewritten += changed;
  }

  if (lowered.size === 0) return rewritten;
  for (const unit of module.units) {
    const unwrapped = unwrapClosures(unit.graph, lowered);
    if (unwrapped > 0) unit.analyses?.invalidateAll();
    rewritten += unwrapped;
  }
  return rewritten;
}
