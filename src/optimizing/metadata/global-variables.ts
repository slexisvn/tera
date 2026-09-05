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
import {
  declaredGlobalTypeOf,
  globalNameOf,
  promoteAssignedGlobals,
} from "../passes/global-promotion.js";
import {
  declaredTypeOf,
  holdsEveryTypeName,
  joinedTypeName,
  type ClassTable,
} from "./class-table.js";
import {
  arrayElementNamingOf,
  type ArrayElementNaming,
} from "../passes/array-shapes.js";
import {
  declaredSignaturesOf,
  declaredTypeAt,
  type CalleeSignatures,
} from "./call-signatures.js";
import { arrayElementType, arrayOfType } from "../../frontend/checker/type-system.js";
import { constructedShapeOf } from "../passes/class-member-lowering.js";
import { TypeKind, type ArrayType } from "../types/lattice.js";
import { latticeFromElementsKind } from "../types/elements.js";
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
  classes: ClassTable,
  types: TypeInference,
): string | null {
  const type = types.typeOf(value);
  return declaredTypeOf(type, classes) ?? constructedShapeOf(value, classes)?.name ?? null;
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

function elementDemandsOf(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  signatureOf: CalleeSignatures,
): readonly string[] {
  const demands: string[] = [];
  for (const use of node.uses) {
    const held = pushedInto(use, node) ?? storedIntoElement(use, node);
    const stored = held === null ? null : declaredTypeOf(types.typeOf(held), classes);
    if (stored !== null) demands.push(stored);
    for (const [at, input] of use.inputs.entries()) {
      if (input !== node) continue;
      const declared = declaredTypeAt(use, at, graph, classes, types, signatureOf);
      const element = declared === null ? null : arrayElementType(declared);
      if (element !== null) demands.push(element);
    }
  }
  return demands;
}

function demandedElements(
  module: ModuleIR,
  classes: ClassTable,
  inferred: ReadonlyMap<CompilationUnit, TypeInference>,
): Map<string, string[]> {
  const signatureOf = declaredSignaturesOf(module);
  const demanded = new Map<string, string[]>();
  for (const unit of module.units) {
    const types = inferred.get(unit)!;
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_LOAD_GLOBAL) continue;
        const name = globalNameOf(node);
        if (name === null) continue;
        const found = elementDemandsOf(node, unit.graph, classes, types, signatureOf);
        if (found.length === 0) continue;
        const carried = demanded.get(name);
        if (carried === undefined) demanded.set(name, [...found]);
        else carried.push(...found);
      }
    }
  }
  return demanded;
}

function arrayTypeOf(value: CFGInstruction, types: TypeInference): ArrayType | null {
  const type = types.typeOf(value);
  return type.kind === TypeKind.Array ? type : null;
}

function elementEvidenceOf(
  array: ArrayType | null,
  element: ArrayElementNaming | null,
  classes: ClassTable,
  demanded: readonly string[],
): readonly string[] {
  const carried =
    array === null
      ? null
      : declaredTypeOf(latticeFromElementsKind(array.elementsKind), classes);
  const named = element === null || element.guessed ? null : element.held;
  const found = carried === null ? [] : [carried];
  if (named !== null && named !== carried) found.push(named);
  if (found.length > 0 || demanded.length > 0) return [...found, ...demanded];
  return element === null ? [] : [element.held];
}

function annotatedGlobals(module: ModuleIR): ReadonlyMap<string, string | null> {
  const annotated = new Map<string, string | null>();
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        const name = globalNameOf(node);
        const declared = declaredGlobalTypeOf(node);
        if (name === null || declared === null) continue;
        const carried = annotated.get(name);
        annotated.set(name, carried === undefined || carried === declared ? declared : null);
      }
    }
  }
  return annotated;
}

function preferredTypeName(
  annotation: string | null,
  classes: ClassTable,
  evidence: readonly string[],
): string | null {
  if (annotation !== null && holdsEveryTypeName(classes, annotation, evidence)) return annotation;
  return joinedTypeName(classes, evidence);
}

function preferredElementName(
  annotation: string | null,
  classes: ClassTable,
  evidence: readonly string[],
): string | null {
  return preferredTypeName(
    annotation === null ? null : arrayElementType(annotation),
    classes,
    evidence,
  );
}

function observe(stored: Map<string, Set<string>>, name: string, declared: string): void {
  const observed = stored.get(name);
  if (observed === undefined) stored.set(name, new Set<string>([declared]));
  else observed.add(declared);
}

export function declareGlobalVariables(module: ModuleIR, classes: ClassTable): number {
  const stored = new Map<string, Set<string>>();
  const rejected = new Set<string>();
  const inferred = typesByUnit(module);
  const demandedByName = demandedElements(module, classes, inferred);
  const annotatedByName = annotatedGlobals(module);
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
        const annotation = annotatedByName.get(name) ?? null;
        const array = arrayTypeOf(value, types);
        const naming = arrayElementNamingOf(value, unit.graph, classes, types);
        if (array === null && naming === null) {
          const held = storedTypeName(value, classes, types);
          if (held === null) continue;
          observe(stored, name, preferredTypeName(annotation, classes, [held]) ?? held);
          continue;
        }
        const evidence = elementEvidenceOf(
          array,
          naming,
          classes,
          demandedByName.get(name) ?? [],
        );
        if (evidence.length === 0 && annotation === null) continue;
        const element = preferredElementName(annotation, classes, evidence);
        if (element === null) {
          rejected.add(name);
          continue;
        }
        observe(stored, name, arrayOfType(element));
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
