import {
  IR_AWAIT,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_RETURN,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import type { DeclaredSignature } from "../types/signature.js";
import type { ClassShape, ClassTable } from "../metadata/class-table.js";
import { genericCalleeName, stampCalleeSignatures } from "../metadata/call-signatures.js";
import {
  aotLegalityAnalysisId,
  calleeSymbolName,
  summarizeStringEscapes,
} from "../analyses/aot-legality.js";
import { AWAITED_CALL_PROP } from "../builder/ir-builder.js";
import { isPendingThrowReturn } from "../builder/throw-recovery.js";
import { callReachability, markReentrantFunctions } from "../metadata/call-graph.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import type { AotBackend, LinkableFunction } from "../target/backend.js";
import type {
  AotOutputFile,
  AotOutputFormat,
  AotSkippedFunction,
} from "../target/artifact.js";

export type { AotSkippedFunction };
import type { EntryDelivery } from "../target/entry.js";
import { BackendLoweringError, isBackendLoweringError } from "../target/errors.js";
import { AnalysisManager } from "../infra/analysis-manager.js";
import { PassManager } from "../infra/pass-manager.js";
import { compilerOptions, type CompilerOptions } from "../options.js";
import { cfgPassTracer, maintainGraph } from "../pipeline.js";
import { createAnalysisRegistry } from "../analyses/index.js";
import { elideAwaits } from "../passes/await-elision.js";
import { literalReturnShapeOf, shapeObjectLiterals } from "../passes/object-literal-shapes.js";
import { specializeFunctionArguments } from "../passes/function-argument-specialization.js";
import { lowerPromiseSurface } from "../passes/promise-surface.js";
import {
  buildDispatch,
  buildDrain,
  buildReportRejections,
  CoroutineSplitError,
  lowerAwaitedPromises,
  drainBeforeExit,
  splitCoroutine,
  typeAwaitedResults,
  type PromiseOf,
} from "../passes/coroutines.js";
import { coroutineBaseShapes, coroutinePromiseShape } from "../metadata/coroutines.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";

export interface AotProgram {
  readonly files: readonly AotOutputFile[];
  readonly compiled: readonly LinkableFunction[];
  readonly skipped: readonly AotSkippedFunction[];
  readonly moduleInits?: readonly string[];
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
  for (const unit of module.units) {
    const graph = unit.graph;
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

function adoptLiteralShapes(module: ModuleIR): void {
  for (const unit of module.units) {
    const graph = unit.graph;
    if (graph.classes === null) continue;
    const analyses =
      unit.analyses ?? new AnalysisManager<CFGFunction>(graph, createAnalysisRegistry());
    if (shapeObjectLiterals(graph, analyses.get(typeInferenceAnalysisId)) === 0) continue;
    analyses.invalidate(typeInferenceAnalysisId);
    const returns = literalReturnShapeOf(graph);
    if (returns === null) continue;
    graph.declaredSignature = { params: graph.declaredSignature?.params ?? [], returns };
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

function suspendingCallees(module: ModuleIR): ReadonlySet<string> {
  const asynchronous = new Set<string>();
  for (const unit of module.units) {
    if (unit.graph.isAsync) asynchronous.add(unit.graph.name);
  }
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

/**
 * A rejection has to travel through the promise like any other settlement, or the
 * caller sees the throw before its await has taken its turn.
 */
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
        if (name !== null && asynchronous.has(name)) suspending.add(name);
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

function planCoroutines(module: ModuleIR, classes: ClassTable | null): CoroutinePlan {
  const asynchronous = suspendingCallees(module);
  const suspending = suspendingFunctions(module, asynchronous);
  if (suspending.size === 0) return { ...NO_COROUTINES, asynchronous };

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
  return { asynchronous, suspending, promises, failures };
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
  const routines = new Map<number, { resume: string; frame: ClassShape }>();
  let routine = 0;
  for (const unit of module.units) {
    if (!plan.suspending.has(unit.graph.name)) continue;
    try {
      const split = splitCoroutine(
        unit.graph,
        classes,
        routine,
        plan.promises.get(unit.graph.name)!,
        promiseOf,
      );
      if (split.resume === null || split.frame === null) continue;
      routines.set(routine, { resume: split.resume.name, frame: split.frame });
      added.push(unitOf(split.resume));
      routine++;
    } catch (error) {
      if (!(error instanceof CoroutineSplitError)) throw error;
      failures.push({ name: unit.graph.name, reason: error.message });
    }
  }
  if (plan.promises.size === 0) return added;

  added.push(unitOf(buildDispatch(classes, routines)));
  added.push(unitOf(buildDrain(classes)));
  added.push(unitOf(buildReportRejections(classes)));
  const entry = module.units.find((unit) => unit.graph.name === entryName);
  if (entry !== undefined) drainBeforeExit(entry.graph);
  return added;
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
  const promises = lowerPromiseSurface(module);
  if (promises.length > 0) module = { ...module, units: [...module.units, ...promises] };
  const specialized = specializeFunctionArguments(module);
  if (specialized.added.length > 0) {
    module = {
      ...module,
      units: [
        ...module.units.filter((unit) => !specialized.retired.has(unit.graph.name)),
        ...specialized.added,
      ],
    };
  }
  adoptLiteralShapes(module);

  const plan = planCoroutines(module, classes);
  const failures = [...plan.failures];
  const declined = new Set(failures.map((failure) => failure.name));
  const promiseOf = (node: CFGInstruction): ClassShape | null => {
    const name = calleeOf(node);
    return name === null ? null : plan.promises.get(name) ?? null;
  };

  const signatures = moduleSignatures(module);
  for (const [name, shape] of plan.promises) {
    signatures.set(name, { params: signatures.get(name)?.params ?? [], returns: shape.name });
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
      new PassManager<CFGFunction>(analyses, opts, cfgPassTracer(opts), maintainGraph).run(
        graph,
        backend.loweringPipeline(opts),
      );
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

  skipped.push(...failures);
  const emitting = lowered.filter(({ graph }) => !declined.has(graph.name));
  const graphs = emitting.map((unit) => unit.graph);
  const reachability = callReachability(graphs);
  markReentrantFunctions(graphs, reachability);
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
  const emitted = new Set(linkable.map((fn) => fn.emitted.symbol));
  const moduleInits = (options.moduleInits ?? []).filter((symbol) => emitted.has(symbol));
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
