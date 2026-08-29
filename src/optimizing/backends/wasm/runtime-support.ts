import * as ir from "../../ir/index.js";
import {
  IR_BOX,
  IR_CALL_BUILTIN,
  IR_CALL_INTRINSIC,
  IR_CALL_KNOWN_FUNCTION,
  IR_CHECK_CALL_TARGET,
  IR_DISPATCH_MAP,
  IR_FLOAT64_POW,
  IR_GENERIC_ADD,
  IR_GENERIC_BITAND,
  IR_GENERIC_BITNOT,
  IR_GENERIC_BITOR,
  IR_GENERIC_BITXOR,
  IR_GENERIC_CALL,
  IR_GENERIC_COMPARE,
  IR_GENERIC_DELETE_PROP,
  IR_GENERIC_DIV,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_IN,
  IR_GENERIC_INSTANCEOF,
  IR_GENERIC_MOD,
  IR_GENERIC_MUL,
  IR_GENERIC_POW,
  IR_GENERIC_SET_INDEX,
  IR_GENERIC_SET_PROP,
  IR_GENERIC_SHL,
  IR_GENERIC_SHR,
  IR_GENERIC_SUB,
  IR_GENERIC_USHR,
  IR_LOAD_CONTEXT_SLOT,
  IR_LOAD_FIELD,
  IR_LOAD_GLOBAL,
  IR_MAKE_CLOSURE,
  IR_MEGAMORPHIC_LOAD,
  IR_MEGAMORPHIC_STORE,
  IR_NEG,
  IR_NEW_ARRAY,
  IR_NEW_OBJECT,
  IR_NEW_REGEX,
  IR_NOT,
  IR_POLYMORPHIC_LOAD,
  IR_POLYMORPHIC_STORE,
  IR_STORE_CONTEXT_SLOT,
  IR_STORE_FIELD,
  IR_STORE_GLOBAL,
  IR_TYPEOF,
  IR_UNBOX,
} from "../../ir/operations.js";
import {
  isNumber,
  isObject,
  isBool,
  isArray,
  isString,
  isFunction,
  isNull,
  isUndefined,
  mkSmi,
  mkDouble,
  mkNumber,
  mkBool,
  mkString,
  mkObject,
  mkFunction,
  mkArray,
  mkUndefined,
  mkRegex,
  toNumber,
  toBool,
  toString,
  toDisplayString,
  typeOf,
  TAG_SMI,
  TAG_DOUBLE,
  getPayload,
  getTag,
  isTaggedValue,
  type TaggedValue,
} from "../../../core/value/index.js";
import type { JSObject } from "../../../objects/heap/js-object.js";
import { JSArray } from "../../../objects/heap/js-array.js";
import type { RegisterCompiledFunction } from "../../../bytecode/register/ops/bytecode.js";
import type { FrameState } from "../../../deopt/frame-state.js";
import type { RuntimeStubEntry } from "./graph-support.js";
import { Environment, UpvalueCell } from "../../../runtime/intrinsics/environment.js";
import { applyBinaryOverload, hasRelationalOverload, RELATIONAL_BY_SYMBOL, type BinaryOverload } from "../../../runtime/operators.js";
import {
  DeoptSignal,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_RUNTIME_STUB_FAILURE,
  DEOPT_WRONG_CALL_TARGET,
} from "../../../deopt/deoptimizer.js";
import {
  runtimeGetProperty as proxyRuntimeGetProperty,
  runtimeSetProperty as proxyRuntimeSetProperty,
  runtimeDeleteProperty as proxyRuntimeDeleteProperty,
  runtimeHasProperty as proxyRuntimeHasProperty,
} from "../../../objects/exotic/proxy-ops.js";
import { builtinMethodImplementation } from "../../../runtime/intrinsics/builtin-methods.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodIntrinsicByName,
  builtinNamespaceIntrinsicByName,
  type BuiltinIntrinsic,
  type BuiltinMethodIntrinsic,
} from "../../metadata/builtin-methods.js";
import { createJSObject, createJSArray } from "../../../objects/heap/factory.js";
import { getHiddenClassById } from "../../../objects/maps/hidden-class.js";
import {
  REP_INT32,
  REP_FLOAT64,
  REP_TAGGED_NUMBER,
  REP_HANDLE,
  REP_TAGGED,
  REP_BOOL,
} from "../../types/representation.js";
import { TYPE_I32, TYPE_F64 } from "./wasm-format.js";
import { elementsKindId } from "./object-layout.js";
import {
  metadataString as metadataStringOrNull,
  metadataNumber as metadataNumberOrNull,
  metadataNumberArray as metadataNumberArrayOrNull,
} from "../../ir/metadata.js";
import {
  compareValues,
  getRuntimeProperty,
  taggedToNumber,
} from "../../../runtime/value-semantics.js";
import type { BuiltinPrototypeSet } from "../../../runtime/member-lookup.js";

export type RuntimeInterpreterLike = {
  builtinPrototypes?: BuiltinPrototypeSet;
  globalCells: {
    get(name: string): { read(): TaggedValue } | undefined;
    write(name: string, value: TaggedValue): void;
  };
  _lookupBuiltinPrototype(proto: JSObject, propName: string): TaggedValue;
  toPrimitiveValue(value: TaggedValue, hint?: string): TaggedValue;
  callFunctionValue(
    callee: TaggedValue,
    args: TaggedValue[],
    receiver: TaggedValue,
  ): TaggedValue;
  constructFunctionValue(callee: TaggedValue, args: TaggedValue[]): TaggedValue;
  callRuntimeIntrinsic(name: string, args: TaggedValue[]): TaggedValue;
  consumePendingLazyDeopt?(
    compiledFn: RegisterCompiledFunction,
    bytecodeOffset: number,
    reason: string,
  ): void;
};
type RuntimeLike = {
  interpreter: RuntimeInterpreterLike;
  compiledFn: RegisterCompiledFunction;
  getTagged(raw: number): TaggedValue;
  allocateTagged(value: TaggedValue): number;
  syncTagged?(raw: number): void;
  contextCells?: Map<number, UpvalueCell>;
  contextLocals?: TaggedValue[];
  closureCells?: UpvalueCell[] | null;
};
type AnalysisLike = {
  nodeValueRep: Map<number, string>;
  nodeWasmType: Map<number, number>;
};
type AnyNode = ir.CFGInstruction;
type AnyStub = RuntimeStubEntry;
type SerializableHeapObject = JSObject | JSArray;
type WasmMemoryLike = { buffer: ArrayBuffer };
type RegexConstant = { pattern: string; flags: string };

function propNameFromMetadata(value: ir.IRMetadataValue): string {
  return metadataStringOrNull(value) ?? String(value ?? "");
}

function numberFromMetadata(value: ir.IRMetadataValue, fallback = 0): number {
  return metadataNumberOrNull(value) ?? fallback;
}

function numberArrayFromMetadata(value: ir.IRMetadataValue): number[] {
  return metadataNumberArrayOrNull(value) ?? [];
}

function compiledFunctionFromMetadata(
  value: ir.IRMetadataValue | undefined,
): RegisterCompiledFunction | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RegisterCompiledFunction>;
  return Array.isArray(candidate.instructions) && Array.isArray(candidate.upvalues)
    ? candidate as RegisterCompiledFunction
    : null;
}

function contextSourceFromMetadata(value: ir.IRMetadataValue | undefined): ir.ContextSlotSource {
  if (value === "local" || value === "upvalue") return value;
  throw new Error("Invalid context slot source");
}

function closureCapturesFromMetadata(
  value: ir.IRMetadataValue | undefined,
): ir.ClosureCapture[] {
  if (!Array.isArray(value)) throw new Error("Invalid closure captures");
  const captures: ir.ClosureCapture[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid closure capture ${i}`);
    }
    const source = contextSourceFromMetadata(
      (item as { source?: ir.IRMetadataValue }).source,
    );
    const slot = metadataNumberOrNull((item as { slot?: ir.IRMetadataValue }).slot);
    if (slot === null) throw new Error(`Invalid closure capture slot ${i}`);
    captures.push({ source, slot });
  }
  return captures;
}

function contextCell(
  runtime: RuntimeLike,
  slot: number,
  source: ir.ContextSlotSource = "local",
): UpvalueCell {
  if (source === "upvalue") {
    const cell = runtime.closureCells?.[slot];
    if (!cell) throw new Error(`Missing closure upvalue ${slot}`);
    return cell;
  }
  if (!runtime.contextLocals) runtime.contextLocals = [];
  if (!runtime.contextCells) runtime.contextCells = new Map();
  if (runtime.contextLocals[slot] === undefined) {
    runtime.contextLocals[slot] = mkUndefined();
  }
  let cell = runtime.contextCells.get(slot);
  if (!cell) {
    cell = new UpvalueCell({ locals: runtime.contextLocals }, slot);
    runtime.contextCells.set(slot, cell);
  }
  return cell;
}

function readContextCell(
  runtime: RuntimeLike,
  slot: number,
  source: ir.ContextSlotSource,
): TaggedValue {
  const value = contextCell(runtime, slot, source).get();
  return value === null ? mkUndefined() : value as TaggedValue;
}

function writeContextCell(
  runtime: RuntimeLike,
  slot: number,
  value: TaggedValue,
  source: ir.ContextSlotSource,
): TaggedValue {
  contextCell(runtime, slot, source).set(value);
  return value;
}

function objectPayloadByOffset(value: TaggedValue): JSObject | null {
  return isObject(value) ? getPayload(value) : null;
}

function isRegexConstant(value: object | string | number | boolean | symbol | null | undefined): value is RegexConstant {
  return (
    typeof value === "object" &&
    value !== null &&
    "pattern" in value &&
    "flags" in value &&
    typeof value.pattern === "string" &&
    typeof value.flags === "string"
  );
}

function toPrimitiveOperand(v: TaggedValue, runtime: RuntimeLike, hint = "default") {
  if (!isObject(v) && !isArray(v)) return v;
  if (runtime && runtime.interpreter) {
    return runtime.interpreter.toPrimitiveValue(v, hint);
  }
  return v;
}

function operandToNumber(v: TaggedValue, runtime: RuntimeLike) {
  if (isObject(v) || isArray(v)) {
    return toNumber(toPrimitiveOperand(v, runtime, "number"));
  }
  return taggedToNumber(v);
}

function taggedInt32Result(value: number) {
  return mkSmi(value | 0);
}

function taggedNumericResult(value: number) {
  return mkNumber(value);
}

function runtimeTaggedResult(
  value: TaggedValue,
  runtime: RuntimeLike,
  outputRep: string,
) {
  const numeric =
    outputRep === REP_INT32 ||
    outputRep === REP_FLOAT64 ||
    outputRep === REP_TAGGED_NUMBER;
  return runtimeReturn(numeric ? taggedToNumber(value) : value, runtime, outputRep);
}

function runtimeInt32Result(value: number, runtime: RuntimeLike, outputRep: string) {
  const intValue = value | 0;
  if (
    outputRep === REP_INT32 ||
    outputRep === REP_FLOAT64 ||
    outputRep === REP_TAGGED_NUMBER
  ) {
    return runtimeReturn(intValue, runtime, outputRep);
  }
  return runtimeReturn(taggedInt32Result(intValue), runtime, outputRep);
}

function runtimeNumericResult(value: number, runtime: RuntimeLike, outputRep: string) {
  if (
    outputRep === REP_INT32 ||
    outputRep === REP_FLOAT64 ||
    outputRep === REP_TAGGED_NUMBER
  ) {
    return runtimeReturn(value, runtime, outputRep);
  }
  return runtimeReturn(taggedNumericResult(value), runtime, outputRep);
}

function isTruthy(v: TaggedValue) {
  if (!v || isUndefined(v) || isNull(v)) return false;
  if (isBool(v)) return getPayload(v);
  if (isNumber(v)) return toNumber(v) !== 0 && !Number.isNaN(toNumber(v));
  if (isString(v)) return getPayload(v).length > 0;
  return true;
}

export function runtimeArg(
  raw: number,
  input: AnyNode,
  analysis: AnalysisLike,
  runtime: RuntimeLike,
) {
  if (!input) return mkUndefined();
  const rep = analysis.nodeValueRep.get(input.id);
  const type = analysis.nodeWasmType.get(input.id);
  if (rep === REP_HANDLE) {
    return runtime.getTagged(raw);
  }
  if (rep === REP_TAGGED) {
    return (isTaggedValue(raw) ? raw : mkNumber(raw)) as TaggedValue;
  }
  if (rep === REP_BOOL) return mkBool(Math.trunc(raw) !== 0);
  if (type === TYPE_I32) return mkSmi(Math.trunc(raw));
  if (type === TYPE_F64) return mkNumber(raw);
  return mkNumber(raw);
}

export function runtimeReturn(
  value: TaggedValue | number | boolean,
  runtime: RuntimeLike,
  outputRep: string = REP_HANDLE,
) {
  if (outputRep === REP_BOOL)
    return typeof value === "number" ? (toBool(value) ? 1 : 0) : value ? 1 : 0;
  if (outputRep === REP_TAGGED) {
    if (typeof value === "boolean") return mkBool(value);
    if (typeof value === "number")
      return isTaggedValue(value) ? value : mkNumber(value);
    return value === undefined ? mkUndefined() : value;
  }
  const asNumber =
    typeof value === "number"
      ? value
      : typeof value === "boolean"
        ? value
          ? 1
          : 0
        : taggedToNumber(value);
  if (outputRep === REP_INT32) return Math.trunc(asNumber);
  if (outputRep === REP_FLOAT64 || outputRep === REP_TAGGED_NUMBER)
    return asNumber;
  if (typeof value === "boolean") return runtime.allocateTagged(mkBool(value));
  if (typeof value === "number")
    return runtime.allocateTagged(
      isTaggedValue(value) ? value : mkNumber(value),
    );
  return runtime.allocateTagged((value === undefined ? mkUndefined() : value));
}

function runtimeTaggedReturn(
  value: TaggedValue,
  runtime: RuntimeLike,
  outputRep: string,
) {
  if (
    outputRep === REP_INT32 ||
    outputRep === REP_FLOAT64 ||
    outputRep === REP_TAGGED_NUMBER
  ) {
    return runtimeReturn(taggedToNumber(value), runtime, outputRep);
  }
  return runtimeReturn(value, runtime, outputRep);
}

function setRuntimeProperty(
  obj: TaggedValue,
  propName: string,
  value: TaggedValue,
  interpreter: RuntimeInterpreterLike | null = null,
) {
  proxyRuntimeSetProperty(obj, propName, value, interpreter);
  return value;
}

function deleteRuntimeProperty(
  obj: TaggedValue,
  propName: string,
  interpreter: RuntimeInterpreterLike | null = null,
) {
  if (isObject(obj)) {
    proxyRuntimeDeleteProperty(obj, propName, interpreter);
  }
  return mkBool(true);
}

function getRuntimeIndex(
  obj: TaggedValue,
  index: TaggedValue,
  interpreter: RuntimeInterpreterLike | null = null,
): TaggedValue {
  const key = isString(index) ? getPayload(index) : toDisplayString(index);
  if (isString(obj)) {
    return getRuntimeProperty(obj, key, interpreter);
  }
  return proxyRuntimeGetProperty(obj, key, interpreter);
}

function setRuntimeIndex(
  obj: TaggedValue,
  index: TaggedValue,
  value: TaggedValue,
  interpreter: RuntimeInterpreterLike | null = null,
) {
  const key = isString(index) ? getPayload(index) : toDisplayString(index);
  proxyRuntimeSetProperty(obj, key, value, interpreter);
  return value;
}

function callBuiltinMethod(
  intrinsic: BuiltinMethodIntrinsic,
  args: TaggedValue[],
  runtime: RuntimeLike,
  compiledFn: RegisterCompiledFunction,
  frameStateId: number,
  frameStates: FrameState[],
): TaggedValue {
  const receiver = args[0] ?? mkUndefined();
  const member = () => getRuntimeProperty(receiver, intrinsic.name, runtime.interpreter);
  if (intrinsic.getter) return member();
  const callArgs = args.slice(1);
  const method = builtinMethodImplementation(intrinsic.owner, intrinsic.name, receiver);
  if (method?.call) return method.call(callArgs, receiver, runtime.interpreter);
  return executeRuntimeCall(
    member(),
    callArgs,
    receiver,
    runtime,
    compiledFn,
    frameStateId,
    frameStates,
  );
}

function callBuiltinGlobal(
  intrinsic: BuiltinIntrinsic,
  args: TaggedValue[],
  runtime: RuntimeLike,
  compiledFn: RegisterCompiledFunction,
  frameStateId: number,
  frameStates: FrameState[],
): TaggedValue {
  const cell = runtime.interpreter.globalCells.get(intrinsic.name);
  const callee = cell ? cell.read() : undefined;
  return executeRuntimeCall(
    callee !== undefined ? callee : mkUndefined(),
    args,
    mkUndefined(),
    runtime,
    compiledFn,
    frameStateId,
    frameStates,
  );
}

function callBuiltinNamespace(
  intrinsic: BuiltinMethodIntrinsic,
  args: TaggedValue[],
  runtime: RuntimeLike,
  compiledFn: RegisterCompiledFunction,
  frameStateId: number,
  frameStates: FrameState[],
): TaggedValue {
  const cell = runtime.interpreter.globalCells.get(intrinsic.owner);
  const namespaceValue = cell ? cell.read() : undefined;
  const receiver = namespaceValue !== undefined ? namespaceValue : mkUndefined();
  return executeRuntimeCall(
    getRuntimeProperty(receiver, intrinsic.name, runtime.interpreter),
    args,
    receiver,
    runtime,
    compiledFn,
    frameStateId,
    frameStates,
  );
}

function executeRuntimeCall(
  callee: TaggedValue,
  args: TaggedValue[],
  receiver: TaggedValue,
  runtime: RuntimeLike,
  compiledFn: RegisterCompiledFunction,
  frameStateId: number,
  frameStates: FrameState[],
): TaggedValue {
  if (!isFunction(callee)) {
    return runtime.interpreter.callFunctionValue(
      callee,
      args,
      receiver === undefined ? mkUndefined() : receiver,
    );
  }
  const fn = getPayload(callee);
  let result: TaggedValue;
  if (fn.call) {
    result = fn.call(args, (receiver === undefined ? mkUndefined() : receiver), runtime.interpreter);
  } else if (fn.compiled) {
    if (fn.compiled === compiledFn && fn.compiled.baselineCode) {
      result = fn.compiled.baselineCode(
        args,
        (receiver === undefined ? mkUndefined() : receiver),
        runtime.interpreter,
        fn.closure || null,
      );
    } else {
      result = runtime.interpreter.callFunctionValue(
        callee,
        args,
        (receiver === undefined ? mkUndefined() : receiver),
      );
    }
  } else {
    const fs = frameStates ? frameStates[frameStateId] : null;
    throw new DeoptSignal(
      DEOPT_WRONG_CALL_TARGET,
      fs ? fs.bytecodeOffset : 0,
      frameStateId,
      new Map(),
    );
  }
  if (runtime.interpreter && runtime.interpreter.consumePendingLazyDeopt) {
    runtime.interpreter.consumePendingLazyDeopt(
      compiledFn,
      0,
      "after runtime stub call",
    );
  }
  return result !== undefined ? result : mkUndefined();
}

const OVERLOAD_BY_NODE_TYPE: Record<string, BinaryOverload | undefined> = {
  [IR_GENERIC_ADD]: "add",
  [IR_GENERIC_SUB]: "sub",
  [IR_GENERIC_MUL]: "mul",
  [IR_GENERIC_DIV]: "div",
  [IR_GENERIC_POW]: "pow",
};

export function executeRuntimeStub(
  stub: AnyStub,
  node: AnyNode,
  rawArgs: number[],
  analysis: AnalysisLike,
  runtime: RuntimeLike,
  compiledFn: RegisterCompiledFunction,
  frameStates: FrameState[],
  frameStateId: number,
) {
  const args = node.inputs.map((input, i: number) =>
    runtimeArg(rawArgs[i], input, analysis, runtime),
  );

  const overload = OVERLOAD_BY_NODE_TYPE[node.type];
  if (overload) {
    const result = applyBinaryOverload(overload, args[0], args[1], runtime.interpreter);
    if (result !== null) return runtimeReturn(result, runtime, stub.outputRep);
  }

  switch (node.type) {
    case IR_GENERIC_ADD: {
      const lp = toPrimitiveOperand(args[0], runtime);
      const rp = toPrimitiveOperand(args[1], runtime);
      if (isString(lp) || isString(rp))
        return runtimeReturn(
          mkString(toString(lp) + toString(rp)),
          runtime,
          stub.outputRep,
        );
      return runtimeNumericResult(
        taggedToNumber(lp) + taggedToNumber(rp),
        runtime,
        stub.outputRep,
      );
    }
    case IR_GENERIC_SUB:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) - operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_MUL:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) * operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_DIV:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) / operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_MOD:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) % operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_COMPARE: {
      const symbol = propNameFromMetadata(node.props.op);
      const relational = RELATIONAL_BY_SYMBOL[symbol];
      if (relational && hasRelationalOverload(relational, args[0], args[1], runtime.interpreter)) {
        const fs = frameStates ? frameStates[frameStateId] : null;
        throw new DeoptSignal(
          DEOPT_NUMBER_CHECK_FAILED,
          fs ? fs.bytecodeOffset : 0,
          frameStateId,
          new Map(),
        );
      }
      return runtimeReturn(compareValues(symbol, args[0], args[1]), runtime, stub.outputRep);
    }
    case IR_LOAD_CONTEXT_SLOT: {
      const val = readContextCell(
        runtime,
        numberFromMetadata(node.props.slot),
        contextSourceFromMetadata(node.props.source),
      );
      return runtimeTaggedReturn(val, runtime, stub.outputRep);
    }
    case IR_STORE_CONTEXT_SLOT: {
      const val = writeContextCell(
        runtime,
        numberFromMetadata(node.props.slot),
        args[0] ?? mkUndefined(),
        contextSourceFromMetadata(node.props.source),
      );
      return runtimeTaggedReturn(val, runtime, stub.outputRep);
    }
    case IR_LOAD_GLOBAL: {
      const cell = runtime.interpreter.globalCells.get(propNameFromMetadata(node.props.name));
      const val = cell ? cell.read() : mkUndefined();
      const resolved = val !== undefined ? val : mkUndefined();
      if (
        stub.outputRep === REP_INT32 ||
        stub.outputRep === REP_FLOAT64 ||
        stub.outputRep === REP_TAGGED_NUMBER
      ) {
        return runtimeReturn(taggedToNumber(resolved), runtime, stub.outputRep);
      }
      return runtimeReturn(resolved, runtime, stub.outputRep);
    }
    case IR_STORE_GLOBAL: {
      const val = args[0];
      runtime.interpreter.globalCells.write(propNameFromMetadata(node.props.name), val);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_MAKE_CLOSURE: {
      const target =
        compiledFunctionFromMetadata(node.props.compiled) ??
        compiledFunctionFromMetadata(
          runtime.compiledFn.constants[numberFromMetadata(node.props.constIdx)],
        );
      if (!target) return runtimeReturn(mkUndefined(), runtime, stub.outputRep);
      const captures = closureCapturesFromMetadata(node.props.captures);
      const cells: UpvalueCell[] = [];
      for (let i = 0; i < target.upvalues.length; i++) {
        const capture = captures[i];
        if (!capture) throw new Error(`Missing closure capture ${i}`);
        cells.push(contextCell(runtime, capture.slot, capture.source));
      }
      return runtimeReturn(
        mkFunction({
          name: target.name ?? undefined,
          compiled: target,
          closure: new Environment(cells),
        }),
        runtime,
        stub.outputRep,
      );
    }
    case IR_NEW_OBJECT: {
      const hcId = numberFromMetadata(node.props.targetHiddenClassId, -1);
      const hc = hcId != null ? getHiddenClassById(hcId) : null;
      const obj = createJSObject(hc || undefined);
      if (hc) {
        const propCount = hc.propertyCount || 0;
        for (let _i = 0; _i < propCount; _i++) obj.slots[_i] = mkUndefined();
      }
      return runtimeReturn(mkObject(obj), runtime, stub.outputRep);
    }
    case IR_NEW_ARRAY: {
      const elements = args.slice(0, numberFromMetadata(node.props.elementCount));
      return runtimeReturn(
        mkArray(createJSArray(elements)),
        runtime,
        stub.outputRep,
      );
    }
    case IR_NEW_REGEX: {
      const constant =
        runtime.compiledFn.constants[numberFromMetadata(node.props.constIdx)];
      const regex = isRegexConstant(constant)
        ? constant
        : { pattern: "", flags: "" };
      return runtimeReturn(
        mkRegex(new RegExp(regex.pattern, regex.flags)),
        runtime,
        stub.outputRep,
      );
    }
    case IR_GENERIC_GET_PROP: {
      const val = getRuntimeProperty(
        args[0],
        propNameFromMetadata(node.props.propName),
        runtime.interpreter,
      );
      if (stub.outputRep === REP_INT32) return taggedToNumber(val) | 0;
      if (
        stub.outputRep === REP_FLOAT64 ||
        stub.outputRep === REP_TAGGED_NUMBER
      )
        return taggedToNumber(val);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_LOAD_FIELD: {
      const obj = args[0];
      let val: TaggedValue = mkUndefined();
      const raw = objectPayloadByOffset(obj);
      if (raw) {
          val = raw.getPropertyByOffset(numberFromMetadata(node.props.offset)) ?? mkUndefined();
      }
      if (stub.outputRep === REP_INT32) return taggedToNumber(val) | 0;
      if (
        stub.outputRep === REP_FLOAT64 ||
        stub.outputRep === REP_TAGGED_NUMBER
      ) {
        return taggedToNumber(val);
      }
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_STORE_FIELD: {
      const obj = args[0];
      const val = args[1];
      const raw = objectPayloadByOffset(obj);
      if (raw) {
          raw.setPropertyByOffset(numberFromMetadata(node.props.offset), val);
          runtime.syncTagged?.(rawArgs[0]);
      }
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_POLYMORPHIC_LOAD: {
      const obj = args[0];
      let val: TaggedValue = mkUndefined();
      const raw = objectPayloadByOffset(obj);
      if (raw) {
        const mapId = isObject(obj) ? getPayload(obj).hiddenClass?.id : -1;
        const maps = numberArrayFromMetadata(node.props.maps);
        const offsets = numberArrayFromMetadata(node.props.offsets);
        const mapIndex = maps.indexOf(mapId);
        if (
          mapIndex >= 0 &&
          raw
        ) {
          val = raw.getPropertyByOffset(offsets[mapIndex] ?? -1) ?? mkUndefined();
        } else {
          const fs = frameStates ? frameStates[frameStateId] : null;
          throw new DeoptSignal(
            DEOPT_MAP_CHECK_FAILED,
            fs ? fs.bytecodeOffset : 0,
            frameStateId,
            new Map(),
          );
        }
      }
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_POLYMORPHIC_STORE: {
      const obj = args[0];
      const val = args[1];
      const raw = objectPayloadByOffset(obj);
      if (raw) {
        const mapId = isObject(obj) ? getPayload(obj).hiddenClass?.id : -1;
        const maps = numberArrayFromMetadata(node.props.maps);
        const offsets = numberArrayFromMetadata(node.props.offsets);
        const mapIndex = maps.indexOf(mapId);
        if (
          mapIndex >= 0 &&
          raw
        ) {
          raw.setPropertyByOffset(offsets[mapIndex] ?? -1, val);
          runtime.syncTagged?.(rawArgs[0]);
        } else {
          const fs = frameStates ? frameStates[frameStateId] : null;
          throw new DeoptSignal(
            DEOPT_MAP_CHECK_FAILED,
            fs ? fs.bytecodeOffset : 0,
            frameStateId,
            new Map(),
          );
        }
      }
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_GENERIC_SET_PROP: {
      const val = setRuntimeProperty(
        args[0],
        propNameFromMetadata(node.props.propName),
        args[1],
        runtime.interpreter,
      );
      runtime.syncTagged?.(rawArgs[0]);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_GENERIC_DELETE_PROP: {
      const propName =
        node.inputs.length > 1
          ? toDisplayString(args[1])
          : propNameFromMetadata(node.props.propName);
      const val = deleteRuntimeProperty(
        args[0],
        propName,
        runtime.interpreter,
      );
      runtime.syncTagged?.(rawArgs[0]);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_GENERIC_GET_INDEX: {
      const val = getRuntimeIndex(args[0], args[1], runtime.interpreter);
      if (stub.outputRep === REP_INT32) return taggedToNumber(val) | 0;
      if (
        stub.outputRep === REP_FLOAT64 ||
        stub.outputRep === REP_TAGGED_NUMBER
      )
        return taggedToNumber(val);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_GENERIC_SET_INDEX: {
      const val = setRuntimeIndex(
        args[0],
        args[1],
        args[2],
        runtime.interpreter,
      );
      runtime.syncTagged?.(rawArgs[0]);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_GENERIC_CALL: {
      const callee = args[0];
      const argCount = numberFromMetadata(node.props.argCount);
      if (node.props.isNew) {
        const callArgs = args.slice(2, 1 + argCount);
        const newResult = runtime.interpreter.constructFunctionValue(
          callee,
          callArgs,
        );
        return runtimeReturn(newResult, runtime, stub.outputRep);
      }
      const receiver = node.props.isMethod ? args[1] ?? mkUndefined() : mkUndefined();
      const firstArg = node.props.isMethod ? 2 : 1;
      const realArgCount = node.props.isMethod ? Math.max(0, argCount - 1) : argCount;
      const callArgs = args.slice(firstArg, firstArg + realArgCount);
      const result = executeRuntimeCall(
        callee,
        callArgs,
        receiver,
        runtime,
        compiledFn,
        frameStateId,
        frameStates,
      );
      for (let i = 1; i < node.inputs.length; i++) {
        runtime.syncTagged?.(rawArgs[i]);
      }
      return runtimeTaggedResult(result, runtime, stub.outputRep);
    }
    case IR_TYPEOF:
      return runtimeReturn(mkString(typeOf(args[0])), runtime, stub.outputRep);
    case IR_NOT:
      return runtimeReturn(!isTruthy(args[0]), runtime, stub.outputRep);
    case IR_NEG:
      return runtimeReturn(-taggedToNumber(args[0]), runtime, stub.outputRep);
    case IR_BOX:
      return runtimeReturn(args[0], runtime, stub.outputRep);
    case IR_UNBOX:
      if (node.props.toType === "bool")
        return runtimeReturn(isTruthy(args[0]), runtime, stub.outputRep);
      return runtimeReturn(taggedToNumber(args[0]), runtime, stub.outputRep);
    case IR_CALL_INTRINSIC: {
      const builtinName = propNameFromMetadata(node.props.name);
      const builtinArgs = args.slice(0, numberFromMetadata(node.props.argCount));
      if (runtime.interpreter?.callRuntimeIntrinsic) {
        return runtimeReturn(
          runtime.interpreter.callRuntimeIntrinsic(builtinName, builtinArgs),
          runtime,
          stub.outputRep,
        );
      }
      return runtimeReturn(mkUndefined(), runtime, stub.outputRep);
    }
    case IR_CALL_BUILTIN: {
      const builtinName = propNameFromMetadata(node.props.name);
      const builtinArgs = args.slice(0, numberFromMetadata(node.props.argCount));
      const method = builtinMethodIntrinsicByName(builtinName);
      if (method !== null) {
        return runtimeTaggedResult(
          callBuiltinMethod(
            method,
            builtinArgs,
            runtime,
            compiledFn,
            frameStateId,
            frameStates,
          ),
          runtime,
          stub.outputRep,
        );
      }
      const namespaced = builtinNamespaceIntrinsicByName(builtinName);
      if (namespaced !== null) {
        return runtimeTaggedResult(
          callBuiltinNamespace(
            namespaced,
            builtinArgs,
            runtime,
            compiledFn,
            frameStateId,
            frameStates,
          ),
          runtime,
          stub.outputRep,
        );
      }
      const global = builtinGlobalIntrinsicByName(builtinName);
      if (global !== null) {
        return runtimeTaggedResult(
          callBuiltinGlobal(
            global,
            builtinArgs,
            runtime,
            compiledFn,
            frameStateId,
            frameStates,
          ),
          runtime,
          stub.outputRep,
        );
      }
      return runtimeReturn(mkUndefined(), runtime, stub.outputRep);
    }
    case IR_CALL_KNOWN_FUNCTION: {
      const target = node.props.target;
      const callArgs = args.slice(0, numberFromMetadata(node.props.argCount));
      const targetFn =
        target &&
        typeof target === "object" &&
        "instructions" in target &&
        "paramCount" in target
          ? target as RegisterCompiledFunction
          : null;
      if (!targetFn) return runtimeReturn(mkUndefined(), runtime, stub.outputRep);
      const receiver = mkUndefined();
      const callee = mkFunction({
        name: targetFn.name ?? undefined,
        compiled: targetFn,
        closure: null,
      });
      return runtimeReturn(
        executeRuntimeCall(
          callee,
          callArgs,
          receiver,
          runtime,
          compiledFn,
          frameStateId,
          frameStates,
        ),
        runtime,
        stub.outputRep,
      );
    }
    case IR_CHECK_CALL_TARGET: {
      const callee = args[0];
      const expectedTarget = node.props.expectedTarget;
      const match =
        isFunction(callee) && getPayload(callee).compiled === expectedTarget;
      if (node.props.deoptOnMiss && !match) {
        const fs = frameStates ? frameStates[frameStateId] : null;
        throw new DeoptSignal(
          DEOPT_WRONG_CALL_TARGET,
          fs ? fs.bytecodeOffset : 0,
          frameStateId,
          new Map([[node.inputs[0].id, callee]]),
        );
      }
      return runtimeReturn(
        match ? mkBool(true) : mkBool(false),
        runtime,
        stub.outputRep,
      );
    }
    case IR_GENERIC_BITAND:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) & (taggedToNumber(args[1]) | 0),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_BITOR:
      return runtimeInt32Result(
        taggedToNumber(args[0]) | 0 | (taggedToNumber(args[1]) | 0),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_BITXOR:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) ^ (taggedToNumber(args[1]) | 0),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_SHL:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) << (taggedToNumber(args[1]) & 0x1f),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_SHR:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) >> (taggedToNumber(args[1]) & 0x1f),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_USHR:
      return runtimeNumericResult(
        (taggedToNumber(args[0]) | 0) >>> (taggedToNumber(args[1]) & 0x1f),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_POW:
    case IR_FLOAT64_POW:
      return runtimeNumericResult(
        Math.pow(taggedToNumber(args[0]), taggedToNumber(args[1])),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_BITNOT:
      return runtimeInt32Result(
        ~(taggedToNumber(args[0]) | 0),
        runtime,
        stub.outputRep,
      );
    case IR_GENERIC_INSTANCEOF: {
      const obj = args[0];
      const ctor = args[1];
      let result = false;
      if (isObject(obj) && isFunction(ctor)) {
        const fn = getPayload(ctor);
        if (fn.prototypeObj) {
          let proto = getPayload(obj).prototype;
          while (proto) {
            if (proto === fn.prototypeObj) {
              result = true;
              break;
            }
            proto = proto.prototype;
          }
        }
      }
      return runtimeReturn(mkBool(result), runtime, stub.outputRep);
    }
    case IR_GENERIC_IN: {
      const propName = toDisplayString(args[0]);
      const obj = args[1];
      if (isObject(obj) || isArray(obj)) {
        return runtimeReturn(
          mkBool(proxyRuntimeHasProperty(obj, propName, runtime.interpreter)),
          runtime,
          stub.outputRep,
        );
      }
      return runtimeReturn(mkBool(false), runtime, stub.outputRep);
    }
    case IR_DISPATCH_MAP:
    case IR_MEGAMORPHIC_LOAD: {
      const obj = args[0];
      const propName = node.props.propertyName || node.props.propName;
      if (node.type === IR_DISPATCH_MAP && node.props.isStore === true) {
        const val = setRuntimeProperty(
          obj,
          propNameFromMetadata(propName),
          args[1],
          runtime.interpreter,
        );
        runtime.syncTagged?.(rawArgs[0]);
        return runtimeReturn(val, runtime, stub.outputRep);
      }
      const val = getRuntimeProperty(obj, propNameFromMetadata(propName), runtime.interpreter);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case IR_MEGAMORPHIC_STORE: {
      const obj = args[0];
      const propName = node.props.propertyName || node.props.propName;
      const val = setRuntimeProperty(
        obj,
        propNameFromMetadata(propName),
        args[1],
        runtime.interpreter,
      );
      runtime.syncTagged?.(rawArgs[0]);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    default:
      throw new Error("Unsupported runtime stub: " + node.type);
  }
}

export function serializeObject(
  jsObj: SerializableHeapObject,
  memory: WasmMemoryLike,
  basePtr: number,
  allocateTaggedValue: ((value: TaggedValue) => number) | null = null,
  maxSlots = -1,
  fromIndex = 0,
) {
  if (!jsObj || !memory) return;
  let view = new DataView(memory.buffer);
  const liveView = () => {
    if (view.buffer !== memory.buffer) view = new DataView(memory.buffer);
    return view;
  };
  const isJsArray = jsObj instanceof JSArray;
  const mapId = isJsArray ? -1 : jsObj.hiddenClass ? jsObj.hiddenClass.id : 0;
  view.setInt32(basePtr, mapId, true);

  const slots = isJsArray ? jsObj.elements : jsObj.slots;
  view.setInt32(basePtr + 4, slots ? slots.length : 0, true);
  if (isJsArray) {
    view.setInt32(
      basePtr + 8,
      elementsKindId(
        jsObj.getElementsKind ? jsObj.getElementsKind() : jsObj.elementsKind,
      ),
      true,
    );
  }

  if (!slots) return;




  const limit =
    !isJsArray && maxSlots >= 0 ? Math.min(slots.length, maxSlots) : slots.length;

  for (let i = Math.max(fromIndex, 0); i < limit; i++) {
    const val = slots[i];
    let numVal = 0;
    if (typeof val === "number" && isNumber(val)) numVal = toNumber(val);
    else if (typeof val === "number" && isBool(val)) numVal = getPayload(val) ? 1 : 0;
    else if (
      typeof val === "number" &&
      val !== undefined &&
      allocateTaggedValue &&
      (isObject(val) ||
        isArray(val) ||
        isFunction(val) ||
        isString(val) ||
        isNull(val) ||
        isUndefined(val))
    ) {
      numVal = allocateTaggedValue(val);
    }
    liveView().setFloat64(basePtr + (isJsArray ? 16 : 8) + i * 8, numVal, true);
  }
}

export function deserializeObject(
  jsObj: SerializableHeapObject,
  memory: WasmMemoryLike,
  basePtr: number,
  maxSlots = -1,
) {
  if (!jsObj || !memory) return;
  const view = new DataView(memory.buffer);
  const isArray = jsObj instanceof JSArray;
  const slots = isArray ? jsObj.elements : jsObj.slots;

  if (!slots) return;

  
  
  const limit =
    !isArray && maxSlots >= 0 ? Math.min(slots.length, maxSlots) : slots.length;

  for (let i = 0; i < limit; i++) {
    const numVal = view.getFloat64(basePtr + (isArray ? 16 : 8) + i * 8, true);
    const current = slots[i];
    if (typeof current === "number") {
      const tag = getTag(current);
      if (tag === TAG_SMI) {
        if (Number.isInteger(numVal) && numVal === (numVal | 0)) {
          slots[i] = mkSmi(numVal);
        } else {
          slots[i] = mkDouble(numVal);
        }
      } else if (tag === TAG_DOUBLE) {
        slots[i] = mkDouble(numVal);
      } else if (tag === "bool") {
        slots[i] = mkBool(numVal !== 0);
      }
    }
  }
}
