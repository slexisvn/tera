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
  withCompiledFunctionIdAllocator,
} from "../bytecode/register/ops/bytecode.js";
import type { RegisterConstant, OsrEntry } from "../bytecode/register/ops/bytecode.js";
import type { GlobalCell } from "../runtime/intrinsics/global-cells.js";
import { SpeculativeOptimizer } from "../optimizing/optimizer.js";
import { createBackendRegistry } from "../optimizing/backends/index.js";
import type { BackendRegistry } from "../optimizing/target/registry.js";
import { isJitBackend, type JitBackend } from "../optimizing/target/jit.js";
import { BaselineCompiler } from "../optimizing/baseline/compiler.js";
import { Deoptimizer } from "../deopt/deoptimizer.js";
import { DependencyRegistry, withDependencyRegistry } from "../deopt/dependencies.js";
import { DEP_CALL_TARGET } from "../deopt/dependencies.js";
import type { Dependency } from "../deopt/dependencies.js";
import { tracer } from "../core/tracing/index.js";
import { getPayload, getTag, isObject, isPromise, toDisplayString, ValueHeap, withValueHeap } from "../core/value/index.js";
import type { HeapPayload } from "../core/value/index.js";
import type { TaggedValue } from "../core/value/index.js";
import {
  HiddenClassRegistry,
  withHiddenClassRegistry,
} from "../objects/maps/hidden-class.js";
import { getMigrationStats } from "../objects/heap/js-object.js";
import { IRNodeIdAllocator, resetIRNodeIds, withIRNodeIdAllocator } from "../optimizing/ir/index.js";
import { createTieringPolicy } from "../runtime/tiering/policy.js";
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
import { installBuiltinEntries, isRuntimeFunctionPayload, type BuiltinRegistryMap } from "../runtime/builtins/index.js";
import {
  checkSource,
  TypecheckError,
  type Diagnostic,
  type BindOptions,
  type ExternalBuiltinSignature,
} from "../frontend/checker/index.js";
import type { ASTNode } from "../frontend/ast/index.js";
import type { SyntaxPlugin } from "../frontend/parser/extensions.js";
import type { RuntimeDebugger } from "../debugger/runtime.js";
import { mergeCompilerExtensions, mergeExtensionRecords, mergeNamedExtensionItems, resolveTeraExtensions, type NativeHostBuiltinRegistry, type TeraCompilerExtension, type TeraCompilerPhase, type TeraExtension } from "./extensions.js";

export type EngineOptions = {
  typecheck?: "off" | "warn" | "strict";
  output?: (text: string) => void;
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

export type CompileOptions = {
  lazy?: boolean;
  sourceName?: string | null;
  syntaxPlugins?: readonly SyntaxPlugin[];
  checkerBuiltins?: readonly ExternalBuiltinSignature[];
  checkerAliases?: BindOptions["aliases"];
  checkerInterfaces?: BindOptions["interfaces"];
  compiler?: TeraCompilerExtension;
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

function runtimeIntrinsicNames(compiler: Required<TeraCompilerExtension>): ReadonlySet<string> {
  return new Set(compiler.intrinsics.filter((intrinsic) => intrinsic.lowering === "runtime").map((intrinsic) => intrinsic.name));
}

function functionName(compiledFn: { name?: string | null }): string {
  return compiledFn.name || "<anonymous>";
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
  if (isObject(value) && getPayload(value).getProperty("message") !== undefined) {
    return describeThrown(value);
  }
  return `Uncaught ${toDisplayString(value)}`;
}

export class Engine {
  tieringPolicy: ReturnType<typeof createTieringPolicy>;
  microtaskQueue: MicrotaskQueue;
  gc: GenerationalGC;
  interpreter: EngineInterpreter;
  baselineCompiler: BaselineCompiler;
  optimizer: SpeculativeOptimizer;
  backends: BackendRegistry;
  jitBackend: JitBackend;
  deoptimizer: Deoptimizer;
  compilationCount: number;
  executionCount: number;
  totalCompileTimeMs: number;
  totalExecTimeMs: number;
  typecheckMode: "off" | "warn" | "strict";
  output?: (text: string) => void;
  diagnostics: Diagnostic[];
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
    this.typecheckMode = options.typecheck || "warn";
    this.output = options.output;
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
    this.interpreter.debugger = this.debugger;
    this.gc.bindRoots(
      this.interpreter,
      this.interpreter.globalCells,
      this.microtaskQueue,
    );
    this.baselineCompiler = new BaselineCompiler();
    this.optimizer = new SpeculativeOptimizer(this.compilerExtensions);
    this.backends = createBackendRegistry();
    const wasm = this.backends.resolve("wasm");
    if (!isJitBackend(wasm)) {
      throw new Error('Backend "wasm" is not a JIT backend');
    }
    this.jitBackend = wasm;
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
    }
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

  private compileInRuntime(source: string, options: CompileOptions = {}): RegisterCompiledFunction {
    const syntaxPlugins = this.compileSyntaxPlugins(options);
    const checker = this.compileChecker(options);
    const compilerExtensions = this.compileCompilerExtensions(options);
    this.diagnostics = checkSource(source, {
      mode: this.typecheckMode,
      syntaxPlugins,
      builtins: checker.builtins,
      aliases: checker.aliases,
      interfaces: checker.interfaces,
    });
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

  private reportCompiled(compiled: RegisterCompiledFunction): void {
    if (!this.onCompile) return;
    const seen = new Set<RegisterCompiledFunction>();
    const walk = (fn: RegisterCompiledFunction): void => {
      if (seen.has(fn) || fn.isLazy) return;
      seen.add(fn);
      this.onCompile!(fn);
      for (const constant of fn.constants) {
        if (isCompiledFunction(constant)) walk(constant);
      }
    };
    walk(compiled);
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

  private runSource(source: string, options: CompileOptions = {}): TaggedValue {
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
    if (promise.state === "rejected") throw taggedToNative(promise.result);
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
        const code = this.jitBackend.jitCompile({ result, compiledFn }).code;
        if (code) {
          entry = { code, slots: result.graph.osrParamSlots ?? [] };
          this.dependencyRegistry.registerOsr(compiledFn, result.graph.dependencies);
          tracer.jitOSR(functionName(compiledFn), offset);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      tracer.jitCompile(functionName(compiledFn), `OSR failed: ${message}`);
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
      const jitResult = this.jitBackend.jitCompile({
        result: optimizerResult,
        compiledFn,
      });
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
        compiledFn.compileFailureCount =
          (compiledFn.compileFailureCount || 0) + 1;
        compiledFn.lastCompileFailureReason =
          jitResult.rejection.compileRejection ||
          jitResult.rejection.analysisFailure ||
          "not-compilable";
        compiledFn.optimizationCooldownUntil =
          Date.now() + Math.min(5000, 250 * compiledFn.compileFailureCount);
        const policyHooks = policyWithCompileHooks(this.tieringPolicy);
        if (
          this.tieringPolicy &&
          typeof policyHooks.recordCompileFailure === "function"
        ) {
          policyHooks.recordCompileFailure(
            compiledFn,
            compiledFn.lastCompileFailureReason,
          );
        }
        tracer.jitCompile(
          functionName(compiledFn),
          "Wasm compilation skipped — cooldown",
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      compiledFn.compileFailureCount =
        (compiledFn.compileFailureCount || 0) + 1;
      compiledFn.lastCompileFailureReason = message;
      compiledFn.optimizationCooldownUntil =
        Date.now() + Math.min(5000, 250 * compiledFn.compileFailureCount);
      const policyHooks = policyWithCompileHooks(this.tieringPolicy);
      if (
        this.tieringPolicy &&
        typeof policyHooks.recordCompileFailure === "function"
      ) {
        policyHooks.recordCompileFailure(
          compiledFn,
          compiledFn.lastCompileFailureReason,
        );
      }
      tracer.jitCompile(functionName(compiledFn), `Compilation failed: ${message}`);
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
