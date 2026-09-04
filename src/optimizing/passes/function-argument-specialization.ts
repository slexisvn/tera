import {
  irCallKnownFunction,
  CFGFunction,
  CFGInstruction,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  calleeNameOf,
} from "../ir/index.js";
import { cloneGraph } from "../ir/clone.js";
import { ModuleFunctions } from "../metadata/module-functions.js";
import { detachNode, replaceValueUses } from "../ir/graph-edit.js";

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

export function adoptWrittenTypes(target: CFGFunction, written: DeclaredSignature): boolean {
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

export function replaceCall(
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

export function unitOf(graph: CFGFunction): CompilationUnit {
  return { name: graph.name, graph, frameStates: [], compiledFunction: null, osrOffset: null };
}

class Specializer {
  private readonly added: CompilationUnit[] = [];
  private readonly retired = new Set<string>();
  private readonly functions: ModuleFunctions;

  constructor(private readonly module: ModuleIR) {
    this.functions = new ModuleFunctions(module);
  }

  run(): Specialization {
    for (const unit of this.module.units) this.specialize(unit.graph);
    return { added: this.added, retired: this.retired };
  }

  private handoffAt(site: CallSite, index: number): Handoff | null {
    const target = this.functions.referenced(site.node.inputs[site.firstArgument + index]);
    return target === null ? null : { index, name: target.name, target };
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

    const handoffsByIndex = handoffs.map(
      (chosen) => new Map(chosen.map((entry) => [entry.index, entry] as const)),
    );
    for (const index of indices) {
      const written = functionSignatureOf(graph.declaredSignature?.params[index]);
      if (written === null) continue;
      for (const chosen of handoffsByIndex) {
        const handoff = chosen.get(index)!;
        if (!adoptWrittenTypes(handoff.target, written)) return;
        this.functions.unitOf(handoff.target)?.analyses?.invalidate(typeInferenceAnalysisId);
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

export function specializeFunctionArguments(module: ModuleIR): Specialization {
  return new Specializer(module).run();
}
