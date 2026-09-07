import {
  irCallKnownFunction,
  irLoadField,
  irNewObject,
  irStoreField,
  isUndefinedConstant,
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
  readonly outerSlot: number;
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
      const stored = node.inputs[0] ?? null;
      if (stored === null || isUndefinedConstant(stored)) continue;
      if (value !== null) return null;
      value = stored;
    }
  }
  return value;
}

function fieldLoad(frame: ClassShape, base: CFGInstruction, name: string): CFGInstruction {
  const field = frame.fields.get(name)!;
  const read = irLoadField(base, field.offset);
  read.props.propName = name;
  read.props[FIELD_TYPE_PROP] = field.declaredType;
  read.props[FIELD_SCALAR_PROP] = field.scalar;
  return read;
}

function fieldStore(
  frame: ClassShape,
  base: CFGInstruction,
  name: string,
  value: CFGInstruction,
): CFGInstruction {
  const field = frame.fields.get(name)!;
  const store = irStoreField(base, field.offset, value, name);
  store.props[FIELD_TYPE_PROP] = field.declaredType;
  store.props[FIELD_SCALAR_PROP] = field.scalar;
  return store;
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
    held.push({ slot, outerSlot: upvalue.outerSlot, value, declaredType });
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
  const touched = new Set<number>();
  let mutates = false;
  for (const node of contextSlots(unit.graph, UPVALUE_CAPTURE)) {
    if (node.type === IR_STORE_CONTEXT_SLOT) mutates = true;
    touched.add(Number(node.props.slot));
  }
  const held = heldValuesOf(unit, creator, classes);
  if (held === null) return null;
  for (const slot of touched) {
    if (!held.some((one) => one.slot === slot)) return null;
  }
  if (!mutates && held.length === SINGLE_CAPTURE) {
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
  const captured = buildFrame(creator.graph, frame);
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

function buildFrame(graph: CFGFunction, frame: ClassShape): CFGInstruction | null {
  const entry = graph.blocks[0]?.nodes[0] ?? null;
  if (entry === null) return null;
  const editor = new GraphEditor(graph);
  const allocation = nodeIdStamper(graph)(irNewObject());
  allocation.props[CLASS_ID_PROP] = frame.id;
  allocation.props[INSTANCE_SIZE_PROP] = frame.size;
  allocation.props[VALUE_CLASS_PROP] = frame.id;
  editor.insertBefore(entry, allocation);
  graph.rebuildUses();
  return allocation;
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
    if (frame === null) {
      editor.replaceAllUses(node, parameter);
      editor.remove(node);
      continue;
    }
    const name = capturedFieldName(Number(node.props.slot));
    rewriteAgainstFrame(editor, stamp, frame, parameter, node, name);
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

function rewriteAgainstFrame(
  editor: GraphEditor,
  stamp: (node: CFGInstruction) => CFGInstruction,
  frame: ClassShape,
  base: CFGInstruction,
  node: CFGInstruction,
  name: string,
): void {
  const stored = node.type === IR_STORE_CONTEXT_SLOT ? node.inputs[0]! : null;
  if (stored !== null && isUndefinedConstant(stored)) {
    editor.replaceAllUses(node, stored);
    editor.remove(node);
    return;
  }
  const replacement = stamp(
    stored === null ? fieldLoad(frame, base, name) : fieldStore(frame, base, name, stored),
  );
  replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, stored ?? replacement);
  editor.remove(node);
}

function retireCreator(closure: Closure): void {
  const graph = closure.creator.graph;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  const made = makesClosure(graph, closure.unit.compiledFunction!);
  if (made !== null) {
    editor.replaceAllUses(made, closure.captured);
    editor.remove(made);
  }
  const byOuterSlot = new Map(closure.held.map((one) => [one.outerSlot, one] as const));
  const { frame } = closure;
  for (const node of contextSlots(graph, LOCAL_CAPTURE)) {
    const one = byOuterSlot.get(Number(node.props.slot));
    if (one === undefined) continue;
    if (frame === null) {
      editor.replaceAllUses(node, one.value);
      editor.remove(node);
      continue;
    }
    rewriteAgainstFrame(editor, stamp, frame, closure.captured, node, capturedFieldName(one.slot));
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
