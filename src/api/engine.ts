import { parse } from "../frontend/parser/language.js";
import { analyzeEffects } from "../frontend/effects/index.js";
import { Lexer } from "../frontend/lexer/index.js";
import { Parser } from "../frontend/parser/index.js";
import { RegisterBytecodeCompiler } from "../bytecode/register/compiler/index.js";
import {
  RegisterInterpreter,
  RegisterFrame,
  updateCallMode,
} from "../bytecode/register/interpreter/index.js";
import { RegisterException } from "../bytecode/register/interpreter/helpers.js";
import {
  CompiledFunctionIdAllocator,
  RegisterCompiledFunction,
  ROP_THROW,
  ROP_LDA_GLOBAL,
  ROP_TRY_START,
  withCompiledFunctionIdAllocator,
} from "../bytecode/register/ops/bytecode.js";
import type { RegisterConstant, OsrEntry } from "../bytecode/register/ops/bytecode.js";
import { cellKey, splitCellKey, type GlobalCell } from "../runtime/intrinsics/global-cells.js";
import { ENTRY_SPEC, NATIVE_PREFIX, buildModuleGraph, checkModuleGraph, type ModuleFileSystem, type ModuleGraph, type ModuleInterface, type ModuleRecord } from "../frontend/modules/index.js";
import { createJSObject } from "../objects/heap/factory.js";
import { Optimizer } from "../optimizing/optimizer.js";
import { createJitBackendRegistry, resolveJitBackend } from "../optimizing/backends/jit.js";
import { compileModule, type AotProgram, type AotSkippedFunction } from "../optimizing/drivers/aot.js";
import {
  classMemberRenames,
  classMemberSymbol,
  classValueNameOf,
} from "../optimizing/metadata/class-symbols.js";
import type { EntryDelivery } from "../optimizing/target/entry.js";
import { markProgramEntry, PROGRAM_ENTRY_NAME } from "../optimizing/target/program-entry.js";
import { collectionPrelude, COLLECTION_GLOBALS } from "../optimizing/prelude/collections.js";
import { astChildren, NodeType } from "../frontend/ast/index.js";
import type { AotOutputFormat } from "../optimizing/target/artifact.js";
import { createModuleIR, type CompilationUnit } from "../optimizing/compilation-unit.js";
import { IR_GENERIC_CALL, type CFGInstruction } from "../optimizing/ir/index.js";
import { CALLEE_SYMBOL_PROP, genericCalleeName } from "../optimizing/metadata/call-signatures.js";
import { memberCallTargets, type MemberCallTargets } from "../optimizing/passes/class-member-lowering.js";
import { typeInferenceAnalysisId } from "../optimizing/analyses/type-inference.js";
import type { BackendRegistry } from "../optimizing/target/registry.js";
import { BackendLoweringError, isBackendLoweringError } from "../optimizing/target/errors.js";
import { isAotBackend, type AotBackend } from "../optimizing/target/backend.js";
import type { JitBackend } from "../optimizing/target/jit.js";
import { BaselineCompiler } from "../optimizing/baseline/compiler.js";
import { Deoptimizer } from "../deopt/deoptimizer.js";
import { DependencyRegistry, withDependencyRegistry } from "../deopt/dependencies.js";
import { DEP_CALL_TARGET } from "../deopt/dependencies.js";
import type { Dependency } from "../deopt/dependencies.js";
import { tracer } from "../core/tracing/index.js";
import { getPayload, getTag, isObject, isPromise, mkObject, mkUndefined, toDisplayString, ValueHeap, withValueHeap } from "../core/value/index.js";
import type { HeapPayload } from "../core/value/index.js";
import type { TaggedValue } from "../core/value/index.js";
import {
  HiddenClassRegistry,
  withHiddenClassRegistry,
} from "../objects/maps/hidden-class.js";
import { getMigrationStats } from "../objects/heap/js-object.js";
import { IRNodeIdAllocator, resetIRNodeIds, withIRNodeIdAllocator } from "../optimizing/ir/index.js";
import type { CompilerOptions } from "../optimizing/options.js";
import { compileCooldownUntil, createTieringPolicy } from "../runtime/tiering/policy.js";
import type { TieringPolicyOptions } from "../runtime/tiering/policy.js";
import {
  MicrotaskQueue,
  MicrotaskPolicy,
  MicrotasksScope,
} from "../runtime/microtasks/microtask.js";
import type { MicrotaskPolicyValue, UnhandledRejection } from "../runtime/microtasks/microtask.js";
import { GenerationalGC } from "../gc/gc.js";
import { withGC } from "../objects/heap/factory.js";
import { hostBuiltin, taggedToNative, withHostAsync } from "../runtime/domain/host.js";
import { introspectReceiverMembers } from "../runtime/introspect.js";
import type { IntrospectedMember } from "../runtime/introspect.js";
import { builtinValue, installBuiltinEntries, isRuntimeFunctionPayload, type BuiltinRegistryMap } from "../runtime/builtins/index.js";
import {
  checkSource,
  checkSourceProgram,
  TypecheckError,
  type Diagnostic,
  type BindOptions,
  type ExternalBuiltinSignature,
} from "../frontend/checker/index.js";
import { classSurfacesOf } from "../frontend/modules/interface.js";
import { buildClassTable, constructorFieldDisagreement, type ClassTable } from "../optimizing/metadata/class-table.js";
import type { ASTNode } from "../frontend/ast/index.js";
import type { SyntaxPlugin } from "../frontend/parser/extensions.js";
import type { RuntimeDebugger } from "../debugger/runtime.js";
import { mergeCompilerExtensions, mergeExtensionRecords, mergeNamedExtensionItems, resolveTeraExtensions, type NativeHostBuiltinRegistry, type TeraCompilerExtension, type TeraCompilerPhase, type TeraExtension, type TeraNativeModule } from "./extensions.js";

export type EngineOptions = {
  backends?: BackendRegistry;
  jitBackendId?: string;
  moduleFileSystem?: ModuleFileSystem;
  typecheck?: "off" | "warn" | "strict";
  output?: (text: string) => void;
  input?: (prompt: string) => string | null;
  osr?: boolean;
  tieringPolicy?: TieringPolicyOptions;
  microtaskPolicy?: MicrotaskPolicyValue;
  gc?: ConstructorParameters<typeof GenerationalGC>[0];
  trace?: boolean;
  traceCategories?: Iterable<string>;
  debugger?: RuntimeDebugger | null;
  extensions?: readonly TeraExtension[];
  syntaxPlugins?: readonly SyntaxPlugin[];
  hostBuiltins?: NativeHostBuiltinRegistry;
  runtimeBuiltins?: BuiltinRegistryMap;
  compiler?: TeraCompilerExtension;
  checkerBuiltins?: readonly ExternalBuiltinSignature[];
  checkerAliases?: BindOptions["aliases"];
  checkerInterfaces?: BindOptions["interfaces"];
  onCompile?: (fn: RegisterCompiledFunction) => void;
  onOptimize?: (fn: RegisterCompiledFunction, graph: OptimizedGraph) => void;
  onUnhandledRejection?: (rejections: EngineUnhandledRejection[]) => void;
};


export type EngineUnhandledRejection = {
  reason: unknown;
  message: string;
};

export type OptimizedGraph = { dump(): string };

const IMPORT_PROBE = /^[ \t]*(?:import|from)\s/m;
const SYNTHETIC_ENTRY = "__entry__.tera";
const MODULE_INIT_NAME = "tera_module_init";

export type CompileOptions = {
  lazy?: boolean;
  sourceName?: string | null;
  moduleRoot?: string;
  searchPaths?: readonly string[];
  syntaxPlugins?: readonly SyntaxPlugin[];
  checkerBuiltins?: readonly ExternalBuiltinSignature[];
  checkerAliases?: BindOptions["aliases"];
  checkerInterfaces?: BindOptions["interfaces"];
  compiler?: TeraCompilerExtension;
};

export type ModuleRunOptions = CompileOptions & {
  root?: string;
  searchPaths?: readonly string[];
  entrySource?: string;
};

export type AotCompileOptions = CompileOptions & {
  backend?: string;
  functionNames?: readonly string[];
  moduleName?: string;
  compilerOptions?: CompilerOptions;
  format?: AotOutputFormat;
  entry?: string;
  result?: EntryDelivery;
  heapBytes?: number;
};

export type AotFunctionCompileOptions = {
  backend?: string;
  moduleName?: string;
  compilerOptions?: CompilerOptions;
  format?: AotOutputFormat;
  entry?: string;
  result?: EntryDelivery;
  program?: RegisterCompiledFunction | null;
  moduleInits?: readonly string[];
  internalSymbols?: ReadonlySet<string>;
  heapBytes?: number;
};

export type AotModuleCompileOptions = ModuleRunOptions & {
  wholeProgram?: boolean;
  backend?: string;
  moduleName?: string;
  compilerOptions?: CompilerOptions;
  format?: AotOutputFormat;
  entry?: string;
  result?: EntryDelivery;
  heapBytes?: number;
};

export type EngineValue = {
  tag: string;
  value: HeapPayload;
};

type LazyCompiledFunction = RegisterCompiledFunction & {
  lazySource: string;
  lazyBodyStart: number | null;
  lazyBodyEnd: number | null;
  lazyParams: TaggedValue[] | null;
};

type RuntimeCompiledFunction = RegisterCompiledFunction;

type RuntimePromisePayload = {
  state: "pending" | "fulfilled" | "rejected";
  result: TaggedValue;
  addReaction(reaction: (state: string, result: TaggedValue) => void): void;
};

type EngineInterpreter = RegisterInterpreter & {
  icManager?: {
    invalidateDeprecatedMaps(): void;
  };
};

type ObjectWithCompiled = {
  compiled?: RuntimeCompiledFunction;
};

function isCompiledFunction(
  value: RegisterConstant | HeapPayload | null | undefined,
): value is RuntimeCompiledFunction {
  return (
    typeof value === "object" &&
    value !== null &&
    "instructions" in value &&
    Array.isArray(value.instructions)
  );
}

function exportOwner(graph: ModuleGraph, spec: string, name: string): string {
  const visited = new Set<string>();
  let currentSpec = spec;
  let currentName = name;
  for (;;) {
    const key = cellKey(currentSpec, currentName);
    if (visited.has(key)) return key;
    visited.add(key);
    const record = graph.modules.get(currentSpec);
    if (record === undefined) return key;
    const forwarded = reexportSource(record, currentName);
    if (forwarded === null) return key;
    currentSpec = forwarded.module;
    currentName = forwarded.imported;
  }
}

function reexportSource(
  record: ModuleRecord,
  local: string,
): { module: string; imported: string } | null {
  for (const entry of record.imports) {
    for (const binding of entry.bindings) {
      if (binding.local !== local || binding.submodule !== null) continue;
      return { module: binding.module, imported: binding.imported };
    }
  }
  return null;
}

function withRenamedFunctions<T>(
  renames: ReadonlyMap<RegisterCompiledFunction, string>,
  run: () => T,
): T {
  const original = new Map<RegisterCompiledFunction, string | null>();
  for (const [compiledFn, name] of renames) {
    original.set(compiledFn, compiledFn.name);
    compiledFn.name = name;
  }
  try {
    return run();
  } finally {
    for (const [compiledFn, name] of original) compiledFn.name = name;
  }
}

function isModulePrivateName(name: string | null): boolean {
  return name !== null && splitCellKey(name).name.startsWith("_");
}

function moduleExportOwners(graph: ModuleGraph): Map<string, string> {
  const owners = new Map<string, string>();
  for (const record of graph.modules.values()) {
    for (const entry of record.imports) {
      for (const binding of entry.bindings) {
        if (binding.submodule !== null) continue;
        const key = cellKey(record.spec, binding.local);
        const owner = exportOwner(graph, binding.module, binding.imported);
        if (owner !== key) owners.set(key, owner);
      }
    }
  }
  return owners;
}

function namespaceBindings(record: ModuleRecord): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const entry of record.imports) {
    if (entry.local === null || entry.boundSpec === null) continue;
    bindings.set(entry.local, entry.boundSpec);
  }
  for (const entry of record.imports) {
    for (const binding of entry.bindings) {
      if (binding.submodule !== null) bindings.set(binding.local, binding.submodule);
    }
  }
  return bindings;
}

function runtimeIntrinsicNames(compiler: Required<TeraCompilerExtension>): ReadonlySet<string> {
  return new Set(compiler.intrinsics.filter((intrinsic) => intrinsic.lowering === "runtime").map((intrinsic) => intrinsic.name));
}

function functionName(compiledFn: { name?: string | null }): string {
  return compiledFn.name || "<anonymous>";
}

function aotBaseName(compiledFn: RegisterCompiledFunction): string {
  return classMemberSymbol(compiledFn) ?? functionName(compiledFn);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectCompiledFunctions(
  root: RegisterCompiledFunction,
  includeRoot: boolean,
): RegisterCompiledFunction[] {
  const result: RegisterCompiledFunction[] = [];
  const seen = new Set<RegisterCompiledFunction>();
  const visit = (compiledFn: RegisterCompiledFunction, include: boolean): void => {
    if (seen.has(compiledFn)) return;
    seen.add(compiledFn);
    if (include) result.push(compiledFn);
    for (const constant of compiledFn.constants) {
      if (isCompiledFunction(constant)) visit(constant, true);
    }
  };
  visit(root, includeRoot);
  return result;
}

function loadsCollection(compiledFn: RegisterCompiledFunction): boolean {
  return compiledFn.instructions.some((instruction) => {
    if (instruction.opcode !== ROP_LDA_GLOBAL) return false;
    const name = compiledFn.constants[instruction.operands[0]!];
    return typeof name === "string" && COLLECTION_GLOBALS.has(name);
  });
}

function referencesCollections(root: RegisterCompiledFunction): boolean {
  return collectCompiledFunctions(root, true).some(loadsCollection);
}

function namesCollection(node: ASTNode): boolean {
  if (node.type === NodeType.Identifier && COLLECTION_GLOBALS.has(String(node.name))) return true;
  return astChildren(node).some(namesCollection);
}

function mentionsCollections(graph: ModuleGraph): boolean {
  return [...graph.modules.values()].some((record) => namesCollection(record.ast));
}

function catchesThrows(compiledFn: RegisterCompiledFunction): boolean {
  return compiledFn.instructions.some(
    (instruction) => instruction.opcode === ROP_TRY_START,
  );
}

function raisesThrows(compiledFn: RegisterCompiledFunction): boolean {
  return compiledFn.instructions.some((instruction) => instruction.opcode === ROP_THROW);
}

function needsThrowRecovery(selected: readonly RegisterCompiledFunction[]): boolean {
  if (selected.some(catchesThrows)) return true;
  return selected.some((fn) => fn.isAsync === true) && selected.some(raisesThrows);
}

function gathersArguments(compiledFn: RegisterCompiledFunction): boolean {
  return compiledFn.declaredSignature?.variadic === true;
}

interface GatheringCallSite {
  readonly node: CFGInstruction;
  readonly arity: number;
  readonly renamable: boolean;
}

interface GatheringFunction {
  readonly compiledFn: RegisterCompiledFunction;
  readonly name: string;
  readonly internal: boolean;
  readonly slots: number[];
  decided: readonly number[] | null;
}

interface CalleeTargets extends MemberCallTargets {
  readonly renamable: boolean;
}

type CallSitesByTarget = ReadonlyMap<string, readonly GatheringCallSite[]>;

type GatheredClones = ReadonlyMap<string, ReadonlyMap<number, string>>;

type UnitBuilder = (
  compiledFn: RegisterCompiledFunction,
  gathered: number | null,
  internal?: boolean,
) => CompilationUnit;

const GATHERED_CLONE_SEPARATOR = "$";

function calleeTargetsOf(unit: CompilationUnit, node: CFGInstruction): CalleeTargets | null {
  const classes = unit.graph.classes;
  const types = unit.analyses?.get(typeInferenceAnalysisId);
  if (classes !== null && types !== undefined) {
    const member = memberCallTargets(unit.graph, node, classes, types);
    if (member !== null) return { ...member, renamable: false };
  }
  const name = genericCalleeName(node) ?? classValueNameOf(node.inputs[0]);
  if (name === null) return null;
  return {
    symbols: [name],
    arity: node.inputs.length - 1,
    renamable: classes === null || classes.shapeOf(name) === null,
  };
}

function callSitesOf(units: readonly CompilationUnit[]): CallSitesByTarget {
  const sites = new Map<string, GatheringCallSite[]>();
  for (const unit of units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_GENERIC_CALL) continue;
        const call = calleeTargetsOf(unit, node);
        if (call === null) continue;
        const site = { node, arity: call.arity, renamable: call.renamable };
        for (const symbol of call.symbols) {
          const group = sites.get(symbol);
          if (group === undefined) sites.set(symbol, [site]);
          else group.push(site);
        }
      }
    }
  }
  return sites;
}

function gatheredArgumentsOf(
  compiledFn: RegisterCompiledFunction,
  calls: readonly GatheringCallSite[],
): Map<number, number> | null {
  const gathered = new Map<number, number>();
  for (const call of calls) {
    if (call.arity < compiledFn.paramCount) return null;
    gathered.set(call.arity, call.arity - compiledFn.paramCount);
  }
  if (gathered.size > 1 && !calls.every((call) => call.renamable)) return null;
  return gathered.size === 0 ? null : gathered;
}

function specializeGathering(
  entry: GatheringFunction,
  gathered: ReadonlyMap<number, number>,
  units: CompilationUnit[],
  build: UnitBuilder,
): Map<number, string> | null {
  const clones = gathered.size > 1;
  const built: CompilationUnit[] = [];
  for (const [arity, count] of gathered) {
    const name = clones ? `${entry.name}${GATHERED_CLONE_SEPARATOR}${arity}` : entry.name;
    try {
      built.push(
        withRenamedFunctions(new Map([[entry.compiledFn, name]]), () =>
          build(entry.compiledFn, count, entry.internal),
        ),
      );
    } catch (error) {
      if (!isBackendLoweringError(error)) throw error;
      return null;
    }
  }
  const named = new Map<number, string>();
  [...gathered.keys()].forEach((arity, index) => {
    const slot = entry.slots[index] ?? units.length;
    if (index >= entry.slots.length) entry.slots.push(slot);
    units[slot] = built[index]!;
    named.set(arity, built[index]!.graph.name);
  });
  return clones ? named : null;
}

function settledOn(decided: readonly number[] | null, arities: readonly number[]): boolean {
  if (decided === null) return false;
  if (arities.length < decided.length) return true;
  return decided.length === arities.length && decided.every((arity, at) => arity === arities[at]);
}

function gatherRestParameters(
  gathering: readonly GatheringFunction[],
  units: CompilationUnit[],
  build: UnitBuilder,
): void {
  const clones = new Map<string, ReadonlyMap<number, string>>();
  for (let progressed = true; progressed; ) {
    progressed = false;
    const sites = callSitesOf(units);
    for (const entry of gathering) {
      const calls = sites.get(entry.name) ?? [];
      const arities = [...new Set(calls.map((call) => call.arity))].sort();
      if (arities.length === 0 || settledOn(entry.decided, arities)) continue;
      entry.decided = arities;
      const gathered = gatheredArgumentsOf(entry.compiledFn, calls);
      if (gathered === null) continue;
      const named = specializeGathering(entry, gathered, units, build);
      if (named !== null) clones.set(entry.name, named);
      progressed = true;
    }
  }
  renameGatheredCallees(callSitesOf(units), clones);
}

function renameGatheredCallees(sites: CallSitesByTarget, clones: GatheredClones): void {
  for (const [base, group] of sites) {
    const named = clones.get(base);
    if (named === undefined) continue;
    for (const site of group) {
      const target = named.get(site.arity);
      if (target !== undefined && site.renamable) site.node.props[CALLEE_SYMBOL_PROP] = target;
    }
  }
}

function policyWithCompileHooks(policy: ReturnType<typeof createTieringPolicy>): {
  recordCompileSuccess?: (compiledFn: RegisterCompiledFunction) => void;
  recordCompileFailure?: (
    compiledFn: RegisterCompiledFunction,
    reason: string,
  ) => void;
} {
  const hooks: {
    recordCompileSuccess?: (compiledFn: RegisterCompiledFunction) => void;
    recordCompileFailure?: (
      compiledFn: RegisterCompiledFunction,
      reason: string,
    ) => void;
  } = {};
  if ("recordCompileSuccess" in policy) {
    hooks.recordCompileSuccess = policy.recordCompileSuccess.bind(policy);
  }
  if ("recordCompileFailure" in policy) {
    hooks.recordCompileFailure = policy.recordCompileFailure.bind(policy);
  }
  return hooks;
}

export class TeraThrow extends Error {
  readonly value: TaggedValue;
  constructor(message: string, value: TaggedValue) {
    super(message);
    this.name = "TeraThrow";
    this.value = value;
  }
}

function describeThrown(value: TaggedValue): string {
  if (isObject(value)) {
    const message = getPayload(value).getProperty("message");
    if (message !== undefined) {
      const name = getPayload(value).getProperty("name");
      return `${name !== undefined ? toDisplayString(name) : "Error"}: ${toDisplayString(message)}`;
    }
  }
  return toDisplayString(value);
}

function uncaughtMessage(value: TaggedValue): string {
  return `Uncaught ${describeThrown(value)}`;
}

export class Engine {
  tieringPolicy: ReturnType<typeof createTieringPolicy>;
  microtaskQueue: MicrotaskQueue;
  gc: GenerationalGC;
  interpreter: EngineInterpreter;
  baselineCompiler: BaselineCompiler;
  optimizer: Optimizer;
  backends: BackendRegistry;
  jitBackend: JitBackend;
  moduleFileSystem: ModuleFileSystem | null;
  deoptimizer: Deoptimizer;
  compilationCount: number;
  executionCount: number;
  totalCompileTimeMs: number;
  totalExecTimeMs: number;
  typecheckMode: "off" | "warn" | "strict";
  output?: (text: string) => void;
  input?: (prompt: string) => string | null;
  diagnostics: Diagnostic[];
  private aotClasses: ClassTable | null = null;
  osrEnabled: boolean;
  valueHeap: ValueHeap;
  dependencyRegistry: DependencyRegistry;
  hiddenClassRegistry: HiddenClassRegistry;
  irNodeIdAllocator: IRNodeIdAllocator;
  compiledFunctionIdAllocator: CompiledFunctionIdAllocator;
  debugger: RuntimeDebugger | null;
  syntaxPlugins: readonly SyntaxPlugin[];
  checker: BindOptions;
  compilerExtensions: Required<TeraCompilerExtension>;
  functionCompilerExtensions: WeakMap<RegisterCompiledFunction, Required<TeraCompilerExtension>>;
  hostBuiltinRegistry: NativeHostBuiltinRegistry;
  runtimeBuiltinRegistry: BuiltinRegistryMap;
  sharedGlobals: Set<string>;
  initializedModules: Set<string>;
  lastModuleEntry: { path: string; options: ModuleRunOptions } | null;
  private readonly moduleExportCache = new WeakMap<ModuleGraph, Map<string, string>>();
  nativeModules: readonly TeraNativeModule[];
  onCompile?: (fn: RegisterCompiledFunction) => void;
  onOptimize?: (fn: RegisterCompiledFunction, graph: OptimizedGraph) => void;
  onUnhandledRejection?: (rejections: EngineUnhandledRejection[]) => void;

  constructor(options: EngineOptions = {}) {
    this.valueHeap = new ValueHeap();
    this.dependencyRegistry = new DependencyRegistry();
    this.hiddenClassRegistry = new HiddenClassRegistry();
    this.irNodeIdAllocator = new IRNodeIdAllocator();
    this.compiledFunctionIdAllocator = new CompiledFunctionIdAllocator();
    this.debugger = options.debugger ?? null;
    const extensions = resolveTeraExtensions(options.extensions);
    this.syntaxPlugins = mergeNamedExtensionItems("syntax plugin", extensions.syntaxPlugins, options.syntaxPlugins);
    this.checker = {
      builtins: mergeNamedExtensionItems("checker builtin", extensions.checker.builtins, options.checkerBuiltins),
      aliases: mergeNamedExtensionItems("checker alias", extensions.checker.aliases, options.checkerAliases),
      interfaces: mergeNamedExtensionItems("checker interface", extensions.checker.interfaces, options.checkerInterfaces),
    };
    this.compilerExtensions = mergeCompilerExtensions(extensions.compiler, options.compiler);
    this.functionCompilerExtensions = new WeakMap();
    this.hostBuiltinRegistry = mergeExtensionRecords("host builtin", extensions.hostBuiltins, options.hostBuiltins);
    this.runtimeBuiltinRegistry = mergeExtensionRecords("runtime builtin", extensions.runtimeBuiltins, options.runtimeBuiltins);
    this.sharedGlobals = new Set();
    this.initializedModules = new Set();
    this.lastModuleEntry = null;
    this.nativeModules = extensions.modules;
    this.moduleFileSystem = options.moduleFileSystem ?? null;
    this.typecheckMode = options.typecheck || "warn";
    this.output = options.output;
    this.input = options.input;
    this.diagnostics = [];
    this.osrEnabled = options.osr !== false;
    this.onCompile = options.onCompile;
    this.onOptimize = options.onOptimize;
    this.onUnhandledRejection = options.onUnhandledRejection;
    this.tieringPolicy = createTieringPolicy(options.tieringPolicy);
    this.microtaskQueue = new MicrotaskQueue({
      policy: options.microtaskPolicy || MicrotaskPolicy.AUTO,
    });
    this.wireUnhandledRejectionReporter();
    this.gc = new GenerationalGC(options.gc || {}, this.valueHeap);
    this.interpreter = this.runInRuntime(
      () => new RegisterInterpreter(this) as EngineInterpreter,
      false,
    );
    this.installExtensionBuiltins();
    this.runInRuntime(() => this.installNativeModules(), false);
    this.sharedGlobals = new Set(this.interpreter.globalCells.cells.keys());
    this.interpreter.debugger = this.debugger;
    this.gc.bindRoots(
      this.interpreter,
      this.interpreter.globalCells,
      this.microtaskQueue,
    );
    this.baselineCompiler = new BaselineCompiler();
    this.optimizer = new Optimizer(this.compilerExtensions);
    this.backends = options.backends ?? createJitBackendRegistry();
    this.jitBackend = resolveJitBackend(this.backends, options.jitBackendId);
    this.deoptimizer = new Deoptimizer(this.interpreter);
    this.dependencyRegistry.bindLazyMarker(this.deoptimizer.lazyMarker);
    this.compilationCount = 0;
    this.executionCount = 0;
    this.totalCompileTimeMs = 0;
    this.totalExecTimeMs = 0;

    if (options.trace) {
      tracer.enable();
      if (options.traceCategories) {
        tracer.setCategories(options.traceCategories);
      }
    }
  }

  private hostAsyncBinding() {
    return {
      queue: this.microtaskQueue,
      drain: () => this.drainMicrotasks(),
      interpreter: this.interpreter,
      run: <T>(fn: () => T) => this.runInRuntime(fn),
    };
  }

  private runInRuntime<T>(run: () => T, bindHost = true): T {
    const hostBinding = bindHost ? this.hostAsyncBinding() : null;
    return withValueHeap(this.valueHeap, () =>
      withDependencyRegistry(this.dependencyRegistry, () =>
        withHiddenClassRegistry(this.hiddenClassRegistry, () =>
          withIRNodeIdAllocator(this.irNodeIdAllocator, () =>
            withCompiledFunctionIdAllocator(this.compiledFunctionIdAllocator, () =>
              withGC(this.gc, () => withHostAsync(hostBinding, run)),
            ),
          ),
        ),
      ),
    );
  }

  private installHostBuiltins(registry: NativeHostBuiltinRegistry): void {
    const entries: BuiltinRegistryMap = {};
    for (const [name, fn] of Object.entries(registry)) {
      entries[name] = hostBuiltin(name, fn);
    }
    installBuiltinEntries(this.interpreter.globalCells, entries);
  }

  private installRuntimeBuiltins(registry: BuiltinRegistryMap): void {
    installBuiltinEntries(this.interpreter.globalCells, registry);
  }

  private installRuntimeIntrinsics(registry: BuiltinRegistryMap, compiler: Required<TeraCompilerExtension>): void {
    for (const intrinsic of compiler.intrinsics) {
      if (intrinsic.lowering !== "runtime") continue;
      const entry = registry[intrinsic.name];
      if (!isRuntimeFunctionPayload(entry)) {
        throw new Error(`Runtime intrinsic '${intrinsic.name}' is not installed`);
      }
      this.interpreter.installRuntimeIntrinsic(intrinsic.name, entry);
      this.sharedGlobals.add(intrinsic.name);
    }
  }

  private installNativeModules(): void {
    for (const module of this.nativeModules) {
      const spec = `${NATIVE_PREFIX}${module.name}`;
      const entries: BuiltinRegistryMap = {};
      for (const [name, fn] of Object.entries(module.hostExports ?? {})) {
        entries[name] = hostBuiltin(name, fn);
      }
      for (const [name, entry] of Object.entries(module.runtimeExports ?? {})) {
        entries[name] = entry;
      }
      for (const [name, entry] of Object.entries(entries)) {
        this.interpreter.globalCells.write(cellKey(spec, name), builtinValue(name, entry));
      }
    }
  }

  private nativeModuleInterfaces(): Map<string, ModuleInterface> {
    const interfaces = new Map<string, ModuleInterface>();
    for (const module of this.nativeModules) {
      if (module.interface === undefined) continue;
      interfaces.set(`${NATIVE_PREFIX}${module.name}`, module.interface);
    }
    return interfaces;
  }

  private installExtensionBuiltins(): void {
    const needsRuntimeIntrinsics = this.compilerExtensions.intrinsics.some((intrinsic) => intrinsic.lowering === "runtime");
    if (!Object.keys(this.hostBuiltinRegistry).length && !Object.keys(this.runtimeBuiltinRegistry).length && !needsRuntimeIntrinsics) return;
    this.runInRuntime(() => {
      this.installRuntimeBuiltins(this.runtimeBuiltinRegistry);
      this.installRuntimeIntrinsics(this.runtimeBuiltinRegistry, this.compilerExtensions);
      this.installHostBuiltins(this.hostBuiltinRegistry);
    });
  }

  private compileSyntaxPlugins(options: CompileOptions): readonly SyntaxPlugin[] {
    return mergeNamedExtensionItems("syntax plugin", this.syntaxPlugins, options.syntaxPlugins);
  }

  private compileChecker(options: CompileOptions): BindOptions {
    return {
      builtins: mergeNamedExtensionItems("checker builtin", this.checker.builtins, options.checkerBuiltins),
      aliases: mergeNamedExtensionItems("checker alias", this.checker.aliases, options.checkerAliases),
      interfaces: mergeNamedExtensionItems("checker interface", this.checker.interfaces, options.checkerInterfaces),
    };
  }

  private compileCompilerExtensions(options: CompileOptions): Required<TeraCompilerExtension> {
    return mergeCompilerExtensions(this.compilerExtensions, options.compiler);
  }

  private rememberCompilerExtensions(compiledFn: RegisterCompiledFunction, compiler: Required<TeraCompilerExtension>): void {
    this.functionCompilerExtensions.set(compiledFn, compiler);
    for (const constant of compiledFn.constants) {
      if (isCompiledFunction(constant)) this.rememberCompilerExtensions(constant, compiler);
    }
  }

  private compilerExtensionsFor(compiledFn: RegisterCompiledFunction): Required<TeraCompilerExtension> {
    return this.functionCompilerExtensions.get(compiledFn) ?? this.compilerExtensions;
  }

  runCompilerPasses<T>(phase: TeraCompilerPhase, target: T, compiler = this.compilerExtensions): T {
    let current: unknown = target;
    const context = {
      phase,
      intrinsics: compiler.intrinsics,
      effects: compiler.effects,
      guards: compiler.guards,
      deopts: compiler.deopts,
    };
    for (const pass of compiler.optimizerPasses) {
      if (pass.phase !== phase) continue;
      const next = pass.run(current, context);
      if (next !== undefined) current = next;
    }
    return current as T;
  }

  compile(source: string, options: CompileOptions = {}): RegisterCompiledFunction {
    return this.runInRuntime(() => this.compileInRuntime(source, options));
  }

  compileAot(source: string, options: AotCompileOptions = {}): AotProgram {
    return this.runInRuntime(() => this.compileAotInRuntime(source, options));
  }

  compileAotFunctions(
    functions: Iterable<RegisterCompiledFunction>,
    options: AotFunctionCompileOptions = {},
  ): AotProgram {
    return this.runInRuntime(() => this.compileAotFunctionsInRuntime(functions, options));
  }

  private compileAotInRuntime(source: string, options: AotCompileOptions = {}): AotProgram {
    const {
      backend,
      functionNames,
      moduleName,
      compilerOptions,
      format,
      entry,
      result,
      heapBytes,
      ...compileOptions
    } = options;
    const probed = this.compileInRuntime(source, compileOptions, true);
    const compiled = referencesCollections(probed)
      ? this.compileInRuntime(`${source}
${collectionPrelude()}`, compileOptions, true)
      : probed;
    const program = entry === undefined ? compiled : null;
    const functions = this.selectAotFunctions(
      collectCompiledFunctions(compiled, program !== null),
      functionNames,
    );
    return withRenamedFunctions(classMemberRenames(functions), () =>
      this.compileAotFunctionsInRuntime(functions, {
        backend,
        moduleName,
        compilerOptions,
        format,
        entry,
        result,
        heapBytes,
        program,
      }),
    );
  }

  compileAotModule(entryPath: string, options: AotModuleCompileOptions = {}): AotProgram {
    const graph = this.loadModuleGraph(entryPath, options, true);
    return this.runInRuntime(() => this.compileAotModuleInRuntime(graph, options));
  }

  private compileAotModuleInRuntime(
    graph: ModuleGraph,
    options: AotModuleCompileOptions,
  ): AotProgram {
    const { backend, moduleName, compilerOptions, format, entry, result, heapBytes } = options;
    const renames = new Map<RegisterCompiledFunction, string>();
    const moduleInits: string[] = [];
    let program: RegisterCompiledFunction | null = null;

    for (const record of graph.initOrder) {
      const code = this.compileModuleRecord(record, graph, options);
      for (const compiledFn of collectCompiledFunctions(code, true)) {
        if (compiledFn === code) continue;
        renames.set(compiledFn, cellKey(record.spec, aotBaseName(compiledFn)));
      }
      if (record.spec === ENTRY_SPEC) {
        program = code;
        renames.set(code, PROGRAM_ENTRY_NAME);
        continue;
      }
      const init = cellKey(record.spec, MODULE_INIT_NAME);
      renames.set(code, init);
      moduleInits.push(init);
    }

    const keep = new Set([PROGRAM_ENTRY_NAME, ...moduleInits]);
    if (entry !== undefined) keep.add(entry);
    const internalSymbols = new Set<string>();
    for (const name of renames.values()) {
      if (keep.has(name)) continue;
      if (options.wholeProgram === true || isModulePrivateName(name)) internalSymbols.add(name);
    }

    return withRenamedFunctions(renames, () =>
      this.compileAotFunctionsInRuntime([...renames.keys()], {
        backend,
        moduleName,
        compilerOptions,
        format,
        entry,
        result,
        heapBytes,
        program: entry === undefined ? program : null,
        moduleInits,
        internalSymbols,
      }),
    );
  }

  private compileAotFunctionsInRuntime(
    functions: Iterable<RegisterCompiledFunction>,
    options: AotFunctionCompileOptions = {},
  ): AotProgram {
    const backend = this.resolveAotBackend(options.backend ?? "c");
    const units: CompilationUnit[] = [];
    const skipped: AotSkippedFunction[] = [];
    const selected = this.uniqueCompiledFunctions(functions);
    const recoversThrows = needsThrowRecovery(selected);

    const internalOf = (compiledFn: RegisterCompiledFunction) =>
      options.internalSymbols?.has(compiledFn.name ?? "") ?? false;
    const build: UnitBuilder = (compiledFn, gathered, internal) =>
      this.compileAotUnit(
        compiledFn,
        compiledFn === options.program,
        internal ?? internalOf(compiledFn),
        recoversThrows,
        gathered,
      );

    const gathering: GatheringFunction[] = [];
    for (const compiledFn of selected) {
      try {
        const unit = build(compiledFn, null);
        if (gathersArguments(compiledFn)) {
          gathering.push({
            compiledFn,
            name: unit.graph.name,
            internal: internalOf(compiledFn),
            slots: [units.length],
            decided: null,
          });
        }
        units.push(unit);
      } catch (error) {
        if (!isBackendLoweringError(error)) throw error;
        skipped.push({ name: functionName(compiledFn), reason: error.message });
      }
    }
    gatherRestParameters(gathering, units, build);

    return compileModule(createModuleIR(units), backend, {
      moduleName: options.moduleName,
      compilerOptions: options.compilerOptions,
      format: options.format,
      entry: options.entry ?? (options.program == null ? undefined : PROGRAM_ENTRY_NAME),
      result: options.result,
      moduleInits: options.moduleInits,
      heapBytes: options.heapBytes,
      skipped,
    });
  }

  private resolveAotBackend(id: string): AotBackend {
    const backend = this.backends.resolve(id);
    if (!isAotBackend(backend)) {
      throw new Error(`Backend "${id}" is not an AOT backend`);
    }
    return backend;
  }

  private uniqueCompiledFunctions(functions: Iterable<RegisterCompiledFunction>): RegisterCompiledFunction[] {
    const result: RegisterCompiledFunction[] = [];
    const seen = new Set<RegisterCompiledFunction>();
    for (const compiledFn of functions) {
      if (seen.has(compiledFn)) continue;
      seen.add(compiledFn);
      result.push(compiledFn);
    }
    return result;
  }

  private selectAotFunctions(
    functions: readonly RegisterCompiledFunction[],
    functionNames: readonly string[] | undefined,
  ): RegisterCompiledFunction[] {
    if (functionNames === undefined) return [...functions];

    const byName = new Map<string, RegisterCompiledFunction>();
    for (const compiledFn of functions) {
      if (compiledFn.name !== null && !byName.has(compiledFn.name)) {
        byName.set(compiledFn.name, compiledFn);
      }
    }

    return functionNames.map((name) => {
      const compiledFn = byName.get(name);
      if (compiledFn === undefined) throw new Error(`AOT function not found: ${name}`);
      return compiledFn;
    });
  }

  private compileAotUnit(
    compiledFn: RegisterCompiledFunction,
    isProgram: boolean,
    internal = isModulePrivateName(compiledFn.name),
    recoversThrows = false,
    gatheredArguments: number | null = null,
  ): CompilationUnit {
    if (compiledFn.isLazy) this.compileLazy(compiledFn);
    this.verifyClassShape(compiledFn);
    resetIRNodeIds();
    this.optimizer.setCompilerExtensions(this.compilerExtensionsFor(compiledFn));
    const unit = this.optimizer.compileStatic(
      compiledFn,
      this.aotClasses,
      recoversThrows,
      gatheredArguments,
    ).unit;
    unit.graph.internal = !isProgram && internal;
    if (!isProgram) return unit;
    markProgramEntry(unit.graph);
    return { ...unit, name: unit.graph.name };
  }

  private verifyClassShape(compiledFn: RegisterCompiledFunction): void {
    if (compiledFn.classMemberKind !== "constructor") return;
    const observed = compiledFn.simpleConstructorInfo;
    if (observed == null || this.aotClasses === null) return;
    const shape = this.aotClasses.shapeOf(compiledFn.classOwnerName ?? "");
    if (shape === null) return;
    const disagreement = constructorFieldDisagreement(
      shape,
      observed.map((field) => field.name),
    );
    if (disagreement !== null) throw new BackendLoweringError(disagreement);
  }

  private compileInRuntime(
    source: string,
    options: CompileOptions = {},
    retainClassShapes = false,
  ): RegisterCompiledFunction {
    const syntaxPlugins = this.compileSyntaxPlugins(options);
    const checker = this.compileChecker(options);
    const compilerExtensions = this.compileCompilerExtensions(options);
    const checkerOptions = {
      syntaxPlugins,
      builtins: checker.builtins,
      aliases: checker.aliases,
      interfaces: checker.interfaces,
    };
    if (retainClassShapes) {
      const checked = checkSourceProgram(source, {
        ...checkerOptions,
        mode: this.typecheckMode === "off" ? "warn" : this.typecheckMode,
      });
      this.diagnostics = this.typecheckMode === "off" ? [] : checked.diagnostics;
      this.aotClasses = buildClassTable(classSurfacesOf(checked.bound));
    } else {
      this.diagnostics = checkSource(source, { ...checkerOptions, mode: this.typecheckMode });
    }
    if (this.typecheckMode === "strict" && this.diagnostics.length > 0) {
      throw new TypecheckError(this.diagnostics);
    }
    this.installRuntimeIntrinsics(this.runtimeBuiltinRegistry, compilerExtensions);
    const parsed = this.runCompilerPasses("ast", parse(source, { syntaxPlugins }), compilerExtensions);
    const ast = this.runCompilerPasses("semantic", analyzeEffects(parsed), compilerExtensions) as ASTNode;
    const compiler = new RegisterBytecodeCompiler({
      sourceName: options.sourceName ?? null,
      runtimeIntrinsics: runtimeIntrinsicNames(compilerExtensions),
    });
    const compiled = this.runCompilerPasses("bytecode", compiler.compile(ast), compilerExtensions);
    this.rememberCompilerExtensions(compiled, compilerExtensions);
    this.reportCompiled(compiled);
    return compiled;
  }

  private compileModuleRecord(
    record: ModuleRecord,
    graph: ModuleGraph,
    options: CompileOptions,
  ): RegisterCompiledFunction {
    const compilerExtensions = this.compileCompilerExtensions(options);
    this.installRuntimeIntrinsics(this.runtimeBuiltinRegistry, compilerExtensions);
    const parsed = this.runCompilerPasses("ast", record.ast, compilerExtensions);
    const ast = this.runCompilerPasses("semantic", analyzeEffects(parsed), compilerExtensions) as ASTNode;
    const compiler = new RegisterBytecodeCompiler({
      sourceName: record.path ?? record.spec,
      runtimeIntrinsics: runtimeIntrinsicNames(compilerExtensions),
      moduleSpec: record.spec,
      isSharedGlobal: (name) => this.sharedGlobals.has(name),
      moduleBindings: namespaceBindings(record),
      moduleSpecs: new Set(graph.modules.keys()),
      moduleExports: this.moduleExportsFor(graph),
    });
    const compiled = this.runCompilerPasses("bytecode", compiler.compile(ast), compilerExtensions);
    this.rememberCompilerExtensions(compiled, compilerExtensions);
    this.reportCompiled(compiled);
    return compiled;
  }

  private moduleExportsFor(graph: ModuleGraph): ReadonlyMap<string, string> {
    let owners = this.moduleExportCache.get(graph);
    if (owners === undefined) {
      owners = moduleExportOwners(graph);
      this.moduleExportCache.set(graph, owners);
    }
    return owners;
  }

  private linkModuleGraph(graph: ModuleGraph): void {
    const cells = this.interpreter.globalCells;
    for (const [key, owner] of this.moduleExportsFor(graph)) {
      cells.alias(key, cells.getOrCreate(owner));
    }
  }

  private publishModuleNamespaces(record: ModuleRecord, graph: ModuleGraph): void {
    const cells = this.interpreter.globalCells;
    for (const [local, spec] of namespaceBindings(record)) {
      const owner = graph.modules.get(spec);
      if (owner === undefined) continue;
      const namespace = createJSObject();
      for (const [name, binding] of owner.bindings) {
        if (!binding.exported) continue;
        const value = cells.read(cellKey(spec, name));
        if (value !== undefined) namespace.setProperty(name, value);
      }
      cells.write(cellKey(record.spec, local), mkObject(namespace));
    }
  }

  runModuleGraph(graph: ModuleGraph, options: CompileOptions = {}): TaggedValue {
    return this.runInRuntime(() => {
      const pending = graph.initOrder.filter(
        (record) => record.spec === ENTRY_SPEC || !this.initializedModules.has(record.spec),
      );
      const compiled = pending.map((record) => ({
        record,
        code: this.compileModuleRecord(record, graph, options),
      }));
      this.linkModuleGraph(graph);
      let result: TaggedValue = mkUndefined();
      const scope = new MicrotasksScope(this.microtaskQueue, this.interpreter);
      try {
        for (const unit of compiled) {
          this.publishModuleNamespaces(unit.record, graph);
          this.initializedModules.add(unit.record.spec);
          this.executionCount++;
          result = this.interpreter.execute(unit.code);
        }
        if (isPromise(result)) {
          this.microtaskQueue.markObserved(
            getPayload(result) as unknown as UnhandledRejection["promise"],
          );
        }
        return result;
      } catch (error) {
        throw this.asUncaught(error);
      } finally {
        scope.exit();
      }
    });
  }

  runModule(entryPath: string, options: ModuleRunOptions = {}): TaggedValue {
    const result = this.runModuleGraph(this.loadModuleGraph(entryPath, options), options);
    this.valueHeap.enableExternalLookup();
    return result;
  }

  runModuleNative(entryPath: string, options: ModuleRunOptions = {}): unknown {
    const raw = this.runModule(entryPath, options);
    return this.runInRuntime(() => this.toNativeResult(raw));
  }

  runModuleGraphNative(graph: ModuleGraph, options: CompileOptions = {}): unknown {
    const raw = this.runModuleGraph(graph, options);
    this.valueHeap.enableExternalLookup();
    return this.runInRuntime(() => this.toNativeResult(raw));
  }

  reloadModule(spec: string): boolean {
    const entry = this.lastModuleEntry;
    if (entry === null || spec === ENTRY_SPEC) return false;
    if (!this.runInRuntime(() => this.resetModuleCells(spec), false)) return false;
    this.initializedModules.delete(spec);
    for (const compiledFn of this.collectFunctions()) this.deoptimizeFunction(compiledFn);
    this.runModuleGraph(this.loadModuleGraph(entry.path, entry.options), entry.options);
    return true;
  }

  private resetModuleCells(spec: string): boolean {
    const cells = this.interpreter.globalCells;
    const replacements = new Map<GlobalCell, GlobalCell>();
    for (const [key, cell] of [...cells.cells]) {
      if (splitCellKey(cell.name).module !== spec) continue;
      let replacement = replacements.get(cell);
      if (replacement === undefined) {
        replacement = cells.replace(cell.name);
        replacements.set(cell, replacement);
      }
      cells.alias(key, replacement);
    }
    return replacements.size > 0;
  }

  loadedModules(): string[] {
    return [...this.initializedModules].filter((spec) => spec !== ENTRY_SPEC).sort();
  }

  loadModuleGraph(
    entryPath: string,
    options: ModuleRunOptions = {},
    collectClasses = false,
  ): ModuleGraph {
    const fileSystem = this.moduleFileSystem;
    if (fileSystem === null) {
      throw new Error(
        "Loading a module graph needs a moduleFileSystem; pass one to the Engine constructor",
      );
    }
    this.lastModuleEntry = { path: entryPath, options };
    const syntaxPlugins = this.compileSyntaxPlugins(options);
    const build = (entrySource: string | undefined): ModuleGraph =>
      buildModuleGraph(entryPath, {
        fileSystem,
        root: options.root,
        searchPaths: options.searchPaths,
        entrySource,
        nativeModules: this.nativeModules.map((module) => module.name),
        parseSource: (source) => parse(source, { syntaxPlugins }),
      });
    const built = build(options.entrySource);
    const graph =
      collectClasses && mentionsCollections(built)
        ? build(`${built.entry.source}
${collectionPrelude()}`)
        : built;
    const checker = this.compileChecker(options);
    const checked = checkModuleGraph(graph, {
      mode: this.typecheckMode,
      builtins: checker.builtins,
      aliases: checker.aliases,
      interfaces: checker.interfaces,
      nativeInterfaces: this.nativeModuleInterfaces(),
      collectClasses,
    });
    this.diagnostics = [...checked.diagnostics];
    if (collectClasses) this.aotClasses = buildClassTable(checked.classes);
    if (this.typecheckMode === "strict" && this.diagnostics.length > 0) {
      throw new TypecheckError(this.diagnostics);
    }
    return graph;
  }

  private reportCompiled(compiled: RegisterCompiledFunction): void {
    if (!this.onCompile) return;
    for (const compiledFn of collectCompiledFunctions(compiled, true)) {
      if (!compiledFn.isLazy) this.onCompile(compiledFn);
    }
  }

  parseSource(source: string, options: CompileOptions = {}): ASTNode {
    return this.runInRuntime(() => {
      const syntaxPlugins = this.compileSyntaxPlugins(options);
      const compilerExtensions = this.compileCompilerExtensions(options);
      return this.runCompilerPasses(
        "ast",
        parse(source, { syntaxPlugins }),
        compilerExtensions,
      ) as ASTNode;
    });
  }

  private tryRunAsModuleEntry(source: string, options: CompileOptions): TaggedValue | null {
    const root = options.moduleRoot;
    if (root === undefined || !IMPORT_PROBE.test(source)) return null;
    const graph = this.loadModuleGraph(`${root}/${SYNTHETIC_ENTRY}`, {
      ...options,
      root,
      entrySource: source,
    });
    if (graph.entry.imports.length === 0) return null;
    return this.runModuleGraph(graph, options);
  }

  private runSource(source: string, options: CompileOptions = {}): TaggedValue {
    const asModule = this.tryRunAsModuleEntry(source, options);
    if (asModule !== null) return asModule;
    this.executionCount++;
    const t0 = performance.now();

    const compiled = this.compile(source, options);
    const compileTime = performance.now() - t0;
    this.totalCompileTimeMs += compileTime;

    const t1 = performance.now();
    const result = this.runInRuntime(() => {
      const scope = new MicrotasksScope(
        this.microtaskQueue,
        this.interpreter,
      );
      try {
        const raw = this.interpreter.execute(compiled);
        if (isPromise(raw)) {
          this.microtaskQueue.markObserved(
            getPayload(raw) as unknown as UnhandledRejection["promise"],
          );
        }
        return raw;
      } catch (error) {
        throw this.asUncaught(error);
      } finally {
        scope.exit();
      }
    });
    const execTime = performance.now() - t1;
    this.totalExecTimeMs += execTime;

    tracer.perfMark(`Compile`, compileTime);
    tracer.perfMark(`Execute`, execTime);

    return result;
  }

  run(source: string, options: CompileOptions = {}): TaggedValue {
    const result = this.runSource(source, options);
    this.valueHeap.enableExternalLookup();
    return result;
  }

  private asUncaught(error: unknown): unknown {
    if (!(error instanceof RegisterException)) return error;
    this.valueHeap.enableExternalLookup();
    return new TeraThrow(uncaughtMessage(error.value), error.value);
  }

  introspectMembers(receiver: string): IntrospectedMember[] | null {
    return this.runInRuntime(() => introspectReceiverMembers(this.interpreter.globalCells, receiver));
  }

  runValue(source: string, options: CompileOptions = {}): EngineValue {
    const raw = this.runSource(source, options);
    return this.runInRuntime(() => ({ tag: getTag(raw), value: getPayload(raw) }));
  }

  runNative(source: string, options: CompileOptions = {}): unknown {
    const raw = this.runSource(source, options);
    return this.runInRuntime(() => this.toNativeResult(raw));
  }

  private toNativeResult(value: TaggedValue): unknown {
    if (!isPromise(value)) return taggedToNative(value);
    this.drainMicrotasks();
    const promise = getPayload(value) as RuntimePromisePayload;
    if (promise.state === "fulfilled") return taggedToNative(promise.result);
    if (promise.state === "rejected") {
      throw new TeraThrow(uncaughtMessage(promise.result), promise.result);
    }
    return new Promise((resolve, reject) => {
      promise.addReaction((state, result) => {
        this.runInRuntime(() => {
          try {
            if (state === "fulfilled") resolve(taggedToNative(result));
            else reject(taggedToNative(result));
          } catch (error) {
            reject(error);
          }
        });
      });
      this.drainMicrotasks();
    });
  }

  executeValue(
    compiledFn: RegisterCompiledFunction,
    args: TaggedValue[] = [],
    thisValue: TaggedValue | null = null,
  ): EngineValue {
    return this.runInRuntime(() => {
      const raw = this.interpreter.execute(compiledFn, args, thisValue);
      return { tag: getTag(raw), value: getPayload(raw) };
    });
  }

  runMicrotasks(): boolean {
    return this.runInRuntime(() => this.microtaskQueue.runOne(this.interpreter));
  }

  drainMicrotasks(): void {
    return this.runInRuntime(() => this.microtaskQueue.drain(this.interpreter));
  }

  performMicrotaskCheckpoint(): void {
    return this.runInRuntime(() => this.microtaskQueue.performCheckpoint(this.interpreter));
  }

  setMicrotaskPolicy(policy: MicrotaskPolicyValue): void {
    this.microtaskQueue.setPolicy(policy);
  }

  private wireUnhandledRejectionReporter(): void {
    const report = this.onUnhandledRejection;
    if (!report) {
      this.microtaskQueue.setUnhandledRejectionReporter(null);
      return;
    }
    this.microtaskQueue.setUnhandledRejectionReporter((rejections: UnhandledRejection[]) => {
      const infos = this.runInRuntime(() =>
        rejections.map(({ reason }) => ({
          reason: taggedToNative(reason),
          message: describeThrown(reason),
        })),
      );
      report(infos);
    });
  }

  runWithDisassembly(source: string, options: CompileOptions = {}): TaggedValue {
    const compiled = this.compile(source, options);
    console.log(compiled.disassemble());

    for (const constant of compiled.constants) {
      if (isCompiledFunction(constant)) {
        console.log(constant.disassemble());
      }
    }

    const result = this.runInRuntime(() => this.interpreter.execute(compiled));
    this.drainMicrotasks();
    this.valueHeap.enableExternalLookup();
    return result;
  }

  compileLazy(compiledFn: RegisterCompiledFunction): void {
    if (!compiledFn.isLazy) return;
    const lazyFn = compiledFn as LazyCompiledFunction;
    const oldVersion = compiledFn.version || 0;

    tracer.log("compile", `Lazy-compiling function "${compiledFn.name}"`);

    const source = lazyFn.lazySource;
    const bodyStart = lazyFn.lazyBodyStart;
    const bodyEnd = lazyFn.lazyBodyEnd;
    if (bodyStart === null || bodyEnd === null) return;

    const lexer = new Lexer(source);
    const allTokens = lexer.tokenize();

    const bodyTokens = allTokens.slice(bodyStart, bodyEnd);
    bodyTokens.push({ type: "EOF", value: "", line: 0, column: 0 });

    const parser = new Parser(bodyTokens, { syntaxPlugins: this.syntaxPlugins });
    const body = parser.parseBlock();
    const compilerExtensions = this.compilerExtensionsFor(compiledFn);
    this.installRuntimeIntrinsics(this.runtimeBuiltinRegistry, compilerExtensions);

    const compiler = new RegisterBytecodeCompiler({
      sourceName: compiledFn.sourceName,
      runtimeIntrinsics: runtimeIntrinsicNames(compilerExtensions),
    });
    const ast = {
      type: "Program",
      body: [
        {
          type: "FunctionDeclaration",
          name: compiledFn.name,
          params: lazyFn.lazyParams,
          body,
        },
      ],
    };
    const compiled = compiler.compile(
      ast as Parameters<RegisterBytecodeCompiler["compile"]>[0],
    );

    const innerFn = compiled.constants.find(
      (c): c is RegisterCompiledFunction =>
        isCompiledFunction(c) && c.name === compiledFn.name,
    );
    if (innerFn) {
      compiledFn.instructions = innerFn.instructions;
      compiledFn.constants = innerFn.constants;
      compiledFn.localCount = innerFn.localCount;
      compiledFn.registerCount = innerFn.registerCount;
      compiledFn.feedbackSlotCount = innerFn.feedbackSlotCount;
      compiledFn.upvalues = innerFn.upvalues;
      compiledFn.sourceName = innerFn.sourceName;
      compiledFn.sourceMap = innerFn.sourceMap;
    }
    this.rememberCompilerExtensions(compiledFn, compilerExtensions);

    compiledFn.isLazy = false;
    compiledFn.version = oldVersion + 1;
    this.dependencyRegistry.invalidate(
      DEP_CALL_TARGET,
      compiledFn.id,
      oldVersion,
      "function-version-change",
    );
    compiledFn.lazySource = null;
    compiledFn.lazyBodyStart = null;
    compiledFn.lazyBodyEnd = null;
    compiledFn.lazyParams = null;
    this.onCompile?.(compiledFn);
  }

  baselineCompile(compiledFn: RegisterCompiledFunction): void {
    return this.runInRuntime(() => this.baselineCompileInRuntime(compiledFn));
  }

  private baselineCompileInRuntime(compiledFn: RegisterCompiledFunction): void {
    if (compiledFn.baselineCode) return;

    try {
      const baselineFn = this.baselineCompiler.compile(
        compiledFn,
        this.interpreter,
      );
      if (baselineFn) {
        compiledFn.baselineCode = baselineFn;
        updateCallMode(compiledFn);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      tracer.jitCompile(functionName(compiledFn), `Baseline failed: ${message}`);
    }
  }

  compileOsr(compiledFn: RegisterCompiledFunction, offset: number): OsrEntry | null {
    return this.runInRuntime(() => this.compileOsrInRuntime(compiledFn, offset));
  }

  private compileOsrInRuntime(compiledFn: RegisterCompiledFunction, offset: number): OsrEntry | null {
    const cached = compiledFn.osrCache.get(offset);
    if (cached !== undefined) return cached;

    if (!this.jitBackend.target.capabilities.has("osr")) {
      compiledFn.osrCache.set(offset, null);
      return null;
    }

    if (compiledFn.isAsync || compiledFn.isGenerator) {
      compiledFn.osrCache.set(offset, null);
      return null;
    }

    let entry: OsrEntry | null = null;
    try {
      resetIRNodeIds();
      this.optimizer.setCompilerExtensions(this.compilerExtensionsFor(compiledFn));
      const result = this.optimizer.compile(compiledFn, offset);
      if (!result.graph.bailout) {
        const code = this.jitBackend.jitCompile({ unit: result.unit }).code;
        if (code) {
          entry = { code, slots: result.graph.osrParamSlots ?? [] };
          this.dependencyRegistry.registerOsr(compiledFn, result.graph.dependencies);
          tracer.jitOSR(functionName(compiledFn), offset);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!isBackendLoweringError(e)) {
        compiledFn.disableOptimization = true;
        tracer.jitCompile(
          functionName(compiledFn),
          `Optimization disabled — internal compiler error during OSR: ${message}`,
        );
      } else {
        tracer.jitCompile(functionName(compiledFn), `OSR failed: ${message}`);
      }
      entry = null;
    }

    compiledFn.osrCache.set(offset, entry);
    return entry;
  }

  optimizeFunction(compiledFn: RegisterCompiledFunction): void {
    return this.runInRuntime(() => this.optimizeFunctionInRuntime(compiledFn));
  }

  private optimizeFunctionInRuntime(compiledFn: RegisterCompiledFunction): void {
    if (compiledFn.isAsync || compiledFn.isGenerator) {
      compiledFn.lastCompileFailureReason = "interpreter-only-async-generator";
      tracer.jitCompile(
        functionName(compiledFn),
        "Optimization skipped: async/generator",
      );
      return;
    }
    this.compilationCount++;
    const t0 = performance.now();

    try {
      resetIRNodeIds();
      this.optimizer.setCompilerExtensions(this.compilerExtensionsFor(compiledFn));
      const optimizerResult = this.optimizer.compile(compiledFn);
      this.onOptimize?.(compiledFn, optimizerResult.graph as OptimizedGraph);
      const jitResult = this.jitBackend.jitCompile({ unit: optimizerResult.unit });
      const wasmFn = jitResult.code;

      if (wasmFn) {
        compiledFn.optimizedCode = wasmFn;
        updateCallMode(compiledFn);
        compiledFn.compileFailureCount = 0;
        compiledFn.lastCompileFailureReason = null;
        compiledFn.optimizationCooldownUntil = 0;
        const policyHooks = policyWithCompileHooks(this.tieringPolicy);
        if (
          this.tieringPolicy &&
          typeof policyHooks.recordCompileSuccess === "function"
        ) {
          policyHooks.recordCompileSuccess(compiledFn);
        }
        this.dependencyRegistry.register(
          compiledFn as Parameters<typeof this.dependencyRegistry.register>[0],
          ((optimizerResult.graph as { dependencies?: Dependency[] }).dependencies || []),
        );
        const elapsed = performance.now() - t0;
        tracer.jitCompile(
          functionName(compiledFn),
          `Wasm installed in ${elapsed.toFixed(2)}ms`,
        );
      } else {
        const rejection = jitResult.rejection.compileRejection;
        const malformedGraph = rejection?.kind === "malformed";
        this.recordCompileFailure(
          compiledFn,
          malformedGraph
            ? `internal compiler error: ${rejection.reason}`
            : rejection?.reason || jitResult.rejection.analysisFailure || "not-compilable",
          malformedGraph,
        );
        tracer.jitCompile(
          functionName(compiledFn),
          "Wasm compilation skipped — cooldown",
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const internal = !isBackendLoweringError(e);
      this.recordCompileFailure(
        compiledFn,
        internal ? `internal compiler error: ${message}` : message,
        internal,
      );
      tracer.jitCompile(
        functionName(compiledFn),
        internal
          ? `Optimization disabled — internal compiler error: ${message}`
          : `Compilation failed: ${message}`,
      );
    }
  }

  private recordCompileFailure(
    compiledFn: RegisterCompiledFunction,
    reason: string,
    unrecoverable: boolean,
  ): void {
    compiledFn.compileFailureCount = (compiledFn.compileFailureCount || 0) + 1;
    compiledFn.lastCompileFailureReason = reason;
    if (unrecoverable) {
      compiledFn.disableOptimization = true;
    } else {
      compiledFn.optimizationCooldownUntil = compileCooldownUntil(
        this.tieringPolicy,
        compiledFn.compileFailureCount,
        Date.now(),
      );
    }
    const policyHooks = policyWithCompileHooks(this.tieringPolicy);
    if (this.tieringPolicy && typeof policyHooks.recordCompileFailure === "function") {
      policyHooks.recordCompileFailure(compiledFn, reason);
    }
  }

  ageCode(
    allFunctions: Iterable<RuntimeCompiledFunction>,
    options: { ageThreshold?: number; idleMs?: number } = {},
  ): number {
    const CODE_AGE_THRESHOLD = options.ageThreshold || 5;
    const CODE_IDLE_MS = options.idleMs || 30000;
    const now = Date.now();
    let flushedCount = 0;

    for (const fn of allFunctions) {
      if (!fn.optimizedCode && !fn.baselineCode) continue;

      const idleTime = now - (fn.lastExecutionTime || 0);
      if (idleTime < CODE_IDLE_MS) {
        fn.codeAge = 0;
        continue;
      }

      fn.codeAge = (fn.codeAge || 0) + 1;

      if (fn.codeAge >= CODE_AGE_THRESHOLD) {
        if (fn.optimizedCode) {
          tracer.jitCompile(
            functionName(fn),
            `Code aged out (age=${fn.codeAge}, idle=${(idleTime / 1000).toFixed(1)}s) — flushing optimized code`,
          );
          this.flushOptimizedCode(fn);
          flushedCount++;
        }
        if (fn.codeAge >= CODE_AGE_THRESHOLD * 2 && fn.baselineCode) {
          tracer.jitCompile(
            functionName(fn),
            `Code aged out (age=${fn.codeAge}) — flushing baseline code`,
          );
          fn.baselineCode = null;
          updateCallMode(fn);
          flushedCount++;
        }
        if (fn.codeAge >= CODE_AGE_THRESHOLD) {
          fn.invocationCount = 0;
          fn.codeAge = 0;
        }
      }
    }

    return flushedCount;
  }

  collectFunctions(): RuntimeCompiledFunction[] {
    return this.runInRuntime(() => this.collectFunctionsInRuntime());
  }

  private collectFunctionsInRuntime(): RuntimeCompiledFunction[] {
    const functions: RuntimeCompiledFunction[] = [];
    const visited = new Set<TaggedValue | HeapPayload>();

    const collect = (val: TaggedValue | HeapPayload | null | undefined): void => {
      if (!val) return;
      if (visited.has(val)) return;
      visited.add(val);

      const payload = typeof val === "number" ? getPayload(val) : null;
      const target = payload && typeof payload === "object" ? payload : val;

      if (typeof target === "object" && target !== null) {
        const maybeTarget = target as ObjectWithCompiled;
        if (maybeTarget.compiled && isCompiledFunction(maybeTarget.compiled)) {
          functions.push(maybeTarget.compiled);
          for (const c of maybeTarget.compiled.constants) {
            if (isCompiledFunction(c)) {
              functions.push(c);
            }
          }
        }
      }
      if (payload && typeof payload === "object") collect(payload);
    };

    if (this.interpreter.globalCells) {
      for (const [, cell] of this.interpreter.globalCells.cells as Iterable<[string, GlobalCell]>) {
        collect(cell.value);
      }
    }

    return functions;
  }

  runAgingCycle(options: { ageThreshold?: number; idleMs?: number } = {}): number {
    const functions = this.collectFunctions();
    const flushed = this.ageCode(functions, options);

    if (this.interpreter.icManager) {
      this.interpreter.icManager.invalidateDeprecatedMaps();
    }

    return flushed;
  }

  collectGarbage(type: "minor" | "major" | string = "minor"): void {
    this.runInRuntime(() =>
      this.gc.collectGarbage(type as Parameters<GenerationalGC["collectGarbage"]>[0]),
    );
  }

  private flushOptimizedCode(fn: RuntimeCompiledFunction): boolean {
    if (!fn.optimizedCode) return false;
    if (fn.optimizedCode._dispose) fn.optimizedCode._dispose();
    this.dependencyRegistry.unregister(
      fn as Parameters<typeof this.dependencyRegistry.unregister>[0],
    );
    fn.optimizedCode = null;
    fn.disableOptimization = false;
    updateCallMode(fn);
    return true;
  }

  deoptimizeFunction(compiledFn: RegisterCompiledFunction): boolean {
    return this.runInRuntime(() => this.flushOptimizedCode(compiledFn));
  }

  getStats(): {
    compilations: number;
    executions: number;
    totalCompileTimeMs: number;
    totalExecTimeMs: number;
    tracerStats: ReturnType<typeof tracer.getStats>;
    deoptStats: ReturnType<Deoptimizer["getStats"]>;
    deprecatedMaps: number;
    migrations: ReturnType<typeof getMigrationStats>;
    microtasks: ReturnType<MicrotaskQueue["getStats"]>;
    gc: ReturnType<GenerationalGC["getStats"]>;
  } {
    return {
      compilations: this.compilationCount,
      executions: this.executionCount,
      totalCompileTimeMs: this.totalCompileTimeMs,
      totalExecTimeMs: this.totalExecTimeMs,
      tracerStats: tracer.getStats(),
      deoptStats: this.deoptimizer.getStats(),
      deprecatedMaps: this.hiddenClassRegistry.getDeprecatedMapCount(),
      migrations: getMigrationStats(),
      microtasks: this.microtaskQueue.getStats(),
      gc: this.gc.getStats(),
    };
  }

  reset(): void {
    this.dependencyRegistry.clear();
    this.functionCompilerExtensions = new WeakMap();
    this.hiddenClassRegistry.reset();
    this.valueHeap.resetHeapPayloads();
    this.compiledFunctionIdAllocator.reset();
    this.irNodeIdAllocator.reset();
    tracer.reset();
    this.microtaskQueue = new MicrotaskQueue({
      policy: this.microtaskQueue.policy,
    });
    this.wireUnhandledRejectionReporter();
    this.gc = new GenerationalGC({}, this.valueHeap);
    this.interpreter = this.runInRuntime(
      () => new RegisterInterpreter(this) as EngineInterpreter,
      false,
    );
    this.interpreter.debugger = this.debugger;
    this.installExtensionBuiltins();
    this.gc.bindRoots(
      this.interpreter,
      this.interpreter.globalCells,
      this.microtaskQueue,
    );
    this.deoptimizer = new Deoptimizer(this.interpreter);
    this.dependencyRegistry.bindLazyMarker(this.deoptimizer.lazyMarker);
    this.compilationCount = 0;
    this.executionCount = 0;
    this.totalCompileTimeMs = 0;
    this.totalExecTimeMs = 0;
  }

  setDebugger(debuggerHook: RuntimeDebugger | null): void {
    this.debugger = debuggerHook;
    this.interpreter.debugger = debuggerHook;
  }
}
