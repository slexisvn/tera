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
import { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";
import type { RegisterConstant } from "../bytecode/register/ops/bytecode.js";
import type { GlobalCell } from "../runtime/intrinsics/global-cells.js";
import { SpeculativeOptimizer } from "../optimizing/optimizer.js";
import { WasmCodegen } from "../optimizing/wasm/codegen.js";
import { BaselineCompiler } from "../optimizing/baseline/compiler.js";
import { Deoptimizer } from "../deopt/deoptimizer.js";
import { dependencyRegistry } from "../deopt/dependencies.js";
import { DEP_CALL_TARGET } from "../deopt/dependencies.js";
import type { Dependency } from "../deopt/dependencies.js";
import { tracer } from "../core/tracing/index.js";
import { getPayload, getTag, isPromise, toDisplayString, resetHeapPayloads } from "../core/value/index.js";
import type { HeapPayload } from "../core/value/index.js";
import type { TaggedValue } from "../core/value/index.js";
import {
  resetHiddenClasses,
  getDeprecatedMapCount,
} from "../objects/maps/hidden-class.js";
import { getMigrationStats } from "../objects/heap/js-object.js";
import { resetIRNodeIds } from "../optimizing/ir/index.js";
import { createTieringPolicy } from "../runtime/tiering/policy.js";
import type { TieringPolicyOptions } from "../runtime/tiering/policy.js";
import {
  MicrotaskQueue,
  MicrotaskPolicy,
  MicrotasksScope,
} from "../runtime/microtasks/microtask.js";
import type { MicrotaskPolicyValue } from "../runtime/microtasks/microtask.js";
import { GenerationalGC } from "../gc/gc.js";
import { bindGC } from "../objects/heap/factory.js";
import { bindHostAsync, taggedToNative } from "../runtime/domain/host.js";
import {
  checkSource,
  TypecheckError,
  type Diagnostic,
} from "../frontend/checker/index.js";

export type EngineOptions = {
  typecheck?: "off" | "warn" | "strict";
  output?: (text: string) => void;
  tieringPolicy?: TieringPolicyOptions;
  microtaskPolicy?: MicrotaskPolicyValue;
  gc?: ConstructorParameters<typeof GenerationalGC>[0];
  trace?: boolean;
  traceCategories?: Iterable<string>;
};

export type CompileOptions = {
  lazy?: boolean;
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

export class Engine {
  tieringPolicy: ReturnType<typeof createTieringPolicy>;
  microtaskQueue: MicrotaskQueue;
  gc: GenerationalGC;
  interpreter: EngineInterpreter;
  baselineCompiler: BaselineCompiler;
  optimizer: SpeculativeOptimizer;
  wasmCodegen: WasmCodegen;
  deoptimizer: Deoptimizer;
  compilationCount: number;
  executionCount: number;
  totalCompileTimeMs: number;
  totalExecTimeMs: number;
  typecheckMode: "off" | "warn" | "strict";
  output?: (text: string) => void;
  diagnostics: Diagnostic[];

  constructor(options: EngineOptions = {}) {
    this.typecheckMode = options.typecheck || "warn";
    this.output = options.output;
    this.diagnostics = [];
    this.tieringPolicy = createTieringPolicy(options.tieringPolicy);
    this.microtaskQueue = new MicrotaskQueue({
      policy: options.microtaskPolicy || MicrotaskPolicy.AUTO,
    });
    this.gc = new GenerationalGC(options.gc || {});
    bindGC(this.gc);
    this.interpreter = new RegisterInterpreter(this) as EngineInterpreter;
    this.gc.bindRoots(
      this.interpreter,
      this.interpreter.globalCells,
      this.microtaskQueue,
    );
    bindHostAsync({
      queue: this.microtaskQueue,
      drain: () => this.drainMicrotasks(),
      interpreter: this.interpreter,
    });
    this.baselineCompiler = new BaselineCompiler();
    this.optimizer = new SpeculativeOptimizer();
    this.wasmCodegen = new WasmCodegen();
    this.deoptimizer = new Deoptimizer(this.interpreter);
    dependencyRegistry.bindLazyMarker(this.deoptimizer.lazyMarker);
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

  compile(source: string, options: CompileOptions = {}): RegisterCompiledFunction {
    this.diagnostics = checkSource(source, this.typecheckMode);
    if (this.typecheckMode === "strict" && this.diagnostics.length > 0) {
      throw new TypecheckError(this.diagnostics);
    }
    const ast = analyzeEffects(parse(source));
    const compiler = new RegisterBytecodeCompiler();
    return compiler.compile(ast);
  }

  run(source: string): TaggedValue {
    this.executionCount++;
    const t0 = performance.now();

    const compiled = this.compile(source);
    const compileTime = performance.now() - t0;
    this.totalCompileTimeMs += compileTime;

    const t1 = performance.now();
    const scope = new MicrotasksScope(
      this.microtaskQueue,
      this.interpreter,
    );
    const result = this.interpreter.execute(compiled);
    scope.exit();
    const execTime = performance.now() - t1;
    this.totalExecTimeMs += execTime;

    tracer.perfMark(`Compile`, compileTime);
    tracer.perfMark(`Execute`, execTime);

    return result;
  }

  runValue(source: string): EngineValue {
    const raw = this.run(source);
    return { tag: getTag(raw), value: getPayload(raw) };
  }

  runNative(source: string): unknown {
    return this.toNativeResult(this.run(source));
  }

  private toNativeResult(value: TaggedValue): unknown {
    if (!isPromise(value)) return taggedToNative(value);
    this.drainMicrotasks();
    const promise = getPayload(value) as RuntimePromisePayload;
    if (promise.state === "fulfilled") return taggedToNative(promise.result);
    if (promise.state === "rejected") throw taggedToNative(promise.result);
    return new Promise((resolve, reject) => {
      promise.addReaction((state, result) => {
        try {
          if (state === "fulfilled") resolve(taggedToNative(result));
          else reject(taggedToNative(result));
        } catch (error) {
          reject(error);
        }
      });
      this.drainMicrotasks();
    });
  }

  executeValue(
    compiledFn: RegisterCompiledFunction,
    args: TaggedValue[] = [],
    thisValue: TaggedValue | null = null,
  ): EngineValue {
    const raw = this.interpreter.execute(compiledFn, args, thisValue);
    return { tag: getTag(raw), value: getPayload(raw) };
  }

  runMicrotasks(): boolean {
    return this.microtaskQueue.runOne(this.interpreter);
  }

  drainMicrotasks(): void {
    return this.microtaskQueue.drain(this.interpreter);
  }

  performMicrotaskCheckpoint(): void {
    return this.microtaskQueue.performCheckpoint(this.interpreter);
  }

  setMicrotaskPolicy(policy: MicrotaskPolicyValue): void {
    this.microtaskQueue.setPolicy(policy);
  }

  runWithDisassembly(source: string): TaggedValue {
    const compiled = this.compile(source);
    console.log(compiled.disassemble());

    for (const constant of compiled.constants) {
      if (isCompiledFunction(constant)) {
        console.log(constant.disassemble());
      }
    }

    const result = this.interpreter.execute(compiled);
    this.drainMicrotasks();
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

    const parser = new Parser(bodyTokens);
    const body = parser.parseBlock();

    const compiler = new RegisterBytecodeCompiler();
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
    }

    compiledFn.isLazy = false;
    compiledFn.version = oldVersion + 1;
    dependencyRegistry.invalidate(
      DEP_CALL_TARGET,
      compiledFn.id,
      oldVersion,
      "function-version-change",
    );
    compiledFn.lazySource = null;
    compiledFn.lazyBodyStart = null;
    compiledFn.lazyBodyEnd = null;
    compiledFn.lazyParams = null;
  }

  baselineCompile(compiledFn: RegisterCompiledFunction): void {
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

  optimizeFunction(compiledFn: RegisterCompiledFunction): void {
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
      const optimizerResult = this.optimizer.compile(compiledFn);
      const wasmFn = this.wasmCodegen.compile(optimizerResult, compiledFn);

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
        dependencyRegistry.register(
          compiledFn as Parameters<typeof dependencyRegistry.register>[0],
          ((optimizerResult.graph as { dependencies?: Dependency[] }).dependencies || []),
        );
        const elapsed = performance.now() - t0;
        tracer.jitCompile(
          functionName(compiledFn),
          `Wasm installed in ${elapsed.toFixed(2)}ms`,
        );
      } else {
        const wasmCodegen = this.wasmCodegen as WasmCodegen & {
          lastCompileRejection?: string | null;
          lastAnalysisFailure?: string | null;
        };
        compiledFn.compileFailureCount =
          (compiledFn.compileFailureCount || 0) + 1;
        compiledFn.lastCompileFailureReason =
          wasmCodegen.lastCompileRejection ||
          wasmCodegen.lastAnalysisFailure ||
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
          if (fn.optimizedCode._dispose) fn.optimizedCode._dispose();
          dependencyRegistry.unregister(fn as Parameters<typeof dependencyRegistry.unregister>[0]);
          fn.optimizedCode = null;
          fn.disableOptimization = false;
          updateCallMode(fn);
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
    this.gc.collectGarbage(type as Parameters<GenerationalGC["collectGarbage"]>[0]);
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
      deprecatedMaps: getDeprecatedMapCount(),
      migrations: getMigrationStats(),
      microtasks: this.microtaskQueue.getStats(),
      gc: this.gc.getStats(),
    };
  }

  reset(): void {
    dependencyRegistry.clear();
    resetHiddenClasses();
    resetHeapPayloads();
    RegisterCompiledFunction.nextId = 1;
    resetIRNodeIds();
    tracer.reset();
    this.microtaskQueue = new MicrotaskQueue({
      policy: this.microtaskQueue.policy,
    });
    this.gc = new GenerationalGC();
    bindGC(this.gc);
    this.interpreter = new RegisterInterpreter(this) as EngineInterpreter;
    this.gc.bindRoots(
      this.interpreter,
      this.interpreter.globalCells,
      this.microtaskQueue,
    );
    this.deoptimizer = new Deoptimizer(this.interpreter);
    dependencyRegistry.bindLazyMarker(this.deoptimizer.lazyMarker);
    this.compilationCount = 0;
    this.executionCount = 0;
    this.totalCompileTimeMs = 0;
    this.totalExecTimeMs = 0;
  }
}
