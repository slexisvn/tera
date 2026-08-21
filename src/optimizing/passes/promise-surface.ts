import {
  irAwait,
  irCallKnownFunction,
  irNewArray,
  irReturn,
  CFGFunction,
  CFGInstruction,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_AWAIT,
  IR_GENERIC_CALL,
  IR_NEW_ARRAY,
  IR_RETURN,

  IR_LOAD_GLOBAL,
} from "../ir/index.js";
import { detachNode, replaceValueUses } from "../ir/graph-edit.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import { branchOnPendingThrow, takePendingThrow } from "../builder/throw-recovery.js";
import { calleeNameOf } from "../metadata/call-signatures.js";
import { isUnwritten, type DeclaredSignature } from "../types/signature.js";
import { inferTypes } from "../analyses/type-inference.js";
import { joinTypes, TypeKind, type LatticeType } from "../types/lattice.js";
import type { ClassTable } from "../metadata/class-table.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";

const PROMISE_GLOBAL = "Promise";
const RESOLVE = "resolve";
const THEN = "then";
const CATCH = "catch";
const ALL = "all";
const ANY_TYPE = "any";
const VOID_TYPE = "void";

interface MethodCall {
  readonly node: CFGInstruction;
  readonly receiver: CFGInstruction | null;
  readonly member: string;
  readonly args: readonly CFGInstruction[];
}

function methodCallOf(node: CFGInstruction): MethodCall | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod !== true) return null;
  const callee = node.inputs[0];
  if (callee === undefined) return null;
  const member = callee.props.propName;
  if (typeof member !== "string") return null;
  return { node, receiver: node.inputs[1] ?? null, member, args: node.inputs.slice(2) };
}

const WRITTEN_BY_JS_TYPE = new Map<string, string>([
  ["string", "string"],
  ["boolean", "bool"],
]);

function writtenTypeOfConstant(value: CFGInstruction | undefined): string {
  if (value === undefined || value.type !== IR_CONSTANT) return ANY_TYPE;
  const held = value.props.value;
  if (typeof held === "number") return Number.isInteger(held) ? "int" : "float";
  return WRITTEN_BY_JS_TYPE.get(typeof held) ?? ANY_TYPE;
}

const WRITTEN_BY_KIND = new Map<string, string>([
  [TypeKind.Smi, "int"],
  [TypeKind.Boolean, "bool"],
  [TypeKind.Double, "float"],
  [TypeKind.Number, "float"],
  [TypeKind.String, "string"],
]);

function writtenNameOf(type: LatticeType, classes: ClassTable | null): string {
  if (type.kind === TypeKind.Object && typeof type.map === "number") {
    return classes?.shapeById(type.map)?.name ?? ANY_TYPE;
  }
  return WRITTEN_BY_KIND.get(type.kind) ?? ANY_TYPE;
}

function writtenReturnOf(graph: CFGFunction): string {
  const declared = graph.declaredSignature?.returns;
  if (!isUnwritten(declared)) return declared!;
  const types = inferTypes(graph);
  let joined: LatticeType | null = null;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_RETURN) continue;
      const value = node.inputs[0];
      if (value === undefined) continue;
      if (value.type === IR_CONSTANT && value.props.value === undefined) continue;
      joined = joinTypes(joined, types.typeOf(value));
    }
  }
  return joined === null ? VOID_TYPE : writtenNameOf(joined, graph.classes);
}

function isPromiseGlobal(value: CFGInstruction | null): boolean {
  return value !== null && value.type === IR_LOAD_GLOBAL && value.props.name === PROMISE_GLOBAL;
}

function unitOf(graph: CFGFunction): CompilationUnit {
  return { name: graph.name, graph, frameStates: [], compiledFunction: null, osrOffset: null };
}

function removeNode(node: CFGInstruction): void {
  const block = node.block;
  if (block !== null) {
    const at = block.nodes.indexOf(node);
    if (at >= 0) block.nodes.splice(at, 1);
  }
  detachNode(node);
  node.block = null;
}

function removeChain(node: CFGInstruction): void {
  const inputs = [...node.inputs];
  removeNode(node);
  for (const input of inputs) {
    if (input.uses.length === 0 && input.block !== null) removeChain(input);
  }
}

class PromiseSurface {
  private readonly added: CompilationUnit[] = [];
  private readonly graphsByTarget = new Map<RegisterCompiledFunction, CFGFunction>();
  private readonly graphsByName = new Map<string, CFGFunction>();
  private minted = 0;

  constructor(private readonly module: ModuleIR) {
    for (const unit of module.units) {
      this.graphsByName.set(unit.graph.name, unit.graph);
      if (unit.compiledFunction === null) continue;
      this.graphsByTarget.set(unit.compiledFunction, unit.graph);
    }
  }

  run(): readonly CompilationUnit[] {
    for (const unit of this.module.units) {
      for (const block of [...unit.graph.blocks]) {
        for (const node of [...block.nodes]) {
          if (node.block !== block) continue;
          this.lower(unit.graph, node);
        }
      }
    }
    return this.added;
  }

  private mint(kind: string): CFGFunction {
    const graph = new CFGFunction(`tera_promise$${kind}$${this.minted++}`);
    graph.classes = this.module.units[0]?.graph.classes ?? null;
    graph.isAsync = true;
    graph.internal = true;
    this.added.push(unitOf(graph));
    this.graphsByName.set(graph.name, graph);
    return graph;
  }

  private functionAt(value: CFGInstruction | undefined): CFGFunction | null {
    if (value === undefined) return null;
    if (value.type === IR_CONSTANT) {
      const compiled = compiledFunctionConstant(value.props.value);
      return compiled === null ? null : this.graphsByTarget.get(compiled) ?? null;
    }
    if (value.type !== IR_LOAD_GLOBAL) return null;
    const name = value.props.name;
    return typeof name === "string" ? this.graphsByName.get(name) ?? null : null;
  }

  private settledTypeOf(call: CFGInstruction): string {
    const name = calleeNameOf(call);
    const callee = name === null ? null : this.graphsByName.get(name) ?? null;
    const returns = callee?.declaredSignature?.returns ?? null;
    return isUnwritten(returns) ? ANY_TYPE : returns!;
  }

  private teach(callback: CFGFunction, settled: string, index = 0): void {
    const declared = callback.declaredSignature;
    const params = callback.parameters.map((_, at) =>
      at === index && isUnwritten(declared?.params[at]) ? settled : declared?.params[at] ?? null,
    );
    callback.declaredSignature = {
      ...(declared ?? {}),
      params,
      returns: declared?.returns ?? null,
    } as DeclaredSignature;
  }

  private lower(owner: CFGFunction, node: CFGInstruction): void {
    const call = methodCallOf(node);
    if (call === null) return;
    if (isPromiseGlobal(call.receiver) && call.member === RESOLVE) {
      this.lowerResolve(owner, call);
      return;
    }
    if (isPromiseGlobal(call.receiver) && call.member === ALL) {
      this.lowerAll(owner, call);
      return;
    }
    if (call.member === THEN || call.member === CATCH) {
      this.lowerContinuation(owner, call);
    }
  }

  private lowerResolve(owner: CFGFunction, call: MethodCall): void {
    const value = call.args[0];
    if (value === undefined || call.args.length !== 1) return;
    const graph = this.mint(RESOLVE);
    const parameter = graph.addParameter(0);
    const entry = graph.addBlock();
    entry.addNode(irReturn(parameter));
    const written = writtenTypeOfConstant(value);
    graph.declaredSignature = { params: [written], returns: written };
    graph.rebuildUses();

    const replacement = irCallKnownFunction(graph as never, [value]);
    this.swap(owner, call.node, replacement);
  }

  private lowerAll(owner: CFGFunction, call: MethodCall): void {
    const list = call.args[0];
    if (list === undefined || call.args.length !== 1) return;
    if (list.type !== IR_NEW_ARRAY || list.inputs.length === 0) return;
    if (call.node.uses.length !== 1) return;
    const awaited = call.node.uses[0]!;
    if (awaited.type !== IR_AWAIT) return;
    const started = [...list.inputs];
    if (!started.every((element) => this.startsAPromise(element))) return;

    const block = awaited.block!;
    const settled = started.map((element) => {
      const wait = irAwait(element);
      wait.block = block;
      block.nodes.splice(block.nodes.indexOf(awaited), 0, wait);
      return wait;
    });
    const collected = irNewArray(settled);
    collected.block = block;
    block.nodes.splice(block.nodes.indexOf(awaited), 0, collected);

    replaceValueUses(owner, awaited, collected);
    removeNode(awaited);
    const load = call.node.inputs[0]!;
    removeNode(call.node);
    if (load.uses.length === 0) removeChain(load);
    if (list.uses.length === 0) removeNode(list);
    owner.rebuildUses();
  }

  private startsAPromise(element: CFGInstruction): boolean {
    if (element.type !== IR_CALL_KNOWN_FUNCTION && element.type !== IR_GENERIC_CALL) return false;
    const name = calleeNameOf(element);
    const callee = name === null ? null : this.graphsByName.get(name) ?? null;
    return callee !== null && callee.isAsync;
  }

  private lowerContinuation(owner: CFGFunction, call: MethodCall): void {
    const producer = call.receiver;
    if (producer === null || call.args.length !== 1) return;
    if (producer.type !== IR_CALL_KNOWN_FUNCTION && producer.type !== IR_GENERIC_CALL) return;
    const load = call.node.inputs[0]!;
    if (!producer.uses.every((use) => use === call.node || use === load)) return;
    const producerName = calleeNameOf(producer);
    const produced = producerName === null ? null : this.graphsByName.get(producerName) ?? null;
    if (produced === null || !produced.isAsync) return;
    const callback = this.functionAt(call.args[0]);
    if (callback === null) return;

    const settled = this.settledTypeOf(producer);
    const catches = call.member === CATCH;
    this.teach(callback, catches ? "string" : settled);

    const graph = this.mint(call.member);
    const forwarded = producer.type === IR_GENERIC_CALL ? producer.inputs.slice(1) : producer.inputs;
    const parameters = forwarded.map((_, index) => graph.addParameter(index));
    const entry = graph.addBlock();
    const started = irCallKnownFunction(produced as never, parameters);
    entry.addNode(started);
    const awaited = irAwait(started);
    entry.addNode(awaited);

    if (catches) {
      graph.recoversThrows = true;
      const { taken, resumed } = branchOnPendingThrow(graph, entry);
      const thrown = takePendingThrow(taken);
      const handled = irCallKnownFunction(callback as never, [thrown]);
      taken.addNode(handled);
      taken.addNode(irReturn(handled));
      resumed.addNode(irReturn(awaited));
    } else {
      const handed = irCallKnownFunction(callback as never, [awaited]);
      entry.addNode(handed);
      entry.addNode(irReturn(handed));
    }
    const written = produced.declaredSignature?.params ?? [];
    graph.declaredSignature = {
      params: forwarded.map((value, index) => written[index] ?? writtenTypeOfConstant(value)),
      returns: writtenReturnOf(callback),
    };
    graph.rebuildUses();

    const replacement = irCallKnownFunction(graph as never, forwarded);
    this.swap(owner, call.node, replacement);
    removeChain(producer);
  }

  private swap(owner: CFGFunction, node: CFGInstruction, replacement: CFGInstruction): void {
    const block = node.block!;
    block.nodes.splice(block.nodes.indexOf(node), 0, replacement);
    replacement.block = block;
    replaceValueUses(owner, node, replacement);
    const callee = node.inputs[0]!;
    removeNode(node);
    if (callee.uses.length === 0) removeChain(callee);
    owner.rebuildUses();
  }
}

export function lowerPromiseSurface(module: ModuleIR): readonly CompilationUnit[] {
  return new PromiseSurface(module).run();
}
