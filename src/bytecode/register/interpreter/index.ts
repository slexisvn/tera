import * as bytecode from "../ops/bytecode.js";

import {
  mkSmi,
  mkDouble,
  mkBool,
  mkString,
  mkObject,
  mkFunction,
  mkArray,
  mkUndefined,
  mkNull,
  mkNumber,
  mkGenerator,
  mkRegex,
  isSmi,
  isDouble,
  isNumber,
  isString,
  isObject,
  isFunction,
  isArray,
  isUndefined,
  isNull,
  isBool,
  isPromise,
  isIterator,
  isSymbol,
  toNumber,
  toBool,
  toString,
  toPrimitive,
  abstractRelational,
  toDisplayString,
  typeOf,
  getPayload,
  getTag,
  JSFunction,
  abstractLooseEqual,
  isPrimitive,
  initWellKnownSymbols,
  wellKnownSymbols,
  areBothSmi,
  areBothNumber,
  smiPayload,
  SMI_MIN,
  SMI_MAX,
  sweepHeapPayloads,
  heapPayloadLiveBytesEstimate,
  type GeneratorPayload,
  type TaggedValue,
  type RuntimeFunctionPayload,
} from "../../../core/value/index.js";
import { markReachableHeapIds } from "../../../gc/roots.js";

import {
  createJSObject,
  createJSArray,
  createJSPrimitiveWrapper,
} from "../../../objects/heap/factory.js";
import type { JSObject } from "../../../objects/heap/js-object.js";
import {
  presizeInstanceSlots,
  recordConstruction,
} from "../../../objects/heap/js-object.js";
import { AccessorPair } from "../../../objects/heap/js-object.js";
import {
  INSTANCE_TYPE_STRING_WRAPPER,
  INSTANCE_TYPE_NUMBER_WRAPPER,
  INSTANCE_TYPE_BOOLEAN_WRAPPER,
} from "../../../objects/maps/hidden-class.js";
import { InlineCacheManager } from "../../../feedback/ic/index.js";
import {
  FeedbackVector,
  FeedbackSlot,
  FEEDBACK_PROPERTY,
  FEEDBACK_BINARY_OP,
  FEEDBACK_UNARY_OP,
  FEEDBACK_CALL,
} from "../../../feedback/vector/index.js";
import { tracer } from "../../../core/tracing/index.js";
import { builtins } from "../../../runtime/builtins/index.js";
import type { BuiltinRegistryEntry } from "../../../runtime/builtins/index.js";
import { Environment } from "../../../runtime/intrinsics/environment.js";
import { GlobalCellMap } from "../../../runtime/intrinsics/global-cells.js";
import { MicrotaskQueue } from "../../../runtime/microtasks/microtask.js";
import {
  mkPromiseCapability,
  PROMISE_FULFILLED,
  PROMISE_REJECTED,
} from "../../../runtime/async/promise.js";
import {
  getIterator,
  createIteratorResult,
  iteratorDone,
  iteratorValue,
} from "../../../runtime/iteration/iterator.js";
import {
  GeneratorObject,
  GeneratorSuspend,
  GEN_COMPLETED,
  GEN_EXECUTING,
  GEN_SUSPENDED,
} from "../../../runtime/iteration/generator.js";
import { createBuiltinPrototypes } from "../../../runtime/intrinsics/prototypes.js";
import { applyBinaryOverload, applyRelational, applyUnaryOverload } from "../../../runtime/operators.js";
import { forInKeys } from "../../../runtime/enumerate.js";
import { analyzeSimpleConstructor } from "../compiler/helpers.js";
import { dependencyRegistry } from "../../../deopt/dependencies.js";
import {
  VMTypeError,
  VMReferenceError,
  VMError,
  vmErrorToTagged,
} from "../../../core/errors/index.js";
import {
  runtimeOwnKeys,
  runtimeGetProperty,
  runtimeSetProperty,
  isJSProxyValue,
  runtimeApply,
  runtimeConstruct,
} from "../../../objects/exotic/proxy-ops.js";

import { RegisterFrame, throwIfTDZ } from "./frame.js";
import {
  requiresInterpreterOnly,
  getBinaryOperands,
  RegisterException,
  AsyncSuspend,
  runAsyncWithSuspension,
  resumeAfterSuspend,
  runGeneratorFrame,
} from "./helpers.js";
import {
  installPromiseBuiltin,
  exceptionToValue,
  promiseAll,
  promiseRace,
} from "./promise.js";
import {
  handleLdaProp,
  handleStaProp,
  handleLdaIndex,
  handleLdaKeyedSlice,
  handleStaIndex,
  handleNew,
  handleDefineAccessor,
  handleInstanceof,
  handleIn,
  handleDeleteProp,
} from "./handlers.js";

export { MAX_DEOPT_COUNT } from "./helpers.js";
export { RegisterFrame } from "./frame.js";

export const CALL_INTERPRETED = 0;
export const CALL_BASELINE = 1;
export const CALL_OPTIMIZED = 2;
export const CALL_NATIVE = 3;
export const CALL_GENERATOR = 4;
export const CALL_ASYNC = 5;

type CompiledFunctionLike = bytecode.RegisterCompiledFunction;
type FunctionPayloadLike = RuntimeFunctionPayload & {
  compiled?: bytecode.RegisterCompiledFunction | null;
  closure?: Environment | null;
};
type FeedbackSlotLike = FeedbackSlot | null | undefined;
type TieringPolicyLike = {
  baselineThreshold: number;
  jitThreshold: number;
  loopOsrThreshold: number;
  maxDeoptCount?: number;
  recordExecution?: (compiledFn: bytecode.RegisterCompiledFunction, elapsedMs: number) => void;
  recordDeopt?: (compiledFn: bytecode.RegisterCompiledFunction, reason: string) => void;
  shouldOptimize?: (compiledFn: bytecode.RegisterCompiledFunction) => boolean;
  shouldOSR?: (compiledFn: bytecode.RegisterCompiledFunction, loopCount: number) => boolean;
  recordLoopIterations?: (compiledFn: bytecode.RegisterCompiledFunction, loopCount: number) => void;
  notifyCompilationStart?: () => void;
  notifyCompilationEnd?: () => void;
};
type JitEngineLike = {
  microtaskQueue?: MicrotaskQueue;
  tieringPolicy?: TieringPolicyLike | null;
  osrEnabled?: boolean;
  output?: (text: string) => void;
  compileLazy?: (compiledFn: bytecode.RegisterCompiledFunction) => void;
  baselineCompile?: (compiledFn: bytecode.RegisterCompiledFunction) => void;
  optimizeFunction?: (compiledFn: bytecode.RegisterCompiledFunction) => void;
  compileOsr?: (
    compiledFn: bytecode.RegisterCompiledFunction,
    offset: number,
  ) => bytecode.OsrEntry | null;
  deoptimizer?: {
    lazyMarker: {
      hasPendingDeopt(compiledFn: bytecode.RegisterCompiledFunction): boolean;
      consumeDeopt(compiledFn: bytecode.RegisterCompiledFunction): {
        reason: string;
        dependency: object | null;
      } | undefined;
    };
  };
};
type InterpreterLike = RegisterInterpreter;
type RegexConstant = {
  pattern: string;
  flags: string;
};
type BuiltinNamespaceValue =
  | RuntimeFunctionPayload
  | string
  | number
  | boolean
  | null
  | undefined;
type BuiltinNamespace = Record<string, BuiltinNamespaceValue>;
type NamedRuntimeArg = {
  name: string;
  value: TaggedValue;
};

type ThrownValue =
  | RegisterException
  | VMError
  | Error
  | object
  | string
  | number
  | boolean
  | symbol
  | null
  | undefined;

function isRuntimeFunctionPayload(
  value: object | string | number | boolean | symbol | null | undefined,
): value is RuntimeFunctionPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (("call" in value && typeof value.call === "function") ||
      ("construct" in value && typeof value.construct === "function"))
  );
}

function hasGlobalConst(
  value: object | string | number | boolean | symbol | null | undefined,
): value is { globalConst: () => TaggedValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    "globalConst" in value &&
    typeof value.globalConst === "function"
  );
}

export function updateCallMode(compiled: CompiledFunctionLike): void {
  if (compiled.isGenerator) compiled.callMode = CALL_GENERATOR;
  else if (compiled.isAsync) compiled.callMode = CALL_ASYNC;
  else if (compiled.optimizedCode) compiled.callMode = CALL_OPTIMIZED;
  else if (compiled.baselineCode) compiled.callMode = CALL_BASELINE;
  else compiled.callMode = CALL_INTERPRETED;
}

function boxPrimitive(value: TaggedValue, interpreter: InterpreterLike): TaggedValue {
  if (isString(value)) {
    const wrapper = createJSPrimitiveWrapper(INSTANCE_TYPE_STRING_WRAPPER, value);
    if (interpreter.builtinPrototypes.stringPrototype)
      wrapper.setPrototype(interpreter.builtinPrototypes.stringPrototype);
    return mkObject(wrapper);
  }
  if (isSmi(value) || isDouble(value)) {
    const wrapper = createJSPrimitiveWrapper(INSTANCE_TYPE_NUMBER_WRAPPER, value);
    if (interpreter.builtinPrototypes.numberPrototype)
      wrapper.setPrototype(interpreter.builtinPrototypes.numberPrototype);
    return mkObject(wrapper);
  }
  if (isBool(value)) {
    const wrapper = createJSPrimitiveWrapper(INSTANCE_TYPE_BOOLEAN_WRAPPER, value);
    if (interpreter.builtinPrototypes.booleanPrototype)
      wrapper.setPrototype(interpreter.builtinPrototypes.booleanPrototype);
    return mkObject(wrapper);
  }
  return value;
}

function namedOptionsObject(named: NamedRuntimeArg[]): TaggedValue {
  const obj = createJSObject();
  for (const arg of named) obj.setProperty(arg.name, arg.value);
  return mkObject(obj);
}

function bindNamedArgs(
  compiled: bytecode.RegisterCompiledFunction,
  positional: TaggedValue[],
  named: NamedRuntimeArg[],
): TaggedValue[] {
  if (named.length === 0) return positional;
  const names = compiled.paramNames || [];
  const result = positional.slice();
  const bound = new Set<number>();
  for (let i = 0; i < positional.length; i++) bound.add(i);
  const indexByName = new Map<string, number>();
  for (let i = 0; i < names.length; i++) indexByName.set(names[i]!, i);
  for (const arg of named) {
    const index = indexByName.get(arg.name);
    if (index === undefined) {
      throw new VMTypeError(`Unknown named argument '${arg.name}'`);
    }
    if (bound.has(index)) {
      throw new VMTypeError(`Argument '${arg.name}' was passed more than once`);
    }
    result[index] = arg.value;
    bound.add(index);
  }
  return result;
}

function recordCallFeedback(
  slot: FeedbackSlotLike,
  fn: FunctionPayloadLike,
  args: TaggedValue[],
  thisValue: TaggedValue,
): void {
  if (!slot || slot.isStable) return;
  const receiverMapId =
    thisValue && isObject(thisValue)
      ? getPayload(thisValue).hiddenClass.id
      : null;
  const receiverMapVersion =
    thisValue && isObject(thisValue)
      ? getPayload(thisValue).hiddenClass.version
      : null;
  slot.recordCallTarget(
    fn.name || "<anonymous>",
    fn.compiled || null,
    args.length,
    receiverMapId,
    receiverMapVersion,
  );
}

function recordReturnFeedback(slot: FeedbackSlotLike, result: TaggedValue): void {
  if (slot && !slot.isStable && result) slot.recordReturnType(getTag(result));
}

function currentBaselineCode(
  compiled: bytecode.RegisterCompiledFunction,
): bytecode.BaselineCode | null {
  return compiled.baselineCode;
}

function numericOperand(value: bytecode.RegisterOperand): number | null {
  return typeof value === "number" ? value : null;
}

function constantString(
  compiledFn: bytecode.RegisterCompiledFunction,
  index: number,
  context: string,
): string {
  const value = compiledFn.constants[index];
  if (typeof value !== "string") {
    throw new Error(`${context}: expected string constant at ${index}`);
  }
  return value;
}

function constantRuntimeValue(
  compiledFn: bytecode.RegisterCompiledFunction,
  index: number,
): bytecode.RegisterConstant {
  return compiledFn.constants[index];
}

function constantNumber(
  compiledFn: bytecode.RegisterCompiledFunction,
  index: number,
  context: string,
): number {
  const value = compiledFn.constants[index];
  if (typeof value !== "number") {
    throw new Error(`${context}: expected number constant at ${index}`);
  }
  return value;
}

function constantStringList(
  compiledFn: bytecode.RegisterCompiledFunction,
  index: number,
  context: string,
): string[] {
  const value = compiledFn.constants[index];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${context}: expected string-list constant at ${index}`);
  }
  return value as unknown as string[];
}

function constantCompiledFunction(
  compiledFn: bytecode.RegisterCompiledFunction,
  index: number,
  context: string,
): bytecode.RegisterCompiledFunction {
  const value = compiledFn.constants[index];
  if (!(value instanceof bytecode.RegisterCompiledFunction)) {
    throw new Error(`${context}: expected compiled function constant at ${index}`);
  }
  return value;
}

function constantRegex(
  compiledFn: bytecode.RegisterCompiledFunction,
  index: number,
): RegexConstant {
  const value = compiledFn.constants[index];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("pattern" in value) ||
    !("flags" in value) ||
    typeof value.pattern !== "string" ||
    typeof value.flags !== "string"
  ) {
    throw new Error(`NewRegExp: expected regex constant at ${index}`);
  }
  return { pattern: value.pattern, flags: value.flags };
}

function requireArrayPayload(frame: RegisterFrame, register: number, context: string) {
  const value = frame.getReg(register);
  if (!isArray(value)) {
    throw new VMTypeError(`${context}: expected array register`);
  }
  return getPayload(value);
}

function requireObjectPayload(frame: RegisterFrame, register: number, context: string) {
  const value = frame.getReg(register);
  if (!isObject(value)) {
    throw new VMTypeError(`${context}: expected object register`);
  }
  return getPayload(value);
}

function requireIteratorPayload(value: TaggedValue, context: string) {
  if (!isIterator(value)) {
    throw new VMTypeError(`${context}: expected iterator`);
  }
  return getPayload(value);
}

function takeCatchPC(frame: RegisterFrame): number | null {
  const handler = frame.exceptionHandlers?.pop();
  return handler?.catchPC ?? null;
}

function interpretCall(
  compiled: CompiledFunctionLike,
  fn: FunctionPayloadLike,
  callee: TaggedValue,
  args: TaggedValue[],
  thisValue: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue {
  const closureEnv = fn.closure || null;
  const callFrame = new RegisterFrame(compiled, args, thisValue, closureEnv);
  if (compiled.selfBindingSlot !== undefined) {
    callFrame.setReg(compiled.selfBindingSlot, callee);
  }
  if (!compiled.feedbackVector) interpreter.initFeedbackVector(compiled);
  return interpreter.runFrame(callFrame);
}

function tryTierUp(
  compiled: CompiledFunctionLike,
  fn: FunctionPayloadLike,
  callee: TaggedValue,
  args: TaggedValue[],
  thisValue: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue | null {
  const policy = interpreter.tieringPolicy;
  const engine = interpreter.jitEngine;
  if (!engine || !policy || fn.closure) return null;

  if (typeof policy.recordExecution === "function") {
    policy.recordExecution(compiled, 0);
  }

  const shouldJIT = policy.shouldOptimize
    ? policy.shouldOptimize(compiled)
    : compiled.invocationCount >= policy.jitThreshold &&
      !compiled.optimizedCode &&
      !compiled.disableOptimization &&
      Date.now() >= (compiled.optimizationCooldownUntil || 0);

  if (shouldJIT && !requiresInterpreterOnly(compiled) && typeof engine.optimizeFunction === "function") {
    if (policy.shouldOptimize) policy.notifyCompilationStart?.();
    engine.optimizeFunction(compiled);
    if (policy.shouldOptimize) policy.notifyCompilationEnd?.();
    if (compiled.optimizedCode) {
      updateCallMode(compiled);
      return compiled.optimizedCode(args, thisValue, interpreter);
    }
  }

  if (
    compiled.invocationCount >= policy.baselineThreshold &&
    !compiled.baselineCode &&
    !compiled.optimizedCode &&
    !requiresInterpreterOnly(compiled) &&
    typeof engine.baselineCompile === "function"
  ) {
    engine.baselineCompile(compiled);
    const baselineCode = currentBaselineCode(compiled);
    if (baselineCode) {
      updateCallMode(compiled);
      return baselineCode(args, thisValue, interpreter);
    }
  }

  return null;
}

function callFunction(
  callee: TaggedValue,
  args: TaggedValue[],
  thisValue: TaggedValue,
  slot: FeedbackSlotLike,
  interpreter: InterpreterLike,
  frame?: RegisterFrame,
): TaggedValue {
  if (!isFunction(callee)) {
    if (isJSProxyValue(callee)) {
      return runtimeApply(callee, thisValue, args, interpreter);
    }
    if (isObject(callee)) {
      const forward = runtimeGetProperty(callee, "forward", interpreter);
      if (isFunction(forward)) return callFunction(forward, args, callee, slot, interpreter, frame);
    }
    throw new VMTypeError(`${toDisplayString(callee)} is not a function`);
  }
  const fn = getPayload(callee);
  if (fn.compiled && !fn.compiled.isStrict && isPrimitive(thisValue) && !isNull(thisValue) && !isUndefined(thisValue)) {
    thisValue = boxPrimitive(thisValue, interpreter);
  }

  recordCallFeedback(slot, fn, args, thisValue);

  if (fn.call) {
    const result = fn.call(args, thisValue, interpreter);
    recordReturnFeedback(slot, result);
    return result;
  }

  if (fn.construct) {
    const result = fn.construct(args, interpreter);
    recordReturnFeedback(slot, result);
    return result;
  }

  if (fn.compiled && (fn.prototypeObj || fn.compiled.simpleConstructorInfo || fn.constructorOf) && isUndefined(thisValue)) {
    const result = interpreter.constructFunctionValue(callee, args);
    recordReturnFeedback(slot, result);
    return result;
  }

  if (!fn.compiled) {
    throw new Error(`Cannot call function: ${fn.name || "unknown"}`);
  }

  const compiled = fn.compiled;
  compiled.invocationCount = (compiled.invocationCount || 0) + 1;

  if (compiled.isLazy && interpreter.jitEngine && typeof interpreter.jitEngine.compileLazy === "function") {
    interpreter.jitEngine.compileLazy(compiled);
  }

  if (compiled.callMode === undefined) updateCallMode(compiled);

  if (compiled.callMode === CALL_OPTIMIZED) {
    if (compiled.optimizedCode) {
      const result = compiled.optimizedCode(args, thisValue, interpreter);
      recordReturnFeedback(slot, result);
      return result;
    }
    updateCallMode(compiled);
  }

  if (compiled.callMode === CALL_GENERATOR) {
    const genFrame = new RegisterFrame(compiled, args, thisValue, fn.closure);
    if (!compiled.feedbackVector) interpreter.initFeedbackVector(compiled);
    const gen = new GeneratorObject(genFrame, interpreter);
    const result = mkGenerator(gen);
    recordReturnFeedback(slot, result);
    return result;
  }

  if (compiled.callMode === CALL_ASYNC) {
    const { capability, value } = mkPromiseCapability(interpreter.microtaskQueue);
    const asyncFrame = new RegisterFrame(compiled, args, thisValue, fn.closure);
    if (!compiled.feedbackVector) interpreter.initFeedbackVector(compiled);
    runAsyncWithSuspension(interpreter, asyncFrame, capability);
    recordReturnFeedback(slot, value);
    return value;
  }

  {
    const tierResult = tryTierUp(compiled, fn, callee, args, thisValue, interpreter);
    if (tierResult !== null) {
      recordReturnFeedback(slot, tierResult);
      return tierResult;
    }
    if (compiled.baselineCode) {
      const result = compiled.baselineCode(args, thisValue, interpreter);
      recordReturnFeedback(slot, result);
      return result;
    }
    const result = interpretCall(compiled, fn, callee, args, thisValue, interpreter);
    recordReturnFeedback(slot, result);
    return result;
  }
}

export class RegisterInterpreter {
  jitEngine: JitEngineLike | null;
  globalCells: GlobalCellMap;
  callStack: string[];
  activeFrames: RegisterFrame[];
  _sweepTick: number;
  _heapSweepThreshold: number;
  icManager: InlineCacheManager;
  microtaskQueue: MicrotaskQueue;
  builtinPrototypes: Record<string, JSObject>;

  constructor(jitEngine: JitEngineLike | null) {
    this.jitEngine = jitEngine;
    this.globalCells = new GlobalCellMap();
    this.callStack = [];
    this.activeFrames = [];
    this._sweepTick = 0;
    this._heapSweepThreshold = 1 << 18;
    this.icManager = new InlineCacheManager();
    this.microtaskQueue =
      jitEngine && jitEngine.microtaskQueue
        ? jitEngine.microtaskQueue
        : new MicrotaskQueue();

    for (const [name, builtin] of Object.entries(builtins)) {
      if (hasGlobalConst(builtin)) {
        this.globalCells.write(name, builtin.globalConst());
      } else if (isRuntimeFunctionPayload(builtin)) {
        const fnProperties: Record<string, TaggedValue> = {};
        const fn: RuntimeFunctionPayload = { ...builtin, properties: fnProperties };
        for (const [k, v] of Object.entries(builtin)) {
          if (k === "call" || k === "construct" || k === "name") continue;
          if (isRuntimeFunctionPayload(v)) {
            fnProperties[k] = mkFunction(v);
          } else if (typeof v === "number") {
            fnProperties[k] = mkNumber(v);
          }
        }
        this.globalCells.write(name, mkFunction(fn));
      } else if (typeof builtin === "object" && builtin !== null) {
        const nsProperties: Record<string, TaggedValue> = {};
        const ns: RuntimeFunctionPayload = { name, properties: nsProperties };
        const namespace = builtin as BuiltinNamespace;
        for (const [methodName, method] of Object.entries(namespace)) {
          if (methodName === "name") continue;
          if (isRuntimeFunctionPayload(method)) {
            nsProperties[methodName] = mkFunction(method);
          } else if (typeof method === "number" && Number.isFinite(method)) {
            nsProperties[methodName] = mkDouble(method);
          }
        }
        this.globalCells.write(name, mkFunction(ns));
      }
    }
    installPromiseBuiltin(this);
    this._wireWellKnownSymbols();
    this.builtinPrototypes = createBuiltinPrototypes();
    this._wirePrototypes();
  }

  _wireWellKnownSymbols() {
    initWellKnownSymbols();
    const symCell = this.globalCells.read("Symbol");
    if (symCell && isFunction(symCell)) {
      const symFn = getPayload(symCell);
      if (!symFn.properties) symFn.properties = {};
      symFn.properties["iterator"] = wellKnownSymbols.iterator;
      symFn.properties["hasInstance"] = wellKnownSymbols.hasInstance;
      symFn.properties["toPrimitive"] = wellKnownSymbols.toPrimitive;
      symFn.properties["toStringTag"] = wellKnownSymbols.toStringTag;
    }
  }

  _wirePrototypes() {
    const protoMap = {
      String: this.builtinPrototypes.stringPrototype,
      Array: this.builtinPrototypes.arrayPrototype,
      Number: this.builtinPrototypes.numberPrototype,
      Boolean: this.builtinPrototypes.booleanPrototype,
      RegExp: this.builtinPrototypes.regexPrototype,
      Map: this.builtinPrototypes.mapPrototype,
      Set: this.builtinPrototypes.setPrototype,
      WeakMap: this.builtinPrototypes.weakMapPrototype,
    };
    for (const [name, proto] of Object.entries(protoMap)) {
      const cell = this.globalCells.read(name);
      if (cell && isFunction(cell)) {
        getPayload(cell).prototypeObj = proto;
      }
    }
  }

  _lookupBuiltinPrototype(proto: JSObject, propName: string): TaggedValue {
    const val = proto.getProperty(propName);
    if (val !== undefined) return val;
    const chain = proto.lookupPrototypeChain(propName);
    return chain.found &&
      chain.value !== undefined &&
      !(typeof chain.value === "object" && chain.value instanceof AccessorPair)
      ? chain.value
      : mkUndefined();
  }

  exceptionToValue(e: object | string | number | boolean | symbol | null | undefined): TaggedValue {
    return exceptionToValue(e);
  }

  promiseAll(iterable: RuntimeValue): TaggedValue {
    return promiseAll(this, iterable as TaggedValue);
  }

  promiseRace(iterable: RuntimeValue): TaggedValue {
    return promiseRace(this, iterable as TaggedValue);
  }

  get tieringPolicy() {
    return this.jitEngine ? this.jitEngine.tieringPolicy : null;
  }

  wrapConstant(val: bytecode.RegisterConstant): TaggedValue {
    if (val instanceof bytecode.RegisterCompiledFunction)
      return mkFunction(new JSFunction(val, val.name ?? undefined));
    if (typeof val === "number") return mkNumber(val);
    if (typeof val === "string") return mkString(val);
    if (typeof val === "boolean") return mkBool(val);
    if (val === null) return mkNull();
    if (val === undefined) return mkUndefined();
    return mkUndefined();
  }

  initFeedbackVector(compiledFn: bytecode.RegisterCompiledFunction): void {
    if (compiledFn.feedbackVector) return;

    const fv = FeedbackVector.fromCompiledFunction(compiledFn);

    for (const instr of compiledFn.instructions) {
      const op = instr.opcode;
      const operands = instr.operands;

      switch (op) {
        case bytecode.ROP_LDA_PROP:
        case bytecode.ROP_STA_PROP:
          {
            const slotIndex = operands.length >= 3 ? numericOperand(operands[2]) : null;
            if (slotIndex !== null && slotIndex < fv.slots.length) {
              fv.initSlot(slotIndex, FEEDBACK_PROPERTY);
            }
          }
          break;

        case bytecode.ROP_LDA_INDEX:
        case bytecode.ROP_STA_INDEX:
          {
            const fbIdx = operands[operands.length - 1];
            if (fbIdx !== undefined && typeof fbIdx === "number" && fbIdx < fv.slots.length) {
              fv.initSlot(fbIdx, FEEDBACK_PROPERTY);
            }
          }
          break;

        case bytecode.ROP_ADD:
        case bytecode.ROP_SUB:
        case bytecode.ROP_MUL:
        case bytecode.ROP_DIV:
        case bytecode.ROP_MOD:
        case bytecode.ROP_EQ:
        case bytecode.ROP_NEQ:
        case bytecode.ROP_LT:
        case bytecode.ROP_GT:
        case bytecode.ROP_LTE:
        case bytecode.ROP_GTE:
        case bytecode.ROP_LOOSE_EQ:
        case bytecode.ROP_LOOSE_NEQ:
        case bytecode.ROP_BITAND:
        case bytecode.ROP_BITOR:
        case bytecode.ROP_BITXOR:
        case bytecode.ROP_SHL:
        case bytecode.ROP_SHR:
        case bytecode.ROP_USHR:
        case bytecode.ROP_POW:
        case bytecode.ROP_INSTANCEOF:
        case bytecode.ROP_IN:
          {
            const slotIndex = operands.length >= 2 ? numericOperand(operands[1]) : null;
            if (slotIndex !== null && slotIndex < fv.slots.length) {
              fv.initSlot(slotIndex, FEEDBACK_BINARY_OP);
            }
          }
          break;

        case bytecode.ROP_NOT:
        case bytecode.ROP_NEG:
        case bytecode.ROP_BITNOT:
          {
            const slotIndex = operands.length >= 1 ? numericOperand(operands[0]) : null;
            if (slotIndex !== null && slotIndex < fv.slots.length) {
              fv.initSlot(slotIndex, FEEDBACK_UNARY_OP);
            }
          }
          break;

        case bytecode.ROP_CALL:
          {
            const slotIndex = operands.length >= 4 ? numericOperand(operands[3]) : null;
            if (slotIndex !== null && slotIndex < fv.slots.length) {
              fv.initSlot(slotIndex, FEEDBACK_CALL);
            }
          }
          break;

        case bytecode.ROP_CALL_METHOD:
          {
            const slotIndex = operands.length >= 4 ? numericOperand(operands[3]) : null;
            if (slotIndex !== null && slotIndex < fv.slots.length) {
              fv.initSlot(slotIndex, FEEDBACK_CALL);
            }
          }
          break;
      }
    }

    compiledFn.feedbackVector = fv;
  }

  execute(
    compiledFn: bytecode.RegisterCompiledFunction,
    args: TaggedValue[] = [],
    thisValue: TaggedValue | null = null,
  ): TaggedValue {
    const executionStart = performance.now();
    const finishExecution = (value: TaggedValue) => {
      if (
        this.tieringPolicy &&
        typeof this.tieringPolicy.recordExecution === "function"
      ) {
        this.tieringPolicy.recordExecution(
          compiledFn,
          performance.now() - executionStart,
        );
      }
      return value;
    };
    compiledFn.lastExecutionTime = Date.now();
    compiledFn.codeAge = 0;

    if (compiledFn.hoistedVarNames) {
      for (const name of compiledFn.hoistedVarNames) {
        if (!this.globalCells.has(name)) {
          this.globalCells.write(name, mkUndefined());
        }
      }
    }

    if (
      compiledFn.isLazy &&
      this.jitEngine &&
      typeof this.jitEngine.compileLazy === "function"
    ) {
      this.jitEngine.compileLazy(compiledFn);
    }

    this.consumePendingLazyDeopt(compiledFn, -1, "at function entry");

    if (compiledFn.optimizedCode && !compiledFn.disableOptimization) {
      return finishExecution(
        compiledFn.optimizedCode(args, thisValue ?? mkUndefined(), this),
      );
    }

    compiledFn.invocationCount = (compiledFn.invocationCount || 0) + 1;

    this.initFeedbackVector(compiledFn);

    if (this.jitEngine && this.tieringPolicy) {
      const loopBudgetTriggered =
        compiledFn.feedbackVector &&
        compiledFn.feedbackVector.loopBudgetExhausted;

      const shouldJIT = this.tieringPolicy.shouldOptimize
        ? this.tieringPolicy.shouldOptimize(compiledFn)
        : (compiledFn.invocationCount >= this.tieringPolicy.jitThreshold ||
            loopBudgetTriggered) &&
          !compiledFn.optimizedCode &&
          !compiledFn.disableOptimization &&
          Date.now() >= (compiledFn.optimizationCooldownUntil || 0);

      if (
        shouldJIT &&
        !requiresInterpreterOnly(compiledFn) &&
        typeof this.jitEngine.optimizeFunction === "function"
      ) {
        const reason = loopBudgetTriggered
          ? `loop budget exhausted (invocations=${compiledFn.invocationCount})`
          : `invocation count = ${compiledFn.invocationCount}`;
        tracer.jitCompile(compiledFn.name || "<anonymous>", reason);
        if (loopBudgetTriggered && compiledFn.feedbackVector) {
          compiledFn.feedbackVector.resetLoopBudget();
        }
        if (this.tieringPolicy.shouldOptimize)
          this.tieringPolicy.notifyCompilationStart?.();
        this.jitEngine.optimizeFunction(compiledFn);
        if (this.tieringPolicy.shouldOptimize)
          this.tieringPolicy.notifyCompilationEnd?.();
        if (compiledFn.optimizedCode) {
          return finishExecution(
            compiledFn.optimizedCode(args, thisValue ?? mkUndefined(), this),
          );
        }
      }

      if (compiledFn.baselineCode) {
        return finishExecution(
          compiledFn.baselineCode(args, thisValue ?? mkUndefined(), this),
        );
      }

      if (
        compiledFn.invocationCount >= this.tieringPolicy.baselineThreshold &&
        !requiresInterpreterOnly(compiledFn) &&
        !compiledFn.baselineCode &&
        !compiledFn.optimizedCode &&
        typeof this.jitEngine.baselineCompile === "function"
      ) {
        this.jitEngine.baselineCompile(compiledFn);
        const baselineCode = currentBaselineCode(compiledFn);
        if (baselineCode) {
          return finishExecution(
            baselineCode(args, thisValue ?? mkUndefined(), this),
          );
        }
      }
    }

    if (compiledFn.isGenerator) {
      const frame = new RegisterFrame(
        compiledFn,
        args,
        (thisValue === undefined ? mkUndefined() : thisValue),
        null,
      );
      const gen = new GeneratorObject(frame, this);
      return finishExecution(mkGenerator(gen));
    }

    if (compiledFn.isAsync) {
      const { capability, value } = mkPromiseCapability(this.microtaskQueue);
      const frame = new RegisterFrame(
        compiledFn,
        args,
        (thisValue === undefined ? mkUndefined() : thisValue),
        null,
      );
      runAsyncWithSuspension(this, frame, capability);
      return finishExecution(value);
    }

    const frame = new RegisterFrame(
      compiledFn,
      args,
      (thisValue === undefined ? mkUndefined() : thisValue),
      null,
    );
    frame.suspendable = true;
    try {
      return finishExecution(this.runFrame(frame));
    } catch (e) {
      if (!(e instanceof AsyncSuspend)) throw e;
      const { capability, value } = mkPromiseCapability(this.microtaskQueue);
      resumeAfterSuspend(this, e, capability);
      return finishExecution(value);
    }
  }

  consumePendingLazyDeopt(
    compiledFn: bytecode.RegisterCompiledFunction,
    bytecodeOffset: number,
    label: string,
  ): boolean {
    if (
      !this.jitEngine ||
      !this.jitEngine.deoptimizer ||
      !this.jitEngine.deoptimizer.lazyMarker.hasPendingDeopt(compiledFn)
    ) {
      return false;
    }
    const deoptInfo =
      this.jitEngine.deoptimizer.lazyMarker.consumeDeopt(compiledFn);
    if (!deoptInfo) return false;
    dependencyRegistry.unregister(compiledFn);
    compiledFn.optimizedCode = null;
    if (deoptInfo && deoptInfo.dependency) {
      compiledFn.dependencyDeoptCount =
        (compiledFn.dependencyDeoptCount || 0) + 1;
    } else {
      compiledFn.deoptCount = (compiledFn.deoptCount || 0) + 1;
    }
    tracer.jitDeopt(
      compiledFn.name || "<anonymous>",
      `Lazy deopt ${label}: ${deoptInfo.reason}`,
      bytecodeOffset,
    );
    return true;
  }

  generatorNext(gen: GeneratorPayload, sendValue: TaggedValue): TaggedValue {
    if (gen.state === GEN_COMPLETED) {
      return createIteratorResult(mkUndefined(), true);
    }
    if (gen.state === GEN_EXECUTING) {
      throw new VMTypeError("Generator is already executing");
    }
    if (gen.state === GEN_SUSPENDED) {
      gen.frame.acc = sendValue;
    }
    return runGeneratorFrame(this, gen);
  }

  resumeAt(frame: RegisterFrame): TaggedValue {
    this.initFeedbackVector(frame.compiledFn);
    return this.runFrame(frame);
  }

  callFunctionValue(
    callee: TaggedValue,
    args: TaggedValue[] = [],
    thisValue: TaggedValue = mkUndefined(),
  ): TaggedValue {
    if (!isFunction(callee)) {
      if (isJSProxyValue(callee)) {
        return runtimeApply(callee, thisValue, args, this);
      }
      if (isObject(callee)) {
        const forward = runtimeGetProperty(callee, "forward", this);
        if (isFunction(forward)) return this.callFunctionValue(forward, args, callee);
      }
      throw new VMTypeError(`${toDisplayString(callee)} is not a function`);
    }
    const fn = getPayload(callee);
    if (fn.call) return fn.call(args, thisValue, this);
    if (fn.construct) return fn.construct(args, this);
    if (fn.compiled && (fn.prototypeObj || fn.compiled.simpleConstructorInfo || fn.constructorOf) && isUndefined(thisValue)) {
      return this.constructFunctionValue(callee, args);
    }
    if (fn.compiled) {
      if (fn.compiled.isGenerator) {
        const frame = new RegisterFrame(
          fn.compiled,
          args,
          thisValue,
          fn.closure || null,
        );
        this.initFeedbackVector(fn.compiled);
        return mkGenerator(new GeneratorObject(frame, this));
      }
      if (fn.compiled.isAsync) {
        const { capability, value } = mkPromiseCapability(this.microtaskQueue);
        const asyncFrame = new RegisterFrame(
          fn.compiled,
          args,
          thisValue,
          fn.closure || null,
        );
        this.initFeedbackVector(fn.compiled);
        runAsyncWithSuspension(this, asyncFrame, capability);
        return value;
      }
      if (fn.closure) {
        const closureFrame = new RegisterFrame(
          fn.compiled,
          args,
          thisValue,
          fn.closure,
        );
        this.initFeedbackVector(fn.compiled);
        return this.runFrame(closureFrame);
      }
      return this.execute(fn.compiled, args, thisValue);
    }
    throw new Error(`Cannot call function: ${fn.name || "unknown"}`);
  }

  callFunctionValueNamed(
    callee: TaggedValue,
    args: TaggedValue[] = [],
    named: NamedRuntimeArg[] = [],
    thisValue: TaggedValue = mkUndefined(),
  ): TaggedValue {
    if (!isFunction(callee)) {
      if (isJSProxyValue(callee)) {
        return runtimeApply(callee, thisValue, named.length > 0 ? [...args, namedOptionsObject(named)] : args, this);
      }
      if (isObject(callee)) {
        const forward = runtimeGetProperty(callee, "forward", this);
        if (isFunction(forward)) return this.callFunctionValueNamed(forward, args, named, callee);
      }
      throw new VMTypeError(`${toDisplayString(callee)} is not a function`);
    }
    const fn = getPayload(callee);
    if (fn.compiled) return this.callFunctionValue(callee, bindNamedArgs(fn.compiled, args, named), thisValue);
    const nextArgs = named.length > 0 ? [...args, namedOptionsObject(named)] : args;
    if (fn.call) return fn.call(nextArgs, thisValue, this);
    if (fn.construct) return fn.construct(nextArgs, this);
    throw new Error(`Cannot call function: ${fn.name || "unknown"}`);
  }

  toPrimitiveValue(v: TaggedValue, hint = "default"): TaggedValue {
    if (!isObject(v) && !isArray(v)) return v;
    const obj = isObject(v) ? getPayload(v) : null;
    if (obj && obj._primitiveValue !== undefined) return obj._primitiveValue;
    const order =
      hint === "string"
        ? ["toString", "valueOf"]
        : ["valueOf", "toString"];
    for (const methodName of order) {
      let method;
      try {
        method = runtimeGetProperty(v, methodName, this);
      } catch (e) {
        method = undefined;
      }
      if (method && isFunction(method)) {
        const result = this.callFunctionValue(method, [], v);
        if (!isObject(result) && !isArray(result)) return result;
      }
    }
    return toPrimitive(v, hint);
  }

  toNumberValue(v: TaggedValue): number {
    if (isObject(v) || isArray(v)) return toNumber(this.toPrimitiveValue(v, "number"));
    return toNumber(v);
  }

  constructFunctionValue(callee: TaggedValue, args: TaggedValue[] = []): TaggedValue {
    if (isFunction(callee)) {
      const payload = getPayload(callee);
      if (payload.construct) {
        return payload.construct(args, this);
      }
    }
    if (isJSProxyValue(callee)) {
      return runtimeConstruct(callee, args, this);
    }
    if (!isFunction(callee)) {
      throw new VMTypeError(`${toDisplayString(callee)} is not a constructor`);
    }
    const fn = getPayload(callee);
    const compiled = fn.compiled;
    if (!compiled) {
      throw new VMTypeError(`${toDisplayString(callee)} is not a constructor`);
    }
    this.initFeedbackVector(compiled);
    const stub = !fn.closure ? this.getConstructorStub(compiled, fn) : null;
    if (stub) return stub(args);
    const newObj = createJSObject();
    if (!fn.prototypeObj) {
      fn.prototypeObj = createJSObject();
      fn.prototypeObj.constructorRef = fn;
    }
    newObj.setPrototype(fn.prototypeObj);
    presizeInstanceSlots(newObj, fn);
    const thisVal = mkObject(newObj);
    const returnVal = this.callFunctionValue(callee, args, thisVal);
    recordConstruction(fn, newObj);
    return isObject(returnVal) ? returnVal : thisVal;
  }

  getConstructorStub(
    compiledFn: bytecode.RegisterCompiledFunction,
    fn: RuntimeFunctionPayload,
  ): ((args: TaggedValue[]) => TaggedValue) | null {
    if (compiledFn.constructorStub !== undefined)
      return compiledFn.constructorStub;
    const info = analyzeSimpleConstructor(compiledFn);
    if (!info) {
      compiledFn.constructorStub = null;
      return null;
    }
    const shapeObj = createJSObject();
    if (fn) {
      if (!fn.prototypeObj) {
        fn.prototypeObj = createJSObject();
        fn.prototypeObj.constructorRef = fn;
      }
      shapeObj.setPrototype(fn.prototypeObj);
    }
    for (const field of info) shapeObj.setProperty(field.name, mkUndefined());
    const hiddenClass = shapeObj.hiddenClass;
    const fieldMap = info.map((field) => {
      const desc = hiddenClass.lookupProperty(field.name);
      return desc ? { field, offset: desc.offset } : null;
    });
    if (!fieldMap.every((x) => x)) {
      compiledFn.constructorStub = null;
      return null;
    }
    compiledFn.constructorStub = (args: TaggedValue[]) => {
      const obj = createJSObject();
      if (fn.prototypeObj) obj.setPrototype(fn.prototypeObj);
      presizeInstanceSlots(obj, fn);
      for (const item of fieldMap) {
        if (!item) continue;
        let val;
        if (item.field.source.kind === "local")
          val = (args[item.field.source.index] === undefined ? mkUndefined() : args[item.field.source.index]);
        else if (item.field.source.kind === "const") {
          const constantValue = compiledFn.constants[item.field.source.index];
          val = typeof constantValue === "number"
            ? mkNumber(constantValue)
            : mkUndefined();
        }
        else if (item.field.source.kind === "null") val = mkNull();
        else if (item.field.source.kind === "true") val = mkBool(true);
        else if (item.field.source.kind === "false") val = mkBool(false);
        else val = mkUndefined();
        obj.setProperty(item.field.name, val);
      }
      recordConstruction(fn, obj);
      return mkObject(obj);
    };
    return compiledFn.constructorStub;
  }

  _maybeSweepHeapPayloads(): void {
    if (heapPayloadLiveBytesEstimate() < this._heapSweepThreshold) return;
    const live = markReachableHeapIds(
      this,
      this.globalCells,
      this.microtaskQueue,
    );
    sweepHeapPayloads(live);
    
    
    this._heapSweepThreshold = Math.max(
      1 << 18,
      heapPayloadLiveBytesEstimate() * 4,
    );
  }

  onBackEdge(
    compiledFn: bytecode.RegisterCompiledFunction,
    frame: RegisterFrame,
    target: number,
    loopCounter: number,
  ): TaggedValue | null {
    if ((this._sweepTick = (this._sweepTick + 1) & 0xffff) === 0) {
      this._maybeSweepHeapPayloads();
    }
    const policy = this.tieringPolicy;
    const feedback = compiledFn.feedbackVector;
    const hot = feedback
      ? feedback.decrementLoopBudget(Math.max(frame.pc - target, 1))
      : policy
        ? loopCounter === policy.loopOsrThreshold
        : false;
    if (!hot) return null;

    if (feedback && feedback.osrUrgency === 0) {
      feedback.incrementOsrUrgency();
      return null;
    }

    const engine = this.jitEngine;
    if (
      !engine ||
      !policy ||
      engine.osrEnabled === false ||
      compiledFn.disableOptimization ||
      requiresInterpreterOnly(compiledFn) ||
      typeof engine.compileOsr !== "function"
    ) {
      return null;
    }

    let entry = compiledFn.osrCache.get(target);
    if (entry === undefined) {
      entry = engine.compileOsr(compiledFn, target);
    }
    if (feedback) feedback.resetLoopBudget();
    if (!entry) return null;

    const args: TaggedValue[] = [];
    for (const slot of entry.slots) {
      const value = frame.getReg(slot);
      args.push(value === undefined ? mkUndefined() : value);
    }
    if (entry.code._declinesEntry?.(args)) return null;
    return entry.code(args, frame.thisValue, this);
  }

  runFrame(frame: RegisterFrame): TaggedValue {
    const { compiledFn } = frame;
    const instructions = compiledFn.instructions;
    const funcName = compiledFn.name || "<anonymous>";
    let loopCounter = 0;

    this.callStack.push(funcName);
    this.activeFrames.push(frame);

    try {
      while (frame.pc < instructions.length) {
        try {
          const instr = instructions[frame.pc];
          const op = instr.opcode;
          const operands = instr.operands;

          if (tracer.enabled) {
            tracer.interpret(
              funcName,
              bytecode.rOpcodeName(op),
              operands.length > 0 ? `[${operands.join(", ")}]` : "",
            );
          }

          frame.pc++;

          switch (op) {
            case bytecode.ROP_LDA_CONST: {
              const constVal = constantRuntimeValue(compiledFn, operands[0]);
              frame.acc = this.wrapConstant(constVal);
              break;
            }

            case bytecode.ROP_LDA_REG: {
              frame.acc = frame.getReg(operands[0]);
              break;
            }

            case bytecode.ROP_STAR: {
              frame.setReg(operands[0], frame.acc);
              break;
            }

            case bytecode.ROP_MOV: {
              frame.setReg(operands[1], frame.getReg(operands[0]));
              break;
            }

            case bytecode.ROP_LDA_GLOBAL: {
              const name = constantString(compiledFn, operands[0], "LdaGlobal");
              const val = this.globalCells.read(name);
              if (val === undefined) {
                throw new VMReferenceError(`${name} is not defined`);
              }
              frame.acc = val;
              break;
            }

            case bytecode.ROP_STA_GLOBAL: {
              const name = constantString(compiledFn, operands[0], "StaGlobal");
              this.globalCells.write(name, frame.acc);
              break;
            }

            case bytecode.ROP_LDA_PROP: {
              frame.acc = handleLdaProp(
                this,
                frame,
                operands,
                compiledFn,
                funcName,
              );
              break;
            }

            case bytecode.ROP_STA_PROP: {
              handleStaProp(this, frame, operands, compiledFn, funcName);
              break;
            }

            case bytecode.ROP_LDA_INDEX: {
              frame.acc = handleLdaIndex(
                this,
                frame,
                operands,
                compiledFn,
                funcName,
              );
              break;
            }

            case bytecode.ROP_STA_INDEX: {
              handleStaIndex(this, frame, operands, compiledFn, funcName);
              break;
            }

            case bytecode.ROP_LDA_KEYED_SLICE: {
              frame.acc = handleLdaKeyedSlice(this, frame, operands, compiledFn);
              break;
            }

            case bytecode.ROP_ADD: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right)) {
                const result = smiPayload(left) + smiPayload(right);
                frame.acc =
                  result >= SMI_MIN && result <= SMI_MAX
                    ? mkSmi(result)
                    : mkDouble(result);
              } else if (areBothNumber(left, right)) {
                frame.acc = mkDouble(this.toNumberValue(left) + this.toNumberValue(right));
              } else {
                const overloaded = applyBinaryOverload("add", left, right, this);
                if (overloaded !== null) {
                  frame.acc = overloaded;
                  break;
                }
                const lp = this.toPrimitiveValue(left);
                const rp = this.toPrimitiveValue(right);
                if (isString(lp) || isString(rp)) {
                  frame.acc = mkString(toString(lp) + toString(rp));
                } else {
                  frame.acc = mkDouble(toNumber(lp) + toNumber(rp));
                }
              }
              break;
            }

            case bytecode.ROP_SUB: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right)) {
                const result = smiPayload(left) - smiPayload(right);
                frame.acc =
                  result >= SMI_MIN && result <= SMI_MAX
                    ? mkSmi(result)
                    : mkDouble(result);
              } else {
                const overloaded = applyBinaryOverload("sub", left, right, this);
                frame.acc = overloaded
                  ?? mkDouble(this.toNumberValue(left) - this.toNumberValue(right));
              }
              break;
            }

            case bytecode.ROP_MUL: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right)) {
                const result = smiPayload(left) * smiPayload(right);
                frame.acc =
                  result >= SMI_MIN && result <= SMI_MAX
                    ? mkSmi(result)
                    : mkDouble(result);
              } else {
                const overloaded = applyBinaryOverload("mul", left, right, this);
                frame.acc = overloaded
                  ?? mkDouble(this.toNumberValue(left) * this.toNumberValue(right));
              }
              break;
            }

            case bytecode.ROP_MATMUL: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = applyBinaryOverload("matmul", left, right, this);
              break;
            }

            case bytecode.ROP_DIV: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              const overloaded = applyBinaryOverload("div", left, right, this);
              if (overloaded !== null) {
                frame.acc = overloaded;
                break;
              }
              const result = this.toNumberValue(left) / this.toNumberValue(right);
              frame.acc =
                Number.isInteger(result) &&
                result >= SMI_MIN &&
                result <= SMI_MAX
                  ? mkSmi(result)
                  : mkDouble(result);
              break;
            }

            case bytecode.ROP_MOD: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right) && smiPayload(right) !== 0) {
                frame.acc = mkSmi(smiPayload(left) % smiPayload(right));
              } else {
                frame.acc = mkDouble(this.toNumberValue(left) % this.toNumberValue(right));
              }
              break;
            }

            case bytecode.ROP_EQ: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right))
                frame.acc = mkBool(left === right);
              else if (areBothNumber(left, right))
                frame.acc = mkBool(this.toNumberValue(left) === this.toNumberValue(right));
              else if (isString(left) && isString(right))
                frame.acc = mkBool(getPayload(left) === getPayload(right));
              else if (isBool(left) && isBool(right))
                frame.acc = mkBool(left === right);
              else if (isNull(left) && isNull(right)) frame.acc = mkBool(true);
              else if (isUndefined(left) && isUndefined(right))
                frame.acc = mkBool(true);
              else if (isSymbol(left) && isSymbol(right))
                frame.acc = mkBool(getPayload(left) === getPayload(right));
              else if (
                (isObject(left) || isArray(left) || isFunction(left)) &&
                (isObject(right) || isArray(right) || isFunction(right))
              ) {
                frame.acc = mkBool(getPayload(left) === getPayload(right));
              } else frame.acc = mkBool(false);
              break;
            }

            case bytecode.ROP_NEQ: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right))
                frame.acc = mkBool(left !== right);
              else if (areBothNumber(left, right))
                frame.acc = mkBool(this.toNumberValue(left) !== this.toNumberValue(right));
              else if (isString(left) && isString(right))
                frame.acc = mkBool(getPayload(left) !== getPayload(right));
              else if (isBool(left) && isBool(right))
                frame.acc = mkBool(left !== right);
              else if (isNull(left) && isNull(right)) frame.acc = mkBool(false);
              else if (isUndefined(left) && isUndefined(right))
                frame.acc = mkBool(false);
              else if (isSymbol(left) && isSymbol(right))
                frame.acc = mkBool(getPayload(left) !== getPayload(right));
              else if (
                (isObject(left) || isArray(left) || isFunction(left)) &&
                (isObject(right) || isArray(right) || isFunction(right))
              ) {
                frame.acc = mkBool(getPayload(left) !== getPayload(right));
              } else frame.acc = mkBool(true);
              break;
            }

            case bytecode.ROP_LOOSE_EQ: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = mkBool(abstractLooseEqual(left, right));
              break;
            }

            case bytecode.ROP_LOOSE_NEQ: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = mkBool(!abstractLooseEqual(left, right));
              break;
            }

            case bytecode.ROP_LT: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right))
                frame.acc = mkBool(left < right);
              else if (areBothNumber(left, right))
                frame.acc = mkBool(this.toNumberValue(left) < this.toNumberValue(right));
              else if (isString(left) && isString(right))
                frame.acc = mkBool(getPayload(left) < getPayload(right));
              else frame.acc = applyRelational("lt", left, right, this);
              break;
            }

            case bytecode.ROP_GT: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right))
                frame.acc = mkBool(left > right);
              else if (areBothNumber(left, right))
                frame.acc = mkBool(this.toNumberValue(left) > this.toNumberValue(right));
              else if (isString(left) && isString(right))
                frame.acc = mkBool(getPayload(left) > getPayload(right));
              else frame.acc = applyRelational("gt", left, right, this);
              break;
            }

            case bytecode.ROP_LTE: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right))
                frame.acc = mkBool(left <= right);
              else if (areBothNumber(left, right))
                frame.acc = mkBool(this.toNumberValue(left) <= this.toNumberValue(right));
              else if (isString(left) && isString(right))
                frame.acc = mkBool(getPayload(left) <= getPayload(right));
              else frame.acc = applyRelational("le", left, right, this);
              break;
            }

            case bytecode.ROP_GTE: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right))
                frame.acc = mkBool(left >= right);
              else if (areBothNumber(left, right))
                frame.acc = mkBool(this.toNumberValue(left) >= this.toNumberValue(right));
              else if (isString(left) && isString(right))
                frame.acc = mkBool(getPayload(left) >= getPayload(right));
              else frame.acc = applyRelational("ge", left, right, this);
              break;
            }

            case bytecode.ROP_NOT: {
              const fbSlotIdx = operands.length > 0 ? operands[0] : -1;
              if (fbSlotIdx >= 0 && compiledFn.feedbackVector) {
                const slot = compiledFn.feedbackVector.getSlot(fbSlotIdx);
                if (slot) slot.recordUnaryOp(getTag(frame.acc));
              }
              frame.acc = mkBool(!toBool(frame.acc));
              break;
            }

            case bytecode.ROP_NEG: {
              const fbSlotIdx = operands.length > 0 ? operands[0] : -1;
              if (fbSlotIdx >= 0 && compiledFn.feedbackVector) {
                const slot = compiledFn.feedbackVector.getSlot(fbSlotIdx);
                if (slot) slot.recordUnaryOp(getTag(frame.acc));
              }
              frame.acc = applyUnaryOverload("neg", frame.acc, this)
                ?? mkNumber(-toNumber(frame.acc));
              break;
            }

            case bytecode.ROP_TYPEOF: {
              frame.acc = mkString(typeOf(frame.acc));
              break;
            }

            case bytecode.ROP_CLOSE_UPVALUES: {
              if (frame.hasUpvalues) frame.closeUpvaluesFrom(operands[0]);
              break;
            }

            case bytecode.ROP_JUMP: {
              const target = operands[0];
              if (target < frame.pc) {
                loopCounter++;
                const osr = this.onBackEdge(compiledFn, frame, target, loopCounter);
                if (osr !== null) return osr;
              }
              frame.pc = target;
              continue;
            }

            case bytecode.ROP_JUMP_IF_FALSE: {
              if (!toBool(frame.acc)) {
                const target = operands[0];
                if (target < frame.pc) {
                  loopCounter++;
                  const osr = this.onBackEdge(compiledFn, frame, target, loopCounter);
                  if (osr !== null) return osr;
                }
                frame.pc = target;
                continue;
              }
              break;
            }

            case bytecode.ROP_JUMP_IF_TRUE: {
              if (toBool(frame.acc)) {
                const target = operands[0];
                if (target < frame.pc) {
                  loopCounter++;
                  const osr = this.onBackEdge(compiledFn, frame, target, loopCounter);
                  if (osr !== null) return osr;
                }
                frame.pc = target;
                continue;
              }
              break;
            }

            case bytecode.ROP_CALL: {
              const funcReg = operands[0];
              const firstArgReg = operands[1];
              const argCount = operands[2];
              const fbSlotIdx = operands[3];
              const callee = frame.getReg(funcReg);
              const args = [];
              for (let i = 0; i < argCount; i++)
                args.push(frame.getReg(firstArgReg + i));
              const slot = compiledFn.feedbackVector
                ? compiledFn.feedbackVector.getSlot(fbSlotIdx)
                : null;
              frame.acc = callFunction(
                callee,
                args,
                mkUndefined(),
                slot,
                this,
                frame,
              );
              break;
            }

            case bytecode.ROP_CALL_METHOD: {
              const recvReg = operands[0];
              const firstArgReg = operands[1];
              const argCount = operands[2];
              const fbSlotIdx = operands[3];
              const receiver = frame.getReg(recvReg);
              const callee = frame.acc;
              const args = [];
              for (let i = 0; i < argCount; i++)
                args.push(frame.getReg(firstArgReg + i));
              const slot = compiledFn.feedbackVector
                ? compiledFn.feedbackVector.getSlot(fbSlotIdx)
                : null;
              frame.acc = callFunction(
                callee,
                args,
                receiver,
                slot,
                this,
                frame,
              );
              break;
            }

            case bytecode.ROP_CALL_NAMED: {
              const funcReg = operands[0];
              const firstArgReg = operands[1];
              const argCount = operands[2];
              const firstNamedReg = operands[3];
              const namesIdx = operands[4];
              const namedCount = operands[5];
              const fbSlotIdx = operands[6];
              const callee = frame.getReg(funcReg);
              const args = [];
              for (let i = 0; i < argCount; i++)
                args.push(frame.getReg(firstArgReg + i));
              const names = constantStringList(compiledFn, namesIdx, "CallNamed");
              const named = [];
              for (let i = 0; i < namedCount; i++) {
                named.push({ name: names[i]!, value: frame.getReg(firstNamedReg + i) });
              }
              frame.acc = this.callFunctionValueNamed(callee, args, named, mkUndefined());
              break;
            }

            case bytecode.ROP_CALL_METHOD_NAMED: {
              const recvReg = operands[0];
              const firstArgReg = operands[1];
              const argCount = operands[2];
              const firstNamedReg = operands[3];
              const namesIdx = operands[4];
              const namedCount = operands[5];
              const fbSlotIdx = operands[6];
              const receiver = frame.getReg(recvReg);
              const callee = frame.acc;
              const args = [];
              for (let i = 0; i < argCount; i++)
                args.push(frame.getReg(firstArgReg + i));
              const names = constantStringList(compiledFn, namesIdx, "CallMethodNamed");
              const named = [];
              for (let i = 0; i < namedCount; i++) {
                named.push({ name: names[i]!, value: frame.getReg(firstNamedReg + i) });
              }
              frame.acc = this.callFunctionValueNamed(callee, args, named, receiver);
              break;
            }

            case bytecode.ROP_CALL_SPREAD: {
              const funcReg = operands[0];
              const argsArrReg = operands[1];
              const recvReg = operands[2];
              const fbSlotIdx = operands[3];
              const callee = frame.getReg(funcReg);
              const argsArr = requireArrayPayload(frame, argsArrReg, "CallSpread");
              const args = argsArr.elements.map((arg) => arg ?? mkUndefined());
              const thisVal = recvReg ? frame.getReg(recvReg) : mkUndefined();
              const slot = compiledFn.feedbackVector
                ? compiledFn.feedbackVector.getSlot(fbSlotIdx)
                : null;
              frame.acc = callFunction(
                callee,
                args,
                thisVal,
                slot,
                this,
                frame,
              );
              break;
            }

            case bytecode.ROP_CALL_SPREAD_NAMED: {
              const funcReg = operands[0];
              const argsArrReg = operands[1];
              const firstNamedReg = operands[2];
              const namesIdx = operands[3];
              const namedCount = operands[4];
              const callee = frame.getReg(funcReg);
              const argsArr = requireArrayPayload(frame, argsArrReg, "CallSpreadNamed");
              const args = argsArr.elements.map((arg) => arg ?? mkUndefined());
              const names = constantStringList(compiledFn, namesIdx, "CallSpreadNamed");
              const named = [];
              for (let i = 0; i < namedCount; i++) {
                named.push({ name: names[i]!, value: frame.getReg(firstNamedReg + i) });
              }
              frame.acc = this.callFunctionValueNamed(callee, args, named, mkUndefined());
              break;
            }

            case bytecode.ROP_CALL_METHOD_SPREAD_NAMED: {
              const funcReg = operands[0];
              const argsArrReg = operands[1];
              const recvReg = operands[2];
              const firstNamedReg = operands[3];
              const namesIdx = operands[4];
              const namedCount = operands[5];
              const callee = frame.getReg(funcReg);
              const receiver = frame.getReg(recvReg);
              const argsArr = requireArrayPayload(frame, argsArrReg, "CallMethodSpreadNamed");
              const args = argsArr.elements.map((arg) => arg ?? mkUndefined());
              const names = constantStringList(compiledFn, namesIdx, "CallMethodSpreadNamed");
              const named = [];
              for (let i = 0; i < namedCount; i++) {
                named.push({ name: names[i]!, value: frame.getReg(firstNamedReg + i) });
              }
              frame.acc = this.callFunctionValueNamed(callee, args, named, receiver);
              break;
            }

            case bytecode.ROP_NEW: {
              frame.acc = handleNew(this, frame, operands, compiledFn);
              break;
            }

            case bytecode.ROP_NEW_OBJECT: {
              frame.acc = mkObject(createJSObject());
              break;
            }

            case bytecode.ROP_SET_PROTO: {
              const objReg = operands[0];
              const protoReg = operands[1];
              const obj = frame.getReg(objReg);
              const proto = frame.getReg(protoReg);
              if (isObject(obj) && isObject(proto)) {
                getPayload(obj).setPrototype(getPayload(proto));
              }
              break;
            }

            case bytecode.ROP_DEFINE_ACCESSOR: {
              handleDefineAccessor(this, frame, operands, compiledFn);
              break;
            }

            case bytecode.ROP_NEW_ARRAY: {
              const firstReg = operands[0];
              const count = operands[1];
              const elements = [];
              for (let i = 0; i < count; i++) {
                elements.push(frame.getReg(firstReg + i));
              }
              frame.acc = mkArray(createJSArray(elements));
              break;
            }

            case bytecode.ROP_RETURN: {
              frame.closeUpvalues();
              return frame.acc;
            }

            case bytecode.ROP_ARRAY_REST: {
              const startIdx = constantNumber(compiledFn, operands[0], "ArrayRest");
              const src = frame.acc;
              const elems: TaggedValue[] = [];
              if (isArray(src)) {
                const arr = getPayload(src);
                for (let ri = startIdx; ri < arr.getLength(); ri++) {
                  const v = arr.getIndex(ri);
                  elems.push(v === undefined ? mkUndefined() : v);
                }
              }
              frame.acc = mkArray(createJSArray(elems));
              break;
            }
            case bytecode.ROP_OBJECT_REST: {
              const excluded = constantStringList(compiledFn, operands[0], "ObjectRest");
              const src = frame.acc;
              const restObj = createJSObject();
              if (isObject(src)) {
                const exclSet = new Set(excluded);
                for (const key of runtimeOwnKeys(src, this)) {
                  if (exclSet.has(key)) continue;
                  restObj.setProperty(
                    key,
                    runtimeGetProperty(src, key, this),
                  );
                }
              }
              frame.acc = mkObject(restObj);
              break;
            }
            case bytecode.ROP_LOAD_ARGUMENTS: {
              const srcArgs = frame.originalArgs || [];
              const elems: TaggedValue[] = [];
              for (let ai = 0; ai < srcArgs.length; ai++) {
                elems.push(srcArgs[ai] === undefined ? mkUndefined() : srcArgs[ai]);
              }
              frame.acc = mkArray(createJSArray(elems));
              break;
            }
            case bytecode.ROP_LDA_UNDEFINED: {
              frame.acc = mkUndefined();
              break;
            }
            case bytecode.ROP_LDA_NULL: {
              frame.acc = mkNull();
              break;
            }
            case bytecode.ROP_LDA_TRUE: {
              frame.acc = mkBool(true);
              break;
            }
            case bytecode.ROP_LDA_FALSE: {
              frame.acc = mkBool(false);
              break;
            }
            case bytecode.ROP_LDA_THIS: {
              frame.acc = frame.thisValue;
              break;
            }

            case bytecode.ROP_LDA_UPVALUE: {
              const idx = operands[0];
              const upvalue = compiledFn.upvalues[idx];
              if (!frame.closureEnv) {
                throw new VMReferenceError("Cannot read upvalue without closure environment");
              }
              const upvalueValue = frame.closureEnv.getUpvalue(idx);
              if (upvalueValue === null) {
                throw new VMReferenceError("Cannot read missing upvalue");
              }
              frame.acc = throwIfTDZ(upvalueValue, upvalue ? upvalue.name : undefined);
              break;
            }

            case bytecode.ROP_STA_UPVALUE: {
              if (!frame.closureEnv) {
                throw new VMReferenceError("Cannot write upvalue without closure environment");
              }
              frame.closureEnv.setUpvalue(operands[0], frame.acc);
              break;
            }

            case bytecode.ROP_MAKE_CLOSURE: {
              const constIdx = operands[0];
              const innerFunc = constantCompiledFunction(compiledFn, constIdx, "MakeClosure");
              const cells = [];
              for (let i = 0; i < innerFunc.upvalues.length; i++) {
                const upval = innerFunc.upvalues[i];
                if (!upval) {
                  throw new VMReferenceError("Cannot capture missing upvalue descriptor");
                }
                if (typeof upval.outerSlot !== "number") {
                  throw new VMReferenceError("Cannot capture upvalue without outer slot");
                }
                if (upval.outerType === "local") {
                  cells.push(frame.getOrCreateUpvalueCell(upval.outerSlot));
                } else if (upval.outerType === "upvalue") {
                  if (!frame.closureEnv) {
                    throw new VMReferenceError("Cannot capture upvalue without closure environment");
                  }
                  const cell = frame.closureEnv.cells[upval.outerSlot];
                  if (!cell) {
                    throw new VMReferenceError("Cannot capture missing outer upvalue");
                  }
                  cells.push(cell);
                }
              }
              const env = new Environment(cells);
              const closure = new JSFunction(innerFunc, innerFunc.name ?? undefined, env);
              frame.acc = mkFunction(closure);
              break;
            }

            case bytecode.ROP_GET_KEYS: {
              const objReg = operands[0];
              const keys = forInKeys(frame.getReg(objReg), this);
              frame.acc = mkArray(createJSArray(keys.map((key) => mkString(key))));
              break;
            }

            case bytecode.ROP_GET_LENGTH: {
              const objReg = operands[0];
              const obj = frame.getReg(objReg);
              if (isArray(obj)) {
                frame.acc = mkSmi(getPayload(obj).getLength());
              } else if (isString(obj)) {
                frame.acc = mkSmi(getPayload(obj).length);
              } else {
                frame.acc = mkSmi(0);
              }
              break;
            }

            case bytecode.ROP_TRY_START: {
              if (!frame.exceptionHandlers) frame.exceptionHandlers = [];
              frame.exceptionHandlers.push({
                catchPC: operands[0],
              });
              break;
            }

            case bytecode.ROP_TRY_END: {
              frame.exceptionHandlers?.pop();
              break;
            }

            case bytecode.ROP_THROW: {
              const errorValue = frame.acc;
              if (frame.exceptionHandlers && frame.exceptionHandlers.length > 0) {
                const catchPC = takeCatchPC(frame);
                if (catchPC === null) {
                  frame.closeUpvalues();
                  throw new RegisterException(errorValue);
                }
                frame.acc = errorValue;
                frame.pc = catchPC;
              } else {
                frame.closeUpvalues();
                throw new RegisterException(errorValue);
              }
              break;
            }

            case bytecode.ROP_NEW_REGEX: {
              const constIdx = operands[0];
              const regexData = constantRegex(compiledFn, constIdx);
              const nativeRegex = new RegExp(
                regexData.pattern,
                regexData.flags,
              );
              frame.acc = mkRegex(nativeRegex);
              break;
            }

            case bytecode.ROP_GET_ITERATOR: {
              const obj = frame.acc;
              frame.acc = getIterator(obj, this);
              break;
            }

            case bytecode.ROP_ITER_NEXT: {
              const iter = frame.acc;
              if (!isIterator(iter))
                throw new VMTypeError("value is not an iterator");
              frame.acc = getPayload(iter).nextValue(this);
              break;
            }

            case bytecode.ROP_ITER_DONE: {
              const result = frame.acc;
              frame.acc = mkBool(iteratorDone(result));
              break;
            }

            case bytecode.ROP_ITER_VALUE: {
              const result = frame.acc;
              frame.acc = iteratorValue(result);
              break;
            }

            case bytecode.ROP_AWAIT: {
              const promiseVal = frame.acc;
              if (isPromise(promiseVal)) {
                const p = getPayload(promiseVal);
                if (p.state === PROMISE_FULFILLED) {
                  frame.acc = p.result;
                } else if (p.state === PROMISE_REJECTED) {
                  throw new RegisterException(p.result);
                } else if (frame.suspendable) {
                  throw new AsyncSuspend(frame, promiseVal);
                } else {
                  throw new VMTypeError(
                    `'${compiledFn.name || "<anonymous>"}' awaited a pending value but was not inferred as async. ` +
                      `This is an effect-inference gap: the call site could not be resolved to a known callee. ` +
                      `Mark the function 'async' explicitly, or await the value in the caller.`,
                  );
                }
              } else {
                frame.acc = promiseVal;
              }
              break;
            }

            case bytecode.ROP_YIELD: {
              throw new GeneratorSuspend(frame.acc);
            }

            case bytecode.ROP_BITAND: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = mkSmi((this.toNumberValue(left) | 0) & (this.toNumberValue(right) | 0));
              break;
            }

            case bytecode.ROP_BITOR: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = mkSmi(this.toNumberValue(left) | 0 | (this.toNumberValue(right) | 0));
              break;
            }

            case bytecode.ROP_BITXOR: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = mkSmi((this.toNumberValue(left) | 0) ^ (this.toNumberValue(right) | 0));
              break;
            }

            case bytecode.ROP_SHL: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = mkSmi(
                (this.toNumberValue(left) | 0) << (this.toNumberValue(right) & 0x1f),
              );
              break;
            }

            case bytecode.ROP_SHR: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = mkSmi(
                (this.toNumberValue(left) | 0) >> (this.toNumberValue(right) & 0x1f),
              );
              break;
            }

            case bytecode.ROP_USHR: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              const result = (this.toNumberValue(left) | 0) >>> (this.toNumberValue(right) & 0x1f);
              frame.acc =
                result === (result | 0) ? mkSmi(result) : mkDouble(result);
              break;
            }

            case bytecode.ROP_POW: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              const overloaded = applyBinaryOverload("pow", left, right, this);
              if (overloaded !== null) {
                frame.acc = overloaded;
                break;
              }
              const result = this.toNumberValue(left) ** this.toNumberValue(right);
              frame.acc =
                Number.isInteger(result) && result === (result | 0)
                  ? mkSmi(result)
                  : mkDouble(result);
              break;
            }

            case bytecode.ROP_BITNOT: {
              const fbSlotIdx = operands.length > 0 ? operands[0] : -1;
              if (fbSlotIdx >= 0 && compiledFn.feedbackVector) {
                const slot = compiledFn.feedbackVector.getSlot(fbSlotIdx);
                if (slot) slot.recordUnaryOp(getTag(frame.acc));
              }
              frame.acc = mkSmi(~(toNumber(frame.acc) | 0));
              break;
            }

            case bytecode.ROP_INSTANCEOF: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = handleInstanceof(this, frame, left, right);
              break;
            }

            case bytecode.ROP_IN: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              frame.acc = handleIn(this, frame, left, right);
              break;
            }

            case bytecode.ROP_VOID: {
              frame.acc = mkUndefined();
              break;
            }

            case bytecode.ROP_DELETE_PROP: {
              frame.acc = handleDeleteProp(this, frame, operands, compiledFn);
              break;
            }

            case bytecode.ROP_IS_NULLISH: {
              frame.acc = mkBool(isNull(frame.acc) || isUndefined(frame.acc));
              break;
            }

            case bytecode.ROP_REST_ARGS: {
              const startIdx = operands[0];
              const restElements = frame.originalArgs.slice(startIdx);
              frame.acc = mkArray(createJSArray(restElements));
              break;
            }

            case bytecode.ROP_SPREAD_ARRAY: {
              const arrReg = operands[0];
              const targetArr = requireArrayPayload(frame, arrReg, "SpreadArray");
              const sourceVal = frame.acc;
              if (isArray(sourceVal)) {
                const srcArr = getPayload(sourceVal);
                for (let si = 0; si < srcArr.elements.length; si++) {
                  targetArr.push(srcArr.elements[si] ?? mkUndefined());
                }
              } else if (!isNull(sourceVal) && !isUndefined(sourceVal)) {
                const iter = getIterator(sourceVal, this);
                const record = requireIteratorPayload(iter, "SpreadArray");
                for (let guard = 0; guard < 1e7; guard++) {
                  const result = record.nextValue(this);
                  if (iteratorDone(result)) break;
                  targetArr.push(iteratorValue(result));
                }
              }
              break;
            }

            case bytecode.ROP_COPY_PROPS: {
              const objReg = operands[0];
              const targetObj = requireObjectPayload(frame, objReg, "CopyProps");
              const sourceVal = frame.acc;
              if (isObject(sourceVal)) {
                for (const key of runtimeOwnKeys(sourceVal, this)) {
                  const val = runtimeGetProperty(sourceVal, key, this);
                  targetObj.setProperty(key, val);
                }
              }
              break;
            }

            case bytecode.ROP_STA_COMPUTED_PROP: {
              const objReg = operands[0];
              const keyReg = operands[1];
              const objVal = frame.getReg(objReg);
              const keyVal = frame.getReg(keyReg);
              const key = isSymbol(keyVal) ? keyVal : toDisplayString(keyVal);
              runtimeSetProperty(objVal, key, frame.acc, this);
              break;
            }

            case bytecode.ROP_ARRAY_PUSH: {
              const arrReg = operands[0];
              const targetArr = requireArrayPayload(frame, arrReg, "ArrayPush");
              targetArr.push(frame.acc);
              break;
            }

            default: {
              throw new Error(
                `Unknown register opcode 0x${op.toString(16)} (${bytecode.rOpcodeName(op)}) ` +
                  `at pc=${frame.pc - 1} in "${funcName}"`,
              );
            }
          }
        } catch (e) {
          const thrown = e as ThrownValue;
          if (frame.exceptionHandlers && frame.exceptionHandlers.length > 0) {
            if (thrown instanceof RegisterException) {
              const catchPC = takeCatchPC(frame);
              if (catchPC === null) throw thrown;
              frame.acc = thrown.value;
              frame.pc = catchPC;
              continue;
            }
            if (thrown instanceof VMError) {
              const catchPC = takeCatchPC(frame);
              if (catchPC === null) throw thrown;
              frame.acc = vmErrorToTagged(
                thrown,
                mkString,
                mkObject,
                createJSObject,
                mkBool,
                mkFunction,
              );
              frame.pc = catchPC;
              continue;
            }
            if (thrown instanceof Error) {
              const catchPC = takeCatchPC(frame);
              if (catchPC === null) throw thrown;
              let name = thrown.name || "Error";
              let message = thrown.message || "";
              const m = /^([A-Z][A-Za-z]*Error):\s*([\s\S]*)$/.exec(message);
              if (m) {
                name = m[1];
                message = m[2];
              }
              const errObj = createJSObject();
              errObj.setProperty("name", mkString(name));
              errObj.setProperty("message", mkString(message));
              errObj.setProperty("stack", mkString(thrown.stack || ""));
              errObj.setProperty("__isError__", mkBool(true));
              errObj.setProperty(
                "constructor",
                mkFunction({ name, properties: {} }),
              );
              frame.acc = mkObject(errObj);
              frame.pc = catchPC;
              continue;
            }
          }
          throw thrown;
        }
      }

      frame.closeUpvalues();
      return mkUndefined();
    } finally {
      if (
        this.tieringPolicy &&
        typeof this.tieringPolicy.recordLoopIterations === "function"
      ) {
        this.tieringPolicy.recordLoopIterations(compiledFn, loopCounter);
      }
      this.callStack.pop();
      this.activeFrames.pop();
    }
  }
}
