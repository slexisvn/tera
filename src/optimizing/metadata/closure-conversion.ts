import {
  irCallKnownFunction,
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
import { declaredTypeOf, type ClassTable } from "./class-table.js";
import { ModuleFunctions } from "./module-functions.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";

const LOCAL_CAPTURE = "local";
const UPVALUE_CAPTURE = "upvalue";
const CAPTURED_PARAMETER_NAME = "captured";
const SINGLE_CAPTURE = 1;
const CAPTURE_SLOT = 0;

interface Closure {
  readonly unit: CompilationUnit;
  readonly creator: CompilationUnit;
  readonly captured: CFGInstruction;
  readonly capturedType: string;
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

function capturedOf(
  unit: CompilationUnit,
  creator: CompilationUnit,
  classes: ClassTable,
): Closure | null {
  const compiled = unit.compiledFunction;
  if (compiled === null || compiled.upvalues.length !== SINGLE_CAPTURE) return null;
  const upvalue = compiled.upvalues[CAPTURE_SLOT];
  if (upvalue?.outerType !== LOCAL_CAPTURE || upvalue.outerSlot === undefined) return null;
  if (contextSlots(unit.graph, LOCAL_CAPTURE).length > 0) return null;
  for (const node of contextSlots(unit.graph, UPVALUE_CAPTURE)) {
    if (node.type === IR_STORE_CONTEXT_SLOT) return null;
    if (Number(node.props.slot) !== CAPTURE_SLOT) return null;
  }
  const captured = storedInSlot(creator.graph, upvalue.outerSlot);
  if (captured === null) return null;
  const types = analysesOf(creator).get(typeInferenceAnalysisId);
  const capturedType = declaredTypeOf(types.typeOf(captured), classes);
  return capturedType === null ? null : { unit, creator, captured, capturedType };
}

function liftBody(closure: Closure): void {
  const graph = closure.unit.graph;
  const parameter = graph.addParameter(graph.parameterCount);
  graph.parameterCount += 1;
  graph.parameters.pop();
  graph.parameters.unshift(parameter);
  graph.parameters.forEach((held, index) => {
    held.props.index = index;
  });
  const editor = new GraphEditor(graph);
  for (const node of contextSlots(graph, UPVALUE_CAPTURE)) {
    editor.replaceAllUses(node, parameter);
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

function retireCreator(closure: Closure): void {
  const graph = closure.creator.graph;
  const editor = new GraphEditor(graph);
  const made = makesClosure(graph, closure.unit.compiledFunction!);
  if (made !== null) {
    editor.replaceAllUses(made, closure.captured);
    editor.remove(made);
  }
  for (const node of contextSlots(graph, LOCAL_CAPTURE)) {
    if (node.type === IR_LOAD_CONTEXT_SLOT) editor.replaceAllUses(node, closure.captured);
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
      rewritten += this.rewriteCalls(unit, functions);
    }
    return rewritten;
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
