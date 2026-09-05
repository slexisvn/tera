import {
  irCallKnownFunction,
  irLoadField,
  irNewObject,
  irStoreField,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_LOAD_CONTEXT_SLOT,
  IR_MAKE_CLOSURE,
  IR_RETURN,
  IR_STORE_CONTEXT_SLOT,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { AnalysisManager } from "../infra/analysis-manager.js";
import { DominatorTree } from "../analyses/dominance.js";
import { createAnalysisRegistry } from "../analyses/index.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import {
  declaredTypeOf,
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  INSTANCE_SIZE_PROP,
  VALUE_CLASS_PROP,
  type ClassShape,
  type ClassTable,
} from "./class-table.js";
import { syntheticSurface } from "./coroutines.js";
import { declaredTypeNameOf } from "./call-signatures.js";
import { FUNCTION_TARGET_PROP, ModuleFunctions } from "./module-functions.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";

const LOCAL_CAPTURE = "local";
const UPVALUE_CAPTURE = "upvalue";
const CAPTURED_PARAMETER_NAME = "captured";
const SINGLE_CAPTURE = 1;
const CAPTURE_SLOT = 0;
const CLOSURE_FRAME_PREFIX = "tera_closure";

function capturedFieldName(slot: number): string {
  return `${CAPTURED_PARAMETER_NAME}${slot}`;
}

export const CLOSURE_CAPTURE_PROP = "carriesCapture";

export function carriesCapture(value: CFGInstruction): boolean {
  return value.props[CLOSURE_CAPTURE_PROP] === true;
}

interface Held {
  readonly slot: number;
  readonly value: CFGInstruction;
  readonly declaredType: string;
}

interface Closure {
  readonly unit: CompilationUnit;
  readonly creator: CompilationUnit;
  readonly held: readonly Held[];
  readonly captured: CFGInstruction;
  readonly capturedType: string;
  readonly frame: ClassShape | null;
}

function contextSlots(graph: CFGFunction, source: string): CFGInstruction[] {
  const nodes: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_LOAD_CONTEXT_SLOT && node.type !== IR_STORE_CONTEXT_SLOT) continue;
      if (String(node.props.source) === source) nodes.push(node);
    }
  }
  return nodes;
}

function makesClosure(graph: CFGFunction, compiled: RegisterCompiledFunction): CFGInstruction | null {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_MAKE_CLOSURE) continue;
      if (node.props.compiled === compiled) return node;
    }
  }
  return null;
}

function storedInSlot(graph: CFGFunction, slot: number): CFGInstruction | null {
  let value: CFGInstruction | null = null;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_STORE_CONTEXT_SLOT) continue;
      if (String(node.props.source) !== LOCAL_CAPTURE || Number(node.props.slot) !== slot) continue;
      if (value !== null) return null;
      value = node.inputs[0] ?? null;
    }
  }
  return value;
}

function analysesOf(unit: CompilationUnit): AnalysisManager<CFGFunction> {
  return unit.analyses ?? new AnalysisManager<CFGFunction>(unit.graph, createAnalysisRegistry());
}

function heldValuesOf(
  unit: CompilationUnit,
  creator: CompilationUnit,
  classes: ClassTable,
): readonly Held[] | null {
  const compiled = unit.compiledFunction!;
  const types = analysesOf(creator).get(typeInferenceAnalysisId);
  const held: Held[] = [];
  for (const [slot, upvalue] of compiled.upvalues.entries()) {
    if (upvalue?.outerType !== LOCAL_CAPTURE || upvalue.outerSlot === undefined) return null;
    const value = storedInSlot(creator.graph, upvalue.outerSlot);
    if (value === null) return null;
    const declaredType =
      declaredTypeOf(types.typeOf(value), classes) ??
      declaredTypeNameOf(value, creator.graph, classes, types);
    if (declaredType === null) return null;
    held.push({ slot, value, declaredType });
  }
  return held;
}

function capturedOf(
  unit: CompilationUnit,
  creator: CompilationUnit,
  classes: ClassTable,
): Closure | null {
  const compiled = unit.compiledFunction;
  if (compiled === null || compiled.upvalues.length === 0) return null;
  if (contextSlots(unit.graph, LOCAL_CAPTURE).length > 0) return null;
  const read = new Set<number>();
  for (const node of contextSlots(unit.graph, UPVALUE_CAPTURE)) {
    if (node.type === IR_STORE_CONTEXT_SLOT) return null;
    read.add(Number(node.props.slot));
  }
  const held = heldValuesOf(unit, creator, classes);
  if (held === null) return null;
  for (const slot of read) {
    if (!held.some((one) => one.slot === slot)) return null;
  }
  if (held.length === SINGLE_CAPTURE) {
    const only = held[CAPTURE_SLOT]!;
    return {
      unit,
      creator,
      held,
      captured: only.value,
      capturedType: only.declaredType,
      frame: null,
    };
  }
  const frame = closureFrameShape(classes, unit.graph.name, held);
  const captured = buildFrame(creator.graph, frame, held);
  return captured === null
    ? null
    : { unit, creator, held, captured, capturedType: frame.name, frame };
}

function closureFrameShape(
  classes: ClassTable,
  fn: string,
  held: readonly Held[],
): ClassShape {
  return classes.defineSynthetic(
    syntheticSurface(
      `${CLOSURE_FRAME_PREFIX}$${fn}`,
      null,
      held.map((one) => [capturedFieldName(one.slot), one.declaredType] as const),
    ),
  );
}

function buildFrame(
  graph: CFGFunction,
  frame: ClassShape,
  held: readonly Held[],
): CFGInstruction | null {
  const placed = held.map((one) => one.value).filter((value) => value.block !== null);
  const dominance = new DominatorTree(graph);
  const last = placed.reduce(
    (carried: CFGInstruction | null, value) =>
      carried === null || precedes(dominance, carried, value) ? value : carried,
    null,
  );
  if (last !== null && !placed.every((value) => reaches(dominance, value, last))) return null;
  const entry = graph.blocks[0]?.nodes[0] ?? null;
  if (last === null && entry === null) return null;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  const allocation = stamp(irNewObject());
  allocation.props[CLASS_ID_PROP] = frame.id;
  allocation.props[INSTANCE_SIZE_PROP] = frame.size;
  allocation.props[VALUE_CLASS_PROP] = frame.id;
  if (last === null) editor.insertBefore(entry!, allocation);
  else editor.insertAfter(last, allocation);
  let after: CFGInstruction = allocation;
  for (const one of held) {
    const field = frame.fields.get(capturedFieldName(one.slot))!;
    const store = stamp(
      irStoreField(allocation, field.offset, one.value, capturedFieldName(one.slot)),
    );
    store.props[FIELD_TYPE_PROP] = one.declaredType;
    store.props[FIELD_SCALAR_PROP] = field.scalar;
    editor.insertAfter(after, store);
    after = store;
  }
  graph.rebuildUses();
  return allocation;
}

function precedes(
  dominance: DominatorTree,
  left: CFGInstruction,
  right: CFGInstruction,
): boolean {
  if (left.block === null) return true;
  if (right.block === null) return false;
  if (left.block === right.block) {
    return left.block.nodes.indexOf(left) < right.block.nodes.indexOf(right);
  }
  return dominance.dominates(left.block, right.block);
}

function reaches(
  dominance: DominatorTree,
  definition: CFGInstruction,
  at: CFGInstruction,
): boolean {
  return definition === at || precedes(dominance, definition, at);
}

function liftBody(closure: Closure): void {
  const graph = closure.unit.graph;
  const parameter = graph.addParameter(graph.parameterCount);
  graph.parameters.pop();
  graph.parameters.unshift(parameter);
  graph.parameters.forEach((held, index) => {
    held.props.index = index;
  });
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  const { frame } = closure;
  for (const node of contextSlots(graph, UPVALUE_CAPTURE)) {
    const held =
      frame === null ? parameter : readCapture(editor, stamp, frame, parameter, node);
    editor.replaceAllUses(node, held);
    editor.remove(node);
  }
  const declared = graph.declaredSignature;
  graph.declaredSignature = {
    ...(declared ?? {}),
    params: [closure.capturedType, ...(declared?.params ?? [])],
    ...(declared?.names === undefined
      ? {}
      : { names: [CAPTURED_PARAMETER_NAME, ...declared.names] }),
    ...(declared?.defaults === undefined
      ? {}
      : { defaults: [undefined, ...declared.defaults] }),
    returns: declared?.returns ?? null,
  };
  graph.rebuildUses();
}

function readCapture(
  editor: GraphEditor,
  stamp: (node: CFGInstruction) => CFGInstruction,
  frame: ClassShape,
  parameter: CFGInstruction,
  node: CFGInstruction,
): CFGInstruction {
  const name = capturedFieldName(Number(node.props.slot));
  const field = frame.fields.get(name)!;
  const read = stamp(irLoadField(parameter, field.offset));
  read.props.propName = name;
  read.props[FIELD_TYPE_PROP] = field.declaredType;
  read.props[FIELD_SCALAR_PROP] = field.scalar;
  editor.insertBefore(node, read);
  return read;
}

function retireCreator(closure: Closure): void {
  const graph = closure.creator.graph;
  const editor = new GraphEditor(graph);
  const made = makesClosure(graph, closure.unit.compiledFunction!);
  if (made !== null) {
    editor.replaceAllUses(made, closure.captured);
    editor.remove(made);
  }
  const bySlot = new Map(closure.held.map((one) => [one.slot, one.value] as const));
  for (const node of contextSlots(graph, LOCAL_CAPTURE)) {
    if (node.type === IR_LOAD_CONTEXT_SLOT) {
      editor.replaceAllUses(node, bySlot.get(Number(node.props.slot)) ?? closure.captured);
    }
    editor.remove(node);
  }
  graph.rebuildUses();
}

function answersClosure(graph: CFGFunction, captured: CFGInstruction): boolean {
  let answered = false;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_RETURN) continue;
      if (node.inputs[0] !== captured) return false;
      answered = true;
    }
  }
  return answered;
}

class Conversion {
  private readonly identities = new Map<CFGInstruction, CompilationUnit>();
  private readonly answering = new Map<string, CompilationUnit>();

  constructor(
    private readonly module: ModuleIR,
    private readonly classes: ClassTable,
  ) {}

  run(): number {
    const functions = new ModuleFunctions(this.module);
    const closures: Closure[] = [];
    for (const unit of this.module.units) {
      const compiled = unit.compiledFunction;
      if (compiled === null || compiled.upvalues.length === 0) continue;
      const creator = this.creatorOf(compiled);
      if (creator === null) continue;
      const closure = capturedOf(unit, creator, this.classes);
      if (closure !== null) closures.push(closure);
    }
    if (closures.length === 0) return 0;

    for (const closure of closures) {
      liftBody(closure);
      retireCreator(closure);
      closure.unit.analyses?.invalidateAll();
      closure.creator.analyses?.invalidateAll();
      this.identities.set(closure.captured, closure.unit);
      if (answersClosure(closure.creator.graph, closure.captured)) {
        this.answering.set(closure.creator.graph.name, closure.unit);
        closure.creator.graph.declaredSignature = {
          params: closure.creator.graph.declaredSignature?.params ?? [],
          returns: closure.capturedType,
        };
      }
    }

    let rewritten = 0;
    for (const unit of this.module.units) {
      this.markClosureValues(unit, functions);
      rewritten += this.rewriteCalls(unit, functions);
    }
    return rewritten;
  }

  private markClosureValues(unit: CompilationUnit, functions: ModuleFunctions): void {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        const answered = this.calledClosure(node, functions);
        if (answered === null) continue;
        node.props[FUNCTION_TARGET_PROP] = answered.graph.name;
        node.props[CLOSURE_CAPTURE_PROP] = true;
      }
    }
  }

  private creatorOf(compiled: RegisterCompiledFunction): CompilationUnit | null {
    for (const unit of this.module.units) {
      const owner = unit.compiledFunction;
      if (owner === null) continue;
      for (const value of owner.constants) {
        if (value === compiled) return unit;
      }
    }
    return null;
  }

  private calledClosure(
    callee: CFGInstruction | undefined,
    functions: ModuleFunctions,
  ): CompilationUnit | null {
    if (callee === undefined) return null;
    const direct = this.identities.get(callee);
    if (direct !== undefined) return direct;
    if (callee.type !== IR_CALL_KNOWN_FUNCTION && callee.type !== IR_GENERIC_CALL) return null;
    const answered = functions.referenced(callee.inputs[0]);
    return answered === null ? null : this.answering.get(answered.name) ?? null;
  }

  private rewriteCalls(unit: CompilationUnit, functions: ModuleFunctions): number {
    const graph = unit.graph;
    const editor = new GraphEditor(graph);
    const stamp = nodeIdStamper(graph);
    let rewritten = 0;
    for (const block of graph.blocks) {
      for (const node of [...block.nodes]) {
        if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) continue;
        const callee = node.inputs[0];
        const target = this.calledClosure(callee, functions);
        if (target === null || functions.referenced(callee) !== null) continue;
        const call = stamp(
          irCallKnownFunction({ name: target.graph.name } as never, [
            callee!,
            ...node.inputs.slice(1),
          ]),
        );
        call.props.target = {
          name: target.graph.name,
          declaredSignature: target.graph.declaredSignature,
        } as never;
        call.frameState = node.frameState;
        editor.insertBefore(node, call);
        editor.replaceAllUses(node, call);
        editor.remove(node);
        rewritten += 1;
      }
    }
    if (rewritten > 0) graph.rebuildUses();
    return rewritten;
  }
}

export function convertClosures(module: ModuleIR, classes: ClassTable | null): number {
  if (classes === null) return 0;
  return new Conversion(module, classes).run();
}

export type { Closure };
