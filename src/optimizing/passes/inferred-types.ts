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
import {
  adoptWrittenTypes,
  replaceCall,
  unitOf,
  type Specialization,
} from "./function-argument-specialization.js";
import { cloneGraph } from "../ir/clone.js";
import { arrayElementNameOf } from "./array-shapes.js";
import { literalReturnShapeOf, shapeObjectLiterals } from "./object-literal-shapes.js";
import { shapeModuleCollections } from "./collection-surface.js";
import { calleeDeclaredSignature } from "../metadata/call-signatures.js";
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

const NOTHING_SPECIALIZED: Specialization = { added: [], retired: new Set<string>() };

interface DisagreeingSite {
  readonly caller: CFGFunction;
  readonly node: CFGInstruction;
  readonly through: CFGInstruction | null;
  readonly args: readonly CFGInstruction[];
  readonly types: TypeInference;
}

function specializedName(owner: string, named: readonly string[]): string {
  return `${owner}$${named.map((name) => name.replace(/[^A-Za-z0-9]+/g, "_")).join("$")}`;
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

  run(): Specialization {
    this.shapeCollections();
    for (const unit of this.module.units) this.shapeLiterals(unit);
    this.settle();
    return this.specializeDisagreements();
  }

  private settle(): void {
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

  private escapesItsCalls(
    callee: CFGFunction,
    sites: readonly DisagreeingSite[],
  ): boolean {
    const consumed = new Set(sites.map((site) => site.through));
    for (const unit of this.module.units) {
      for (const block of unit.graph.blocks) {
        for (const node of block.nodes) {
          for (const value of [node, ...node.inputs]) {
            if (this.functions.referenced(value) !== callee) continue;
            if (!consumed.has(value)) return true;
          }
        }
      }
    }
    return false;
  }

  private sitesCalling(callee: CFGFunction): readonly DisagreeingSite[] {
    const sites: DisagreeingSite[] = [];
    for (const unit of this.module.units) {
      for (const block of unit.graph.blocks) {
        for (const node of block.nodes) {
          const site = callSiteOf(node, this.functions);
          if (site === null || site.callee !== callee) continue;
          sites.push({
            caller: unit.graph,
            node,
            through: node.type === IR_GENERIC_CALL ? node.inputs[0]! : null,
            args: site.args,
            types: this.types(unit),
          });
        }
      }
    }
    return sites;
  }

  private wantedAt(callee: CFGFunction, site: DisagreeingSite): readonly string[] | null {
    if (site.args.length !== callee.parameters.length) return null;
    const declared = callee.declaredSignature?.params ?? [];
    const wanted: string[] = [];
    for (let at = 0; at < site.args.length; at++) {
      const own = declared[at] ?? null;
      const named = isUnwritten(own)
        ? declaredTypeOf(site.types.typeOf(site.args[at]!), this.classes)
        : own;
      if (named === null) return null;
      wanted.push(named);
    }
    return wanted;
  }

  private splittable(callee: CFGFunction): boolean {
    if (!(callee.declaredSignature?.params ?? []).some(isUnwritten)) return false;
    if (callee.isAsync || callee.isGenerator || callee.resumable) return false;
    if (callee.gatheredArguments !== null || callee.classOwner !== null) return false;
    return callee.blocks.length > 0;
  }

  private specializeDisagreements(): Specialization {
    const added: CompilationUnit[] = [];
    const retired = new Set<string>();
    for (const unit of this.module.units) {
      const callee = unit.graph;
      if (!this.splittable(callee)) continue;
      const sites = this.sitesCalling(callee);
      if (sites.length < 2 || this.escapesItsCalls(callee, sites)) continue;
      if (sites.some((site) => site.caller === callee)) continue;
      const wanted = sites.map((site) => this.wantedAt(callee, site));
      if (wanted.some((named) => named === null)) continue;
      const shapes = new Map<string, readonly string[]>();
      for (const named of wanted) shapes.set(named!.join(","), named!);
      if (shapes.size < 2) continue;

      const clones = new Map<string, CFGFunction>();
      for (const [key, named] of shapes) {
        const clone = cloneGraph(callee, specializedName(callee.name, named)).graph;
        clone.declaredSignature = { ...callee.declaredSignature!, params: [...named] };
        added.push(unitOf(clone));
        clones.set(key, clone);
      }
      sites.forEach((site, at) => {
        replaceCall(site.caller, site.node, clones.get(wanted[at]!.join(","))!, site.args);
      });
      retired.add(callee.name);
    }
    return { added, retired };
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

export function adoptInferredTypes(
  module: ModuleIR,
  classes: ClassTable | null,
): Specialization {
  if (classes === null) return NOTHING_SPECIALIZED;
  return new TypeAdoption(module, classes).run();
}
