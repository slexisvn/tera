import {
  IR_CONSTANT,
  irCallKnownFunction,
  IR_AWAIT,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_LOAD_GLOBAL,
  IR_RETURN,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { isUnwritten, type DeclaredSignature } from "../types/signature.js";
import type { ClassShape, ClassTable } from "../metadata/class-table.js";
import {
  calleeNameOf,
  calleeSymbolName,
  CALLEE_SYMBOL_PROP,
  genericCalleeName,
  stampCalleeSignatures,
} from "../metadata/call-signatures.js";
import { THROW_BUILTIN } from "../metadata/builtin-methods.js";
import { ModuleFunctions } from "../metadata/module-functions.js";
import {
  aotLegalityAnalysisId,
  summarizeStringEscapes,
  undeclaredParameterOf,
  undeclaredParameterReason,
} from "../analyses/aot-legality.js";
import { AWAITED_CALL_PROP } from "../builder/ir-builder.js";
import { forwardsPendingThrow, isPendingThrowReturn } from "../builder/throw-recovery.js";
import {
  bottomUpCallOrder,
  callReachability,
  markReentrantFunctions,
} from "../metadata/call-graph.js";
import { inlineKnownCalls } from "../passes/inlining.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import { inferredReturnName } from "../analyses/returned-type.js";
import type { AotBackend, LinkableFunction } from "../target/backend.js";
import type {
  AotOutputFile,
  AotOutputFormat,
  AotSkippedFunction,
} from "../target/artifact.js";

export type { AotSkippedFunction };
import type { EntryDelivery } from "../target/entry.js";
import { BackendLoweringError, isBackendLoweringError } from "../target/errors.js";
import { CODE_TARGET_PROP } from "../analyses/aot-legality.js";
import { AnalysisManager } from "../infra/analysis-manager.js";
import { compilerOptions, type CompilerOptions } from "../options.js";
import { cfgPassManager, runMiddleEnd } from "../pipeline.js";
import { staticCompilerOptions } from "../optimizer.js";
import { createAnalysisRegistry } from "../analyses/index.js";
import { elideAwaits } from "../passes/await-elision.js";
import {
  specializeFunctionArguments,
  type Specialization,
} from "../passes/function-argument-specialization.js";
import { rewriteSelfTailCalls } from "../passes/tail-calls.js";
import { adoptInferredTypes } from "../passes/inferred-types.js";
import { boxEscapingStrings } from "../passes/string-boxing.js";
import { lowerPromiseSurface } from "../passes/promise-surface.js";
import {
  buildDrain,
  buildReportRejections,
  buildSleep,
  buildWake,
  CoroutineSplitError,
  lowerAwaitedPromises,
  drainBeforeExit,
  splitCoroutine,
  typeAwaitedResults,
  type PromiseOf,
} from "../passes/coroutines.js";
import { generatorYieldType, splitGenerator } from "../passes/generators.js";
import { lowerErrorSurface } from "../passes/error-surface.js";
import { lowerGeneratorIteration } from "../passes/generator-iteration.js";
import {
  CORO_SLEEP,
  coroutineBaseShapes,
  coroutinePromiseShape,
  coroutineTimerShape,
} from "../metadata/coroutines.js";
import {
  declareGlobalVariables,
  dropFunctionBindings,
  promoteRunOnceGlobals,
} from "../metadata/global-variables.js";
import { lowerModuleCaptures } from "../metadata/module-captures.js";
import { convertClosures } from "../metadata/closure-conversion.js";
import { PROGRAM_ENTRY_NAME } from "../target/program-entry.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";

export interface AotProgram {
  readonly files: readonly AotOutputFile[];
  readonly compiled: readonly LinkableFunction[];
  readonly skipped: readonly AotSkippedFunction[];
  readonly moduleInits?: readonly string[];
}

export class AotUndeclaredParameterError extends Error {
  readonly undeclared: readonly AotSkippedFunction[];
  constructor(undeclared: readonly AotSkippedFunction[]) {
    super(
      [
        "compiling ahead of time needs every parameter to have a declared type",
        ...undeclared.map((fn) => `  ${fn.name}: ${fn.reason}`),
      ].join("\n"),
    );
    this.name = "AotUndeclaredParameterError";
    this.undeclared = undeclared;
  }
}

export class AotLinkError extends BackendLoweringError {
  readonly skipped: readonly AotSkippedFunction[];
  constructor(message: string, skipped: readonly AotSkippedFunction[]) {
    super(message);
    this.name = "AotLinkError";
    this.skipped = skipped;
  }
}

export interface AotDriverOptions {
  readonly moduleName?: string;
  readonly compilerOptions?: CompilerOptions;
  readonly format?: AotOutputFormat;
  readonly entry?: string;
  readonly result?: EntryDelivery;
  readonly moduleInits?: readonly string[];
  readonly skipped?: readonly AotSkippedFunction[];
  readonly heapBytes?: number;
}

const DEFAULT_MODULE_NAME = "program";
const DEFAULT_RETURN = "int";

function dropUnresolvedCallers(
  compiled: readonly LinkableFunction[],
  skipped: AotSkippedFunction[],
  symbolOf: (name: string) => string,
): LinkableFunction[] {
  const defined = new Set(compiled.map((fn) => fn.emitted.symbol));
  const named = new Map<string, string>();
  for (const fn of skipped) named.set(symbolOf(fn.name), fn.name);
  for (const fn of compiled) named.set(fn.emitted.symbol, fn.name);
  const callers = new Map<string, LinkableFunction[]>();
  for (const fn of compiled) {
    for (const reference of fn.emitted.references) {
      let group = callers.get(reference);
      if (group === undefined) {
        group = [];
        callers.set(reference, group);
      }
      group.push(fn);
    }
  }

  const dropped = new Set<string>();
  const worklist: LinkableFunction[] = [];
  const drop = (fn: LinkableFunction, symbol: string): void => {
    if (dropped.has(fn.emitted.symbol)) return;
    dropped.add(fn.emitted.symbol);
    const missing = named.get(symbol);
    skipped.push({
      name: fn.name,
      reason: `calls unavailable function ${missing ?? symbol}`,
      ...(missing === undefined ? {} : { missing }),
    });
    worklist.push(fn);
  };

  for (const fn of compiled) {
    for (const reference of fn.emitted.references) {
      if (!defined.has(reference)) drop(fn, reference);
    }
  }
  while (worklist.length > 0) {
    const fn = worklist.pop()!;
    for (const caller of callers.get(fn.emitted.symbol) ?? []) drop(caller, fn.emitted.symbol);
  }

  return compiled.filter((fn) => !dropped.has(fn.emitted.symbol));
}

function moduleClasses(module: ModuleIR): ClassTable | null {
  for (const unit of module.units) {
    if (unit.graph.classes !== null) return unit.graph.classes;
  }
  return null;
}

function uniquifyGraphNames(module: ModuleIR): void {
  const taken = new Set<string>();
  for (let index = module.units.length - 1; index >= 0; index--) {
    const graph = module.units[index]!.graph;
    if (!taken.has(graph.name)) {
      taken.add(graph.name);
      continue;
    }
    let ordinal = 2;
    while (taken.has(`${graph.name}${ordinal}`)) ordinal++;
    graph.name = `${graph.name}${ordinal}`;
    taken.add(graph.name);
  }
}

function runOnceGraphs(
  module: ModuleIR,
  backend: AotBackend,
  options: AotDriverOptions,
): ReadonlySet<string> {
  const inits = new Set(options.moduleInits ?? []);
  const names = new Set<string>([PROGRAM_ENTRY_NAME]);
  for (const unit of module.units) {
    if (inits.has(backend.symbolOf(unit.graph.name))) names.add(unit.graph.name);
  }
  return names;
}

interface ModuleStart {
  readonly started: boolean;
  readonly refused: string | null;
}

function unitsByName(module: ModuleIR): ReadonlyMap<string, CompilationUnit> {
  const units = new Map<string, CompilationUnit>();
  for (const unit of module.units) units.set(unit.graph.name, unit);
  return units;
}

function startModules(module: ModuleIR, inits: readonly string[]): ModuleStart {
  const units = unitsByName(module);
  const entry = units.get(PROGRAM_ENTRY_NAME);
  if (entry === undefined || inits.length === 0) return { started: false, refused: null };
  const graph = entry.graph;
  const stamp = nodeIdStamper(graph);
  const block = graph.entry!;
  const calls: CFGInstruction[] = [];
  for (const name of inits) {
    const unit = units.get(name);
    if (unit === undefined) continue;
    if (canReject(unit.graph)) {
      return {
        started: false,
        refused:
          `module ${name} can throw while it loads, and the compiler cannot yet carry that ` +
          `throw out of a module; keep this part interpreted`,
      };
    }
    calls.push(stamp(irCallKnownFunction({ name } as never, [])));
  }
  for (const call of calls) call.block = block;
  block.nodes.unshift(...calls);
  graph.rebuildUses();
  return { started: true, refused: null };
}

function nameCalleeConstants(module: ModuleIR): void {
  const functions = new ModuleFunctions(module);
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_GENERIC_CALL) continue;
        const target = functions.referenced(node.inputs[0]);
        if (target !== null) node.props[CALLEE_SYMBOL_PROP] = target.name;
      }
    }
  }
}

function moduleSignatures(module: ModuleIR): Map<string, DeclaredSignature> {
  const signatures = new Map<string, DeclaredSignature>();
  for (const unit of module.units) {
    const declared = unit.graph.declaredSignature;
    if (declared !== null) signatures.set(unit.graph.name, declared);
  }
  return signatures;
}

function suspendingCallees(module: ModuleIR, timers: boolean): ReadonlySet<string> {
  const asynchronous = new Set<string>();
  for (const unit of module.units) {
    if (unit.graph.isAsync) asynchronous.add(unit.graph.name);
  }
  if (timers) asynchronous.add(CORO_SLEEP);
  return asynchronous;
}

function settledReturns(module: ModuleIR): ReadonlyMap<string, string> {
  const returns = new Map<string, string>();
  for (const unit of module.units) {
    if (!unit.graph.isAsync) continue;
    returns.set(unit.graph.name, unit.graph.declaredSignature?.returns ?? DEFAULT_RETURN);
  }
  return returns;
}

function calleeOf(node: CFGInstruction): string | null {
  if (node.type !== IR_GENERIC_CALL && node.type !== IR_CALL_KNOWN_FUNCTION) return null;
  return genericCalleeName(node) ?? calleeSymbolName(node);
}

function awaitsSomething(graph: CFGFunction, asynchronous: ReadonlySet<string>): boolean {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_AWAIT) continue;
      const awaited = node.inputs[0];
      const name = awaited === undefined ? null : calleeOf(awaited);
      if (name !== null && asynchronous.has(name)) return true;
    }
  }
  return false;
}

function canReject(graph: CFGFunction): boolean {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_RETURN && isPendingThrowReturn(node)) return true;
    }
  }
  return false;
}

function suspendingFunctions(
  module: ModuleIR,
  asynchronous: ReadonlySet<string>,
): ReadonlySet<string> {
  const suspending = new Set<string>();
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.props[AWAITED_CALL_PROP] === true) continue;
        const name = calleeOf(node);
        if (name !== null && name !== CORO_SLEEP && asynchronous.has(name)) suspending.add(name);
      }
    }
  }
  for (const unit of module.units) {
    const graph = unit.graph;
    if (!asynchronous.has(graph.name)) continue;
    if (awaitsSomething(graph, asynchronous) || canReject(graph)) suspending.add(graph.name);
  }
  return suspending;
}

function misusedPromise(
  graph: CFGFunction,
  suspending: ReadonlySet<string>,
): AotSkippedFunction | null {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const name = calleeOf(node);
      if (name === null || !suspending.has(name)) continue;
      if (node.uses.every((use) => use.type === IR_AWAIT)) continue;
      return {
        name: graph.name,
        reason:
          `the promise ${name} returns is used as a plain value here; ` +
          `await it before using it, or keep this part interpreted`,
      };
    }
  }
  return null;
}

interface CoroutinePlan {
  readonly asynchronous: ReadonlySet<string>;
  readonly suspending: ReadonlySet<string>;
  readonly promises: ReadonlyMap<string, ClassShape>;
  readonly failures: readonly AotSkippedFunction[];
}

function unitOf(graph: CFGFunction): CompilationUnit {
  return {
    name: graph.name,
    graph,
    frameStates: [],
    compiledFunction: null,
    osrOffset: null,
  };
}

const NO_COROUTINES: CoroutinePlan = {
  asynchronous: new Set(),
  suspending: new Set(),
  promises: new Map(),
  failures: [],
};

function sleepers(module: ModuleIR): readonly string[] {
  const names: string[] = [];
  for (const unit of module.units) {
    if (unit.graph.name === CORO_SLEEP) continue;
    for (const block of unit.graph.blocks) {
      if (block.nodes.some((node) => calleeNameOf(node) === CORO_SLEEP)) {
        names.push(unit.graph.name);
        break;
      }
    }
  }
  return names;
}

function planCoroutines(
  module: ModuleIR,
  classes: ClassTable | null,
  timers: boolean,
): CoroutinePlan {
  const asynchronous = suspendingCallees(module, timers);
  const suspending = suspendingFunctions(module, asynchronous);
  if (suspending.size === 0 && !timers) return { ...NO_COROUTINES, asynchronous };

  const failures: AotSkippedFunction[] = [];
  if (classes === null) {
    for (const name of suspending) {
      failures.push({ name, reason: "a suspending function needs a class table to hold its frame" });
    }
    return { ...NO_COROUTINES, asynchronous, failures };
  }

  for (const unit of module.units) {
    const misuse = misusedPromise(unit.graph, suspending);
    if (misuse !== null) failures.push(misuse);
  }
  if (failures.length > 0) return { ...NO_COROUTINES, asynchronous, failures };

  coroutineBaseShapes(classes);
  const promises = new Map<string, ClassShape>();
  for (const unit of module.units) {
    const graph = unit.graph;
    if (!suspending.has(graph.name)) continue;
    promises.set(
      graph.name,
      coroutinePromiseShape(classes, graph.name, graph.declaredSignature?.returns ?? DEFAULT_RETURN),
    );
  }
  if (timers) promises.set(CORO_SLEEP, coroutineTimerShape(classes));
  return { asynchronous, suspending, promises, failures };
}

function raisesThrow(graph: CFGFunction, rejecting: ReadonlySet<string>): boolean {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_CALL_BUILTIN && node.props.name === THROW_BUILTIN) return true;
      if (forwardsPendingThrow(node)) return true;
      const callee = calleeNameOf(node);
      if (callee !== null && rejecting.has(callee)) return true;
    }
  }
  return false;
}

function rejectingGraphs(module: ModuleIR): ReadonlySet<string> {
  const names = new Set<string>();
  for (const unit of module.units) {
    if (canReject(unit.graph)) names.add(unit.graph.name);
  }
  return names;
}

function splitGenerators(
  module: ModuleIR,
  classes: ClassTable,
  signatures: Map<string, DeclaredSignature>,
  failures: AotSkippedFunction[],
): readonly CompilationUnit[] {
  const added: CompilationUnit[] = [];
  let pending = module.units.filter((unit) => unit.graph.isGenerator);
  const refused = new Map<string, string>();
  for (let progress = true; progress && pending.length > 0; ) {
    progress = false;
    const rejecting = rejectingGraphs(module);
    const unresolved: CompilationUnit[] = [];
    for (const unit of pending) {
      const graph = unit.graph;
      if (raisesThrow(graph, rejecting)) {
        failures.push({
          name: graph.name,
          reason:
            `${graph.name} can throw while it is generating, and the compiler cannot yet carry ` +
            `that throw out of a generator; keep this part interpreted`,
        });
        continue;
      }
      if (graph.isAsync) {
        failures.push({
          name: graph.name,
          reason:
            `${graph.name} is an async generator, and the compiler has no shape for one; keep ` +
            `this part interpreted`,
        });
        continue;
      }
      const rewrote = stampCalleeSignatures(graph, signatures) + lowerGeneratorIteration(graph);
      if (rewrote > 0) unit.analyses?.invalidateAll();
      const resolved = generatorYieldType(graph);
      if (!("yields" in resolved)) {
        refused.set(graph.name, resolved.reason);
        unresolved.push(unit);
        continue;
      }
      progress = true;
      try {
        const split = splitGenerator(graph, classes, resolved.yields);
        unit.analyses?.invalidateAll();
        signatures.set(graph.name, {
          params: signatures.get(graph.name)?.params ?? [],
          returns: split.frame.name,
        });
        signatures.set(split.resume.name, split.resume.declaredSignature!);
        added.push(unitOf(split.resume));
      } catch (error) {
        if (!(error instanceof CoroutineSplitError)) throw error;
        failures.push({ name: graph.name, reason: error.message });
      }
    }
    pending = unresolved;
  }
  for (const unit of pending) {
    failures.push({ name: unit.graph.name, reason: refused.get(unit.graph.name)! });
  }
  return added;
}

function splitCoroutines(
  module: ModuleIR,
  classes: ClassTable,
  plan: CoroutinePlan,
  promiseOf: PromiseOf,
  entryName: string | undefined,
  failures: AotSkippedFunction[],
): readonly CompilationUnit[] {
  const added: CompilationUnit[] = [];
  for (const unit of module.units) {
    if (!plan.suspending.has(unit.graph.name)) continue;
    try {
      const split = splitCoroutine(
        unit.graph,
        classes,
        plan.promises.get(unit.graph.name)!,
        promiseOf,
      );
      if (split.resume === null || split.frame === null) continue;
      added.push(unitOf(split.resume));
    } catch (error) {
      if (!(error instanceof CoroutineSplitError)) throw error;
      failures.push({ name: unit.graph.name, reason: error.message });
    }
  }
  if (plan.promises.size === 0) return added;

  const timers = plan.promises.has(CORO_SLEEP);
  added.push(unitOf(buildDrain(classes, timers)));
  added.push(unitOf(buildReportRejections(classes)));
  if (timers) added.push(unitOf(buildWake(classes)));
  const entry = module.units.find((unit) => unit.graph.name === entryName);
  if (entry !== undefined) drainBeforeExit(entry.graph);
  return added;
}

function withSpecializations(module: ModuleIR, specialized: Specialization): ModuleIR {
  if (specialized.added.length === 0) return module;
  return {
    ...module,
    units: [
      ...module.units.filter((unit) => !specialized.retired.has(unit.graph.name)),
      ...specialized.added,
    ],
  };
}

function requireDeclaredParameters(module: ModuleIR): void {
  const undeclared: AotSkippedFunction[] = [];
  for (const unit of module.units) {
    if (unit.compiledFunction?.isArrow === true) continue;
    if (unit.compiledFunction?.runtimeBridge === true) continue;
    const index = undeclaredParameterOf(unit.graph);
    if (index === null) continue;
    undeclared.push({
      name: unit.graph.name,
      reason: undeclaredParameterReason(unit.graph.declaredSignature, index),
    });
  }
  if (undeclared.length > 0) throw new AotUndeclaredParameterError(undeclared);
}


function nameFunctionValues(module: ModuleIR, classes: ClassTable | null): void {
  const functions = new ModuleFunctions(module);
  const namesAClass = (name: string): boolean =>
    classes !== null && classes.shapeOf(name) !== null;
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        for (const value of [node, ...node.inputs]) {
          if (value.type !== IR_CONSTANT && value.type !== IR_LOAD_GLOBAL) continue;
          if (value.props[CODE_TARGET_PROP] !== undefined) continue;
          const target = functions.referenced(value);
          if (target === null || target.classOwner !== null || namesAClass(target.name)) continue;
          value.props[CODE_TARGET_PROP] = target.name;
        }
      }
    }
  }
}

interface LoweredUnit {
  readonly graph: CFGFunction;
  readonly analyses: AnalysisManager<CFGFunction>;
}

function inlineLoweredCalls(
  lowered: readonly LoweredUnit[],
  module: ModuleIR,
  options: CompilerOptions,
  declined: ReadonlySet<string>,
): void {
  const units = new Map(lowered.map((unit) => [unit.graph, unit.analyses]));
  const graphs = [...units.keys()].filter((graph) => !declined.has(graph.name));
  const functions = new ModuleFunctions(module);
  for (const graph of bottomUpCallOrder(graphs)) {
    const analyses = units.get(graph);
    if (analyses === undefined || inlineKnownCalls(graph, functions, options) === 0) continue;
    analyses.invalidateAll();
    analyses.invalidateAll();
  }
}

function inlineModuleCalls(
  module: ModuleIR,
  options: CompilerOptions,
  declined: ReadonlySet<string>,
): void {
  const graphs = module.units
    .map((unit) => unit.graph)
    .filter((graph) => !declined.has(graph.name));
  const functions = new ModuleFunctions(module);
  for (const graph of bottomUpCallOrder(graphs)) {
    const rewrote = inlineKnownCalls(graph, functions, options) + rewriteSelfTailCalls(graph, functions);
    if (rewrote === 0) continue;
    functions.unitOf(graph)?.analyses?.invalidateAll();
    runMiddleEnd(graph, staticCompilerOptions(options));
  }
}

export function compileModule(
  module: ModuleIR,
  backend: AotBackend,
  options: AotDriverOptions = {},
): AotProgram {
  const moduleName = options.moduleName ?? DEFAULT_MODULE_NAME;
  const opts = options.compilerOptions ?? compilerOptions();
  const compiled: LinkableFunction[] = [];
  const skipped: AotSkippedFunction[] = [...(options.skipped ?? [])];
  const seenSymbols = new Set<string>();

  const classes = moduleClasses(module);

  uniquifyGraphNames(module);
  nameCalleeConstants(module);
  lowerModuleCaptures(module, PROGRAM_ENTRY_NAME);
  dropFunctionBindings(module);
  lowerErrorSurface(module, classes);
  const start = startModules(module, options.moduleInits ?? []);
  const started = start.started;
  promoteRunOnceGlobals(module, runOnceGraphs(module, backend, options));
  convertClosures(module, classes);
  const promises = lowerPromiseSurface(module);
  if (promises.length > 0) module = { ...module, units: [...module.units, ...promises] };
  module = withSpecializations(module, specializeFunctionArguments(module));
  nameFunctionValues(module, classes);
  const byArgumentType = adoptInferredTypes(module, classes);
  if (byArgumentType.added.length > 0) {
    module = withSpecializations(module, byArgumentType);
    adoptInferredTypes(module, classes);
  }
  requireDeclaredParameters(module);
  if (classes !== null) declareGlobalVariables(module, classes);

  const sleeping = classes === null ? [] : sleepers(module);
  const clocked = backend.target.capabilities.has("timers");
  const timers = sleeping.length > 0 && clocked;
  if (timers) {
    coroutineBaseShapes(classes!);
    module = { ...module, units: [...module.units, unitOf(buildSleep(classes!))] };
  }
  const plan = planCoroutines(module, classes, timers);
  const clockless = sleeping.length > 0 && !clocked
    ? sleeping.map((name) => ({
        name,
        reason:
          `${CORO_SLEEP} needs a monotonic clock and a blocking wait, ` +
          `which the ${backend.id} backend does not provide`,
      }))
    : [];
  const failures = [...plan.failures, ...clockless];
  if (start.refused !== null) {
    failures.push({ name: PROGRAM_ENTRY_NAME, reason: start.refused });
  }
  const declined = new Set(failures.map((failure) => failure.name));
  const promiseOf = (node: CFGInstruction): ClassShape | null => {
    const name = calleeOf(node);
    return name === null ? null : plan.promises.get(name) ?? null;
  };

  const signatures = moduleSignatures(module);
  for (const [name, shape] of plan.promises) {
    signatures.set(name, { params: signatures.get(name)?.params ?? [], returns: shape.name });
  }

  if (classes !== null) {
    const generated = splitGenerators(module, classes, signatures, failures);
    for (const failure of failures) declined.add(failure.name);
    if (generated.length > 0) module = { ...module, units: [...module.units, ...generated] };
  }

  const lowered: Array<{
    readonly graph: CFGFunction;
    readonly analyses: AnalysisManager<CFGFunction>;
  }> = [];
  const lower = (unit: CompilationUnit): void => {
    const graph = unit.graph;
    if (declined.has(graph.name)) return;
    const analyses =
      unit.analyses ?? new AnalysisManager<CFGFunction>(graph, createAnalysisRegistry());
    try {
      graph.calleeSignatures = signatures;
      graph.emits = backend.emits;
      cfgPassManager(analyses, opts).run(graph, backend.loweringPipeline(opts));
      if (stampCalleeSignatures(graph, signatures) > 0) {
        analyses.invalidate(typeInferenceAnalysisId);
      }
    } catch (error) {
      if (!isBackendLoweringError(error)) throw error;
      skipped.push({ name: graph.name, reason: error.message });
      return;
    }
    lowered.push({ graph, analyses });
  };

  const awaitsAPromise = (node: CFGInstruction): boolean => {
    const awaited = node.inputs[0];
    const name = awaited === undefined ? null : calleeOf(awaited);
    return name !== null && plan.asynchronous.has(name);
  };

  const settled = settledReturns(module);
  const settledTypeOf = (node: CFGInstruction): string | null => {
    const name = calleeOf(node);
    return name === null ? null : settled.get(name) ?? null;
  };

  inlineModuleCalls(module, opts, declined);

  for (const unit of module.units) {
    const graph = unit.graph;
    const rewrote = plan.suspending.has(graph.name)
      ? elideAwaits(graph, awaitsAPromise) + typeAwaitedResults(graph, settledTypeOf)
      : (classes === null ? 0 : lowerAwaitedPromises(graph, classes, promiseOf)) +
        elideAwaits(graph, () => false);
    if (rewrote > 0) unit.analyses?.invalidate(typeInferenceAnalysisId);
    lower(unit);
  }

  const resumed =
    classes === null
      ? []
      : splitCoroutines(module, classes, plan, promiseOf, options.entry, failures);
  for (const failure of failures) declined.add(failure.name);
  for (const unit of resumed) signatures.set(unit.graph.name, unit.graph.declaredSignature!);
  if (plan.promises.size > 0) {
    for (const { graph, analyses } of lowered) {
      analyses.invalidateAll();
      stampCalleeSignatures(graph, signatures);
    }
  }
  for (const unit of resumed) lower(unit);

  inlineLoweredCalls(lowered, module, opts, declined);

  skipped.push(...failures);
  const emitting = lowered.filter(({ graph }) => !declined.has(graph.name));
  const graphs = emitting.map((unit) => unit.graph);
  const reachability = callReachability(graphs);
  markReentrantFunctions(graphs, reachability);
  for (const { graph, analyses } of emitting) {
    const reentering = (node: CFGInstruction): boolean => {
      const callee = calleeSymbolName(node);
      return callee !== null && reachability.reaches(callee, graph.name);
    };
    const copied = boxEscapingStrings(
      graph,
      analyses.get(typeInferenceAnalysisId),
      reentering,
    );
    if (copied > 0) analyses.invalidateAll();
  }
  const escapes = summarizeStringEscapes(
    emitting.map(({ graph, analyses }) => ({
      graph,
      types: analyses.get(typeInferenceAnalysisId),
    })),
    reachability,
  );
  for (const { graph, analyses } of emitting) {
    graph.stringEscapes = escapes;
    analyses.invalidate(aotLegalityAnalysisId);
  }

  for (const { graph, analyses } of emitting) {
    let emitted;
    try {
      emitted = backend.createEmitter(graph, analyses).emit();
    } catch (error) {
      if (!isBackendLoweringError(error)) throw error;
      skipped.push({ name: graph.name, reason: error.message });
      continue;
    }
    if (seenSymbols.has(emitted.symbol)) {
      skipped.push({ name: graph.name, reason: `duplicate symbol ${emitted.symbol}` });
      continue;
    }
    seenSymbols.add(emitted.symbol);
    compiled.push({ name: graph.name, emitted });
  }

  const linkable = dropUnresolvedCallers(compiled, skipped, (name) => backend.symbolOf(name));
  const inits = options.moduleInits ?? [];
  const moduleInits = started ? [] : inits.map((name) => backend.symbolOf(name));
  let files: readonly AotOutputFile[];
  try {
    files = backend.link(linkable, {
      moduleName,
      classes: moduleClasses(module),
      format: options.format,
      entry: options.entry,
      result: options.result,
      skipped,
      moduleInits,
      heapBytes: options.heapBytes,
    });
  } catch (error) {
    if (!isBackendLoweringError(error)) throw error;
    throw new AotLinkError(error.message, skipped);
  }
  return { files, compiled: linkable, skipped, moduleInits };
}
