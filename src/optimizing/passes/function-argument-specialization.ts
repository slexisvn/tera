import {
  irCallKnownFunction,
  CFGFunction,
  CFGInstruction,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_LOAD_GLOBAL,
  IR_STORE_GLOBAL,
} from "../ir/index.js";
import { cloneGraph } from "../ir/clone.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import { detachNode, replaceValueUses } from "../ir/graph-edit.js";
import { calleeSymbolName } from "../analyses/aot-legality.js";
import { genericCalleeName } from "../metadata/call-signatures.js";
import type { DeclaredSignature } from "../types/signature.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";
import { functionSignatureOf, isUnwritten } from "../types/signature.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";

export interface Specialization {
  readonly added: readonly CompilationUnit[];
  readonly retired: ReadonlySet<string>;
}

interface CallSite {
  readonly caller: CFGFunction;
  readonly node: CFGInstruction;
  readonly firstArgument: number;
}

interface Handoff {
  readonly index: number;
  readonly name: string;
  readonly target: CFGFunction;
}

function calleeNameOf(node: CFGInstruction): string | null {
  if (node.type === IR_GENERIC_CALL) return genericCalleeName(node);
  if (node.type !== IR_CALL_KNOWN_FUNCTION) return null;
  return calleeSymbolName(node);
}

/** Parameter positions whose every use is "call me". */
function calledParametersOf(graph: CFGFunction): readonly number[] {
  const called: number[] = [];
  graph.parameters.forEach((parameter, index) => {
    if (parameter.uses.length === 0) return;
    const alwaysTheTarget = parameter.uses.every(
      (use) => use.type === IR_GENERIC_CALL && use.inputs[0] === parameter,
    );
    if (alwaysTheTarget) called.push(index);
  });
  return called;
}

/**
 * A callback written without types still has to agree with the parameter it is handed
 * to, so the written function type fills in whatever the callback left unsaid. It is
 * only ever filled in, never overruled, so a callback used at two types is refused.
 */
function adoptWrittenTypes(target: CFGFunction, written: DeclaredSignature): boolean {
  const declared = target.declaredSignature;
  const params = target.parameters.map((parameter, index) => {
    const own = declared?.params[index] ?? null;
    const wanted = written.params[index] ?? null;
    if (isUnwritten(own)) return wanted;
    return wanted === null || isUnwritten(wanted) || own === wanted ? own : undefined;
  });
  if (params.some((param) => param === undefined)) return false;
  const returns = isUnwritten(declared?.returns) ? written.returns : declared!.returns;
  if (!isUnwritten(written.returns) && !isUnwritten(declared?.returns)) {
    if (declared!.returns !== written.returns) return false;
  }
  const adopted = {
    ...(declared ?? {}),
    params: params as readonly (string | null)[],
    returns,
  };
  target.declaredSignature = adopted;
  return true;
}

function nameFor(owner: string, handoffs: readonly Handoff[]): string {
  return `${owner}$${handoffs.map((handoff) => handoff.name).join("$")}`;
}

function replaceCall(
  owner: CFGFunction,
  node: CFGInstruction,
  target: CFGFunction,
  args: readonly CFGInstruction[],
): void {
  const call = irCallKnownFunction(target as never, [...args]);
  const block = node.block!;
  block.nodes.splice(block.nodes.indexOf(node), 0, call);
  call.block = block;
  replaceValueUses(owner, node, call);
  block.nodes.splice(block.nodes.indexOf(node), 1);
  detachNode(node);
  node.block = null;
}

/**
 * Anonymous functions all share one name, so the call has to name the graph it
 * reaches rather than leaving the callee to be looked up by what it calls itself.
 */
function bindCallees(graph: CFGFunction, handoffs: readonly Handoff[]): void {
  for (const handoff of handoffs) {
    const parameter = graph.parameters[handoff.index]!;
    for (const use of [...parameter.uses]) {
      if (use.block === null) continue;
      replaceCall(graph, use, handoff.target, use.inputs.slice(1));
    }
  }
}

function withoutParameters(graph: CFGFunction, dropped: ReadonlySet<number>): void {
  graph.parameters = graph.parameters.filter((_, index) => !dropped.has(index));
  graph.parameterCount = graph.parameters.length;
  graph.parameters.forEach((parameter, index) => {
    parameter.props.index = index;
  });
  const declared = graph.declaredSignature;
  if (declared === null) return;
  const keep = <T,>(values: readonly T[]): T[] => values.filter((_, at) => !dropped.has(at));
  graph.declaredSignature = {
    ...declared,
    params: keep(declared.params),
    ...(declared.names === undefined ? {} : { names: keep(declared.names) }),
    ...(declared.defaults === undefined ? {} : { defaults: keep(declared.defaults) }),
  };
}

function redirect(site: CallSite, target: CFGFunction, dropped: ReadonlySet<number>): void {
  const args = site.node.inputs
    .slice(site.firstArgument)
    .filter((_, index) => !dropped.has(index));
  replaceCall(site.caller, site.node, target, args);
}

function unitOf(graph: CFGFunction): CompilationUnit {
  return { name: graph.name, graph, frameStates: [], compiledFunction: null, osrOffset: null };
}

class Specializer {
  private readonly added: CompilationUnit[] = [];
  private readonly retired = new Set<string>();
  private readonly unitsByTarget = new Map<RegisterCompiledFunction, CFGFunction>();
  private readonly unitOfGraph = new Map<CFGFunction, CompilationUnit>();
  private readonly byName = new Map<string, CFGFunction>();
  private readonly reassigned = new Set<string>();

  constructor(private readonly module: ModuleIR) {
    for (const unit of module.units) {
      this.unitOfGraph.set(unit.graph, unit);
      this.byName.set(unit.graph.name, unit.graph);
      if (unit.compiledFunction !== null) {
        this.unitsByTarget.set(unit.compiledFunction, unit.graph);
      }
    }
    for (const unit of module.units) {
      for (const block of unit.graph.blocks) {
        for (const node of block.nodes) {
          if (node.type !== IR_STORE_GLOBAL) continue;
          const name = node.props.name;
          if (typeof name === "string") this.reassigned.add(name);
        }
      }
    }
  }

  run(): Specialization {
    for (const unit of this.module.units) this.specialize(unit.graph);
    return { added: this.added, retired: this.retired };
  }

  /**
   * Anonymous functions all answer to the same name, so a handed-over function is
   * identified by the compiled function the constant holds, not by what it is called.
   */
  private handoffAt(site: CallSite, index: number): Handoff | null {
    const argument = site.node.inputs[site.firstArgument + index];
    if (argument === undefined) return null;
    const target = this.targetOf(argument);
    return target === null ? null : { index, name: target.name, target };
  }

  /**
   * A function reaches an argument either spelled out on the spot or read from the
   * global it was declared into. A global only names one function for good if the
   * program never assigns to it again.
   */
  private targetOf(argument: CFGInstruction): CFGFunction | null {
    if (argument.type === IR_CONSTANT) {
      const compiled = compiledFunctionConstant(argument.props.value);
      return compiled === null ? null : this.unitsByTarget.get(compiled) ?? null;
    }
    if (argument.type !== IR_LOAD_GLOBAL) return null;
    const name = argument.props.name;
    if (typeof name !== "string" || this.reassigned.has(name)) return null;
    return this.byName.get(name) ?? null;
  }

  private callSitesOf(name: string): readonly CallSite[] {
    const sites: CallSite[] = [];
    for (const unit of [...this.module.units, ...this.added]) {
      for (const block of unit.graph.blocks) {
        for (const node of block.nodes) {
          if (calleeNameOf(node) !== name) continue;
          sites.push({
            caller: unit.graph,
            node,
            firstArgument: node.type === IR_GENERIC_CALL ? 1 : 0,
          });
        }
      }
    }
    return sites;
  }

  private specialize(graph: CFGFunction): void {
    const indices = calledParametersOf(graph);
    if (indices.length === 0) return;

    const sites = this.callSitesOf(graph.name);
    if (sites.length === 0) return;

    const handoffs: Handoff[][] = [];
    for (const site of sites) {
      const chosen: Handoff[] = [];
      for (const index of indices) {
        const handoff = this.handoffAt(site, index);
        if (handoff === null) return;
        chosen.push(handoff);
      }
      handoffs.push(chosen);
    }

    for (const index of indices) {
      const written = functionSignatureOf(graph.declaredSignature?.params[index]);
      if (written === null) continue;
      for (const chosen of handoffs) {
        const handoff = chosen.find((entry) => entry.index === index)!;
        if (!adoptWrittenTypes(handoff.target, written)) return;
        this.unitOfGraph.get(handoff.target)?.analyses?.invalidate(typeInferenceAnalysisId);
      }
    }

    const dropped = new Set(indices);
    const clones = new Map<string, CFGFunction>();
    sites.forEach((site, at) => {
      const chosen = handoffs[at]!;
      const name = nameFor(graph.name, chosen);
      let clone = clones.get(name);
      if (clone === undefined) {
        clone = cloneGraph(graph, name).graph;
        bindCallees(clone, chosen);
        withoutParameters(clone, dropped);
        clones.set(name, clone);
        this.added.push(unitOf(clone));
      }
      redirect(site, clone, dropped);
    });
    this.retired.add(graph.name);
  }
}

/**
 * Turns `apply(f, x)` — where `f` is only ever called — into one copy of `apply` per
 * function handed to it, so the call through the parameter becomes a direct call.
 * Nothing changes unless every call site hands over a function the module defines,
 * so a genuinely dynamic callee still declines the way it did before.
 */
export function specializeFunctionArguments(module: ModuleIR): Specialization {
  return new Specializer(module).run();
}
