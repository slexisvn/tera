import {
  IR_GENERIC_CALL,
  memberCalled,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { AnalysisManager } from "../infra/analysis-manager.js";
import { createAnalysisRegistry } from "../analyses/index.js";
import { inferredReturnName } from "../analyses/returned-type.js";
import { typeInferenceAnalysisId, type TypeInference } from "../analyses/type-inference.js";
import { declaredTypeOf, type ClassTable } from "../metadata/class-table.js";
import { FUNCTION_TARGET_PROP, ModuleFunctions } from "../metadata/module-functions.js";
import { isUnwritten, type DeclaredSignature } from "../types/signature.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";
import { adoptWrittenTypes } from "./function-argument-specialization.js";
import { arrayElementNameOf } from "./array-shapes.js";
import { literalReturnShapeOf, shapeObjectLiterals } from "./object-literal-shapes.js";
import { shapeModuleCollections } from "./collection-surface.js";
import { calleeDeclaredSignature } from "../analyses/aot-legality.js";
import { callSiteOf } from "./inlining.js";
import { joinTypes, type LatticeType } from "../types/lattice.js";

const INDEX_TYPE = "int";
const CALLBACK_INDEX = 0;
const SEED_INDEX = 1;
const CALLEE_AND_RECEIVER = 2;

type CallbackParameters = (element: string, seed: string | null) => readonly (string | null)[];

const OVER_ELEMENTS: CallbackParameters = (element) => [element, INDEX_TYPE];

const CALLBACK_PARAMETERS: ReadonlyMap<string, CallbackParameters> = new Map<
  string,
  CallbackParameters
>([
  ["map", OVER_ELEMENTS],
  ["filter", OVER_ELEMENTS],
  ["some", OVER_ELEMENTS],
  ["every", OVER_ELEMENTS],
  ["find", OVER_ELEMENTS],
  ["find_index", OVER_ELEMENTS],
  ["for_each", OVER_ELEMENTS],
  ["reduce", (element, seed) => [seed, element, INDEX_TYPE]],
  ["sort", (element) => [element, element]],
]);

const MAPS_ELEMENTS = "map";
const KEEPS_ELEMENTS: ReadonlySet<string> = new Set<string>(["filter", "sort", "reverse"]);

const PRODUCES_ARRAY: readonly string[] = [MAPS_ELEMENTS, ...KEEPS_ELEMENTS];

function memberIn(node: CFGInstruction, members: Iterable<string>): string | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod !== true) return null;
  for (const member of members) {
    if (memberCalled(node, member) !== null) return member;
  }
  return null;
}

function signatureOf(graph: CFGFunction): string {
  return JSON.stringify(graph.declaredSignature ?? null);
}

class TypeAdoption {
  private readonly functions: ModuleFunctions;
  private readonly managers = new Map<CompilationUnit, AnalysisManager<CFGFunction>>();

  constructor(
    private readonly module: ModuleIR,
    private readonly classes: ClassTable,
  ) {
    this.functions = new ModuleFunctions(module);
  }

  run(): void {
    this.shapeCollections();
    for (const unit of this.module.units) this.shapeLiterals(unit);
    while (
      this.adoptCallbackParameters() + this.adoptCallSiteParameters() + this.adoptReturns() >
      0
    );
  }

  private shapeCollections(): void {
    const shaped = shapeModuleCollections(
      this.module.units.map((unit) => ({ graph: unit.graph, types: this.types(unit) })),
    );
    for (const graph of shaped) this.retype(graph);
  }

  private analyses(unit: CompilationUnit): AnalysisManager<CFGFunction> {
    let manager = unit.analyses ?? this.managers.get(unit);
    if (manager === undefined) {
      manager = new AnalysisManager<CFGFunction>(unit.graph, createAnalysisRegistry());
      this.managers.set(unit, manager);
    }
    return manager;
  }

  private types(unit: CompilationUnit): TypeInference {
    return this.analyses(unit).get(typeInferenceAnalysisId);
  }

  private retype(graph: CFGFunction): void {
    const unit = this.functions.unitOf(graph);
    if (unit !== undefined) this.analyses(unit).invalidate(typeInferenceAnalysisId);
  }

  private shapeLiterals(unit: CompilationUnit): void {
    if (unit.graph.classes === null) return;
    const signatureOf = (call: CFGInstruction): DeclaredSignature | null =>
      calleeDeclaredSignature(call) ??
      this.functions.referenced(call.inputs[0])?.declaredSignature ??
      null;
    if (shapeObjectLiterals(unit.graph, this.types(unit), signatureOf) > 0) {
      this.retype(unit.graph);
    }
  }

  private elementNameOf(
    value: CFGInstruction | undefined,
    unit: CompilationUnit,
  ): string | null {
    if (value === undefined) return null;
    const member = memberIn(value, PRODUCES_ARRAY);
    if (member === MAPS_ELEMENTS) {
      const callback = this.functions.referenced(value.inputs[CALLEE_AND_RECEIVER]);
      const returns = callback?.declaredSignature?.returns;
      return isUnwritten(returns) ? null : returns!;
    }
    if (member !== null) return this.elementNameOf(value.inputs[1], unit);
    return arrayElementNameOf(value, unit.graph, this.classes, this.types(unit));
  }

  private writtenFor(
    node: CFGInstruction,
    member: string,
    unit: CompilationUnit,
  ): readonly (string | null)[] | null {
    const element = this.elementNameOf(node.inputs[1], unit);
    if (element === null) return null;
    const seed = node.inputs[CALLEE_AND_RECEIVER + SEED_INDEX];
    return CALLBACK_PARAMETERS.get(member)!(
      element,
      seed === undefined ? null : declaredTypeOf(this.types(unit).typeOf(seed), this.classes),
    );
  }

  private adoptCallbackParameters(): number {
    let adopted = 0;
    for (const unit of this.module.units) {
      for (const block of unit.graph.blocks) {
        for (const node of block.nodes) {
          const member = memberIn(node, CALLBACK_PARAMETERS.keys());
          if (member === null) continue;
          const argument = node.inputs[CALLEE_AND_RECEIVER + CALLBACK_INDEX];
          const callback = this.functions.referenced(argument);
          if (callback === null) continue;
          argument!.props[FUNCTION_TARGET_PROP] = callback.name;
          const params = this.writtenFor(node, member, unit);
          if (params === null) continue;
          const before = signatureOf(callback);
          if (!adoptWrittenTypes(callback, { params, returns: null })) continue;
          if (signatureOf(callback) === before) continue;
          this.retype(callback);
          adopted++;
        }
      }
    }
    return adopted;
  }

  private observedArguments(): Map<CFGFunction, (LatticeType | null)[]> {
    const observed = new Map<CFGFunction, (LatticeType | null)[]>();
    for (const unit of this.module.units) {
      for (const block of unit.graph.blocks) {
        for (const node of block.nodes) {
          const site = callSiteOf(node, this.functions);
          if (site === null || site.callee === unit.graph) continue;
          if (site.args.length !== site.callee.parameters.length) continue;
          const slots =
            observed.get(site.callee) ??
            site.callee.parameters.map<LatticeType | null>(() => null);
          site.args.forEach((argument, at) => {
            const passed = this.types(unit).typeOf(argument);
            const carried = slots[at];
            slots[at] = carried === null ? passed : joinTypes(carried, passed);
          });
          observed.set(site.callee, slots);
        }
      }
    }
    return observed;
  }

  private adoptCallSiteParameters(): number {
    let adopted = 0;
    for (const [callee, slots] of this.observedArguments()) {
      const declared = callee.declaredSignature;
      if (declared === null || !declared.params.some(isUnwritten)) continue;
      const params = slots.map((passed, at) => {
        const own = declared.params[at] ?? null;
        if (!isUnwritten(own)) return own;
        return passed === null ? null : declaredTypeOf(passed, this.classes);
      });
      if (!params.some((named, at) => named !== null && isUnwritten(declared.params[at] ?? null))) {
        continue;
      }
      if (!adoptWrittenTypes(callee, { params, returns: null })) continue;
      this.retype(callee);
      adopted++;
    }
    return adopted;
  }

  private adoptReturns(): number {
    let adopted = 0;
    for (const unit of this.module.units) {
      const graph = unit.graph;
      if (graph.classes === null) continue;
      if (!isUnwritten(graph.declaredSignature?.returns)) continue;
      const returns =
        literalReturnShapeOf(graph) ?? inferredReturnName(graph, this.types(unit));
      if (returns === null) continue;
      graph.declaredSignature = {
        ...graph.declaredSignature,
        params: graph.declaredSignature?.params ?? [],
        returns,
      };
      this.retype(graph);
      adopted++;
    }
    return adopted;
  }
}

export function adoptInferredTypes(module: ModuleIR, classes: ClassTable | null): void {
  if (classes === null) return;
  new TypeAdoption(module, classes).run();
}
