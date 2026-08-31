import {
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_INDEX,
  IR_LOAD_GLOBAL,
  IR_STORE_GLOBAL,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { detachUsesOfAll, retainNodes } from "../ir/graph-edit.js";
import { AnalysisManager } from "../infra/analysis-manager.js";
import { createAnalysisRegistry } from "../analyses/index.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import { globalNameOf, promoteAssignedGlobals } from "../passes/global-promotion.js";
import { declaredTypeOf, type ClassTable } from "./class-table.js";
import { arrayElementNameOf } from "../passes/array-shapes.js";
import { arrayOfType } from "../../frontend/checker/type-system.js";
import { constructedShapeOf } from "../passes/class-member-lowering.js";
import { TypeKind } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";

function mentionedGlobals(module: ModuleIR): Map<string, Set<string>> {
  const mentions = new Map<string, Set<string>>();
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        const name = globalNameOf(node);
        if (name === null) continue;
        let graphs = mentions.get(name);
        if (graphs === undefined) {
          graphs = new Set<string>();
          mentions.set(name, graphs);
        }
        graphs.add(unit.graph.name);
      }
    }
  }
  return mentions;
}

function functionValuedGlobals(module: ModuleIR): ReadonlySet<string> {
  const names = new Set<string>();
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_STORE_GLOBAL) continue;
        const name = globalNameOf(node);
        if (name !== null && namesFunction(node.inputs[0])) names.add(name);
      }
    }
  }
  return names;
}

export function promoteRunOnceGlobals(
  module: ModuleIR,
  runOnce: ReadonlySet<string>,
): number {
  const functions = functionValuedGlobals(module);
  const promotable = new Set<string>();
  for (const [name, graphs] of mentionedGlobals(module)) {
    if (graphs.size === 1 || functions.has(name)) promotable.add(name);
  }
  if (promotable.size === 0) return 0;

  let promoted = 0;
  for (const unit of module.units) {
    if (!runOnce.has(unit.graph.name)) continue;
    const changed = promoteAssignedGlobals(unit.graph, promotable);
    if (changed > 0) unit.analyses?.invalidateAll();
    promoted += changed;
  }
  return promoted;
}

function storedTypeName(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  const type = types.typeOf(value);
  if (type.kind !== TypeKind.Array) {
    return declaredTypeOf(type, classes) ?? constructedShapeOf(value, classes)?.name ?? null;
  }
  const element = arrayElementNameOf(value, graph, classes, types);
  return element === null ? null : arrayOfType(element);
}

function namesFunction(value: CFGInstruction | undefined): boolean {
  return value !== undefined && compiledFunctionConstant(value.props.value) !== null;
}

export function dropFunctionBindings(module: ModuleIR): number {
  let dropped = 0;
  for (const unit of module.units) {
    const graph = unit.graph;
    const bindings = new Set<CFGInstruction>();
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (node.type === IR_STORE_GLOBAL && namesFunction(node.inputs[0])) bindings.add(node);
      }
    }
    if (bindings.size === 0) continue;
    detachUsesOfAll(bindings);
    for (const block of graph.blocks) retainNodes(block, bindings);
    graph.rebuildUses();
    dropped += bindings.size;
  }
  return dropped;
}

function analysesOf(unit: CompilationUnit): AnalysisManager<CFGFunction> {
  return unit.analyses ?? new AnalysisManager<CFGFunction>(unit.graph, createAnalysisRegistry());
}

const PUSH_MEMBER = "push";

function pushedInto(use: CFGInstruction, load: CFGInstruction): CFGInstruction | null {
  if (use.type !== IR_GENERIC_CALL || use.props.isMethod !== true) return null;
  const callee = use.inputs[0];
  if (callee?.type !== IR_GENERIC_GET_PROP || String(callee.props.propName) !== PUSH_MEMBER) {
    return null;
  }
  return use.inputs[1] === load ? use.inputs[2] ?? null : null;
}

function storedIntoElement(use: CFGInstruction, load: CFGInstruction): CFGInstruction | null {
  if (use.type !== IR_GENERIC_SET_INDEX || use.inputs[0] !== load) return null;
  return use.inputs[2] ?? null;
}

function typesByUnit(module: ModuleIR): Map<CompilationUnit, TypeInference> {
  const inferred = new Map<CompilationUnit, TypeInference>();
  for (const unit of module.units) {
    inferred.set(unit, analysesOf(unit).get(typeInferenceAnalysisId));
  }
  return inferred;
}

function demandedElements(
  module: ModuleIR,
  classes: ClassTable,
  inferred: ReadonlyMap<CompilationUnit, TypeInference>,
): Map<string, string | null> {
  const demanded = new Map<string, string | null>();
  for (const unit of module.units) {
    const types = inferred.get(unit)!;
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_LOAD_GLOBAL) continue;
        const name = globalNameOf(node);
        if (name === null) continue;
        for (const use of node.uses) {
          const held = pushedInto(use, node) ?? storedIntoElement(use, node);
          if (held === null) continue;
          const named = declaredTypeOf(types.typeOf(held), classes);
          const carried = demanded.get(name);
          demanded.set(name, carried === undefined || carried === named ? named : null);
        }
      }
    }
  }
  return demanded;
}

export function declareGlobalVariables(module: ModuleIR, classes: ClassTable): number {
  const stored = new Map<string, Set<string>>();
  const rejected = new Set<string>();
  const inferred = typesByUnit(module);
  const demandedByName = demandedElements(module, classes, inferred);
  for (const unit of module.units) {
    const types = inferred.get(unit)!;
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_STORE_GLOBAL) continue;
        const name = globalNameOf(node);
        if (name === null) continue;
        const value = node.inputs[0];
        if (value === undefined || namesFunction(value)) {
          rejected.add(name);
          continue;
        }
        const held = storedTypeName(value, unit.graph, classes, types);
        const demanded =
          held !== null && types.typeOf(value).kind === TypeKind.Array
            ? demandedByName.get(name) ?? null
            : null;
        const declared = demanded === null ? held : arrayOfType(demanded);
        if (declared === null) continue;
        let observed = stored.get(name);
        if (observed === undefined) {
          observed = new Set<string>();
          stored.set(name, observed);
        }
        observed.add(declared);
      }
    }
  }

  let declared = 0;
  for (const [name, candidates] of stored) {
    if (rejected.has(name) || candidates.size !== 1) continue;
    if (classes.declareGlobal(name, [...candidates][0]!) !== null) declared += 1;
  }
  return declared;
}
