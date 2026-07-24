import * as ir from "../ir/index.js";
import {
  isSmi,
  isDouble,
  isNumber,
  isObject,
  isBool,
  isArray,
  isString,
  isFunction,
  isRegex,
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
  abstractLooseEqual,
  abstractRelational,
  TAG_SMI,
  TAG_DOUBLE,
  getPayload,
  getTag,
  strictEqual,
  isTaggedValue,
  type TaggedValue,
  stringCharAt,
} from "../../core/value/index.js";
import type { JSObject } from "../../objects/heap/js-object.js";
import { JSArray } from "../../objects/heap/js-array.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import type { FrameState } from "../../deopt/frame-state.js";
import type { RuntimeStubEntry } from "./graph-support.js";
import { applyBinaryOverload, hasRelationalOverload, RELATIONAL_BY_SYMBOL, type BinaryOverload } from "../../runtime/operators.js";
import {
  DeoptSignal,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_RUNTIME_STUB_FAILURE,
  DEOPT_WRONG_CALL_TARGET,
} from "../../deopt/deoptimizer.js";
import {
  runtimeGetProperty as proxyRuntimeGetProperty,
  runtimeSetProperty as proxyRuntimeSetProperty,
  runtimeHasProperty as proxyRuntimeHasProperty,
} from "../../objects/exotic/proxy-ops.js";
import { getRegexProperty } from "../../runtime/intrinsics/regex-methods.js";
import { createJSObject, createJSArray } from "../../objects/heap/factory.js";
import { getHiddenClassById } from "../../objects/maps/hidden-class.js";
import {
  REP_INT32,
  REP_FLOAT64,
  REP_TAGGED_NUMBER,
  REP_HANDLE,
  REP_BOOL,
} from "../passes/repr-selection.js";
import { TYPE_I32, TYPE_F64 } from "./wasm-format.js";
import { elementsKindId } from "./object-layout.js";
import {
  metadataString as metadataStringOrNull,
  metadataNumber as metadataNumberOrNull,
  metadataNumberArray as metadataNumberArrayOrNull,
} from "../ir/metadata.js";

type BuiltinPrototypeSet = {
  arrayPrototype: TaggedValue;
  stringPrototype: TaggedValue;
  regexPrototype: TaggedValue;
  numberPrototype: TaggedValue;
  booleanPrototype: TaggedValue;
};
type RuntimeInterpreterLike = {
  builtinPrototypes?: BuiltinPrototypeSet;
  globalCells: {
    get(name: string): { read(): TaggedValue } | undefined;
    write(name: string, value: TaggedValue): void;
  };
  _lookupBuiltinPrototype(proto: TaggedValue, propName: string): TaggedValue;
  toPrimitiveValue(value: TaggedValue, hint?: string): TaggedValue;
  callFunctionValue(
    callee: TaggedValue,
    args: TaggedValue[],
    receiver: TaggedValue,
  ): TaggedValue;
  constructFunctionValue(callee: TaggedValue, args: TaggedValue[]): TaggedValue;
  callBuiltin(name: string, args: TaggedValue[]): TaggedValue;
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

export function taggedToNumber(v: TaggedValue) {
  if (!v) return 0;
  return toNumber(v);
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
  return Number.isInteger(value) && value === (value | 0)
    ? mkSmi(value)
    : mkDouble(value);
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

export function compareValues(op: string, left: TaggedValue, right: TaggedValue): boolean {
  if (op === "loose==") return abstractLooseEqual(left, right);
  if (op === "loose!=") return !abstractLooseEqual(left, right);
  if (op === "==") {
    if (isNumber(left) && isNumber(right))
      return taggedToNumber(left) === taggedToNumber(right);
    if (isString(left) && isString(right))
      return getPayload(left) === getPayload(right);
    if (isBool(left) && isBool(right))
      return getPayload(left) === getPayload(right);
    return strictEqual(left, right);
  }
  if (op === "!=") return !compareValues("==", left, right);
  const c = abstractRelational(left, right);
  if (op === "<") return c < 0;
  if (op === ">") return c > 0;
  if (op === "<=") return c <= 0;
  if (op === ">=") return c >= 0;
  return false;
}

function getRuntimeProperty(
  obj: TaggedValue,
  propName: string,
  interpreter: RuntimeInterpreterLike | null = null,
): TaggedValue {
  if (isArray(obj)) {
    const arr = getPayload(obj);
    if (propName === "length") return mkSmi(arr.getLength());
    const idx = Number(propName);
    if (Number.isInteger(idx)) {
      const val = arr.getIndex(idx);
      return val !== undefined ? val : mkUndefined();
    }
    const ownVal = arr.getProperty(propName);
    if (ownVal !== undefined) return ownVal;
    if (interpreter && interpreter.builtinPrototypes) {
      return interpreter._lookupBuiltinPrototype(
        interpreter.builtinPrototypes.arrayPrototype,
        propName,
      );
    }
  }
  if (isString(obj)) {
    if (propName === "length") return mkSmi(getPayload(obj).length);
    const idx = Number(propName);
    if (Number.isInteger(idx)) {
      const ch = stringCharAt(getPayload(obj), idx);
      return ch !== undefined ? mkString(ch) : mkUndefined();
    }
    if (interpreter && interpreter.builtinPrototypes) {
      return interpreter._lookupBuiltinPrototype(
        interpreter.builtinPrototypes.stringPrototype,
        propName,
      );
    }
  }
  if (isRegex(obj)) {
    const regexProp = getRegexProperty(propName, getPayload(obj));
    if (regexProp !== null) return regexProp;
    if (interpreter && interpreter.builtinPrototypes) {
      return interpreter._lookupBuiltinPrototype(
        interpreter.builtinPrototypes.regexPrototype,
        propName,
      );
    }
  }
  if (isSmi(obj) || isDouble(obj) || isNumber(obj)) {
    if (interpreter && interpreter.builtinPrototypes) {
      return interpreter._lookupBuiltinPrototype(
        interpreter.builtinPrototypes.numberPrototype,
        propName,
      );
    }
  }
  if (isBool(obj)) {
    if (interpreter && interpreter.builtinPrototypes) {
      return interpreter._lookupBuiltinPrototype(
        interpreter.builtinPrototypes.booleanPrototype,
        propName,
      );
    }
  }
  return proxyRuntimeGetProperty(obj, propName, interpreter);
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

function getRuntimeIndex(
  obj: TaggedValue,
  index: TaggedValue,
  interpreter: RuntimeInterpreterLike | null = null,
): TaggedValue {
  const key = isString(index) ? getPayload(index) : toDisplayString(index);
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
    if (
      fn.compiled === compiledFn &&
      fn.compiled.baselineCode &&
      !fn.closure
    ) {
      result = fn.compiled.baselineCode(
        args,
        (receiver === undefined ? mkUndefined() : receiver),
        runtime.interpreter,
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
      [],
      [],
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
  [ir.IR_GENERIC_ADD]: "add",
  [ir.IR_GENERIC_SUB]: "sub",
  [ir.IR_GENERIC_MUL]: "mul",
  [ir.IR_GENERIC_DIV]: "div",
  [ir.IR_GENERIC_POW]: "pow",
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
    case ir.IR_GENERIC_ADD: {
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
    case ir.IR_GENERIC_SUB:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) - operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_MUL:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) * operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_DIV:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) / operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_MOD:
      return runtimeNumericResult(
        operandToNumber(args[0], runtime) % operandToNumber(args[1], runtime),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_COMPARE: {
      const symbol = propNameFromMetadata(node.props.op);
      const relational = RELATIONAL_BY_SYMBOL[symbol];
      if (relational && hasRelationalOverload(relational, args[0], args[1], runtime.interpreter)) {
        const fs = frameStates ? frameStates[frameStateId] : null;
        throw new DeoptSignal(
          DEOPT_NUMBER_CHECK_FAILED,
          fs ? fs.bytecodeOffset : 0,
          [],
          [],
          frameStateId,
          new Map(),
        );
      }
      return runtimeReturn(compareValues(symbol, args[0], args[1]), runtime, stub.outputRep);
    }
    case ir.IR_LOAD_GLOBAL: {
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
    case ir.IR_STORE_GLOBAL: {
      const val = args[0];
      runtime.interpreter.globalCells.write(propNameFromMetadata(node.props.name), val);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case ir.IR_NEW_OBJECT: {
      const hcId = numberFromMetadata(node.props.targetHiddenClassId, -1);
      const hc = hcId != null ? getHiddenClassById(hcId) : null;
      const obj = createJSObject(hc || undefined);
      if (hc) {
        const propCount = hc.propertyCount || 0;
        for (let _i = 0; _i < propCount; _i++) obj.slots[_i] = mkUndefined();
      }
      return runtimeReturn(mkObject(obj), runtime, stub.outputRep);
    }
    case ir.IR_NEW_ARRAY: {
      const elements = args.slice(0, numberFromMetadata(node.props.elementCount));
      return runtimeReturn(
        mkArray(createJSArray(elements)),
        runtime,
        stub.outputRep,
      );
    }
    case ir.IR_NEW_REGEX: {
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
    case ir.IR_GENERIC_GET_PROP: {
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
    case ir.IR_LOAD_FIELD: {
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
    case ir.IR_STORE_FIELD: {
      const obj = args[0];
      const val = args[1];
      const raw = objectPayloadByOffset(obj);
      if (raw) {
          raw.setPropertyByOffset(numberFromMetadata(node.props.offset), val);
          runtime.syncTagged?.(rawArgs[0]);
      }
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case ir.IR_POLYMORPHIC_LOAD: {
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
            [],
            [],
            frameStateId,
            new Map(),
          );
        }
      }
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case ir.IR_POLYMORPHIC_STORE: {
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
            [],
            [],
            frameStateId,
            new Map(),
          );
        }
      }
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case ir.IR_GENERIC_SET_PROP: {
      const val = setRuntimeProperty(
        args[0],
        propNameFromMetadata(node.props.propName),
        args[1],
        runtime.interpreter,
      );
      runtime.syncTagged?.(rawArgs[0]);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case ir.IR_GENERIC_GET_INDEX: {
      const val = getRuntimeIndex(args[0], args[1], runtime.interpreter);
      if (stub.outputRep === REP_INT32) return taggedToNumber(val) | 0;
      if (
        stub.outputRep === REP_FLOAT64 ||
        stub.outputRep === REP_TAGGED_NUMBER
      )
        return taggedToNumber(val);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case ir.IR_GENERIC_SET_INDEX: {
      const val = setRuntimeIndex(
        args[0],
        args[1],
        args[2],
        runtime.interpreter,
      );
      runtime.syncTagged?.(rawArgs[0]);
      return runtimeReturn(val, runtime, stub.outputRep);
    }
    case ir.IR_GENERIC_CALL: {
      const callee = args[0];
      const argCount = numberFromMetadata(node.props.argCount);
      const callArgs = args.slice(1, 1 + argCount);
      if (node.props.isNew) {
        const realArgs = callArgs.slice(1);
        const newResult = runtime.interpreter.constructFunctionValue(
          callee,
          realArgs,
        );
        return runtimeReturn(newResult, runtime, stub.outputRep);
      }
      const receiver = node.props.isMethod ? callArgs.shift() ?? mkUndefined() : mkUndefined();
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
      if (
        stub.outputRep === REP_INT32 ||
        stub.outputRep === REP_FLOAT64 ||
        stub.outputRep === REP_TAGGED_NUMBER
      ) {
        return runtimeReturn(taggedToNumber(result), runtime, stub.outputRep);
      }
      return runtimeReturn(
        result,
        runtime,
        stub.outputRep,
      );
    }
    case ir.IR_TYPEOF:
      return runtimeReturn(mkString(typeOf(args[0])), runtime, stub.outputRep);
    case ir.IR_NOT:
      return runtimeReturn(!isTruthy(args[0]), runtime, stub.outputRep);
    case ir.IR_NEG:
      return runtimeReturn(-taggedToNumber(args[0]), runtime, stub.outputRep);
    case ir.IR_UNBOX:
      if (node.props.toType === "bool")
        return runtimeReturn(isTruthy(args[0]), runtime, stub.outputRep);
      return runtimeReturn(taggedToNumber(args[0]), runtime, stub.outputRep);
    case ir.IR_CALL_BUILTIN: {
      const builtinName = propNameFromMetadata(node.props.name);
      const builtinArgs = args.slice(0, numberFromMetadata(node.props.argCount));
      if (runtime.interpreter && runtime.interpreter.callBuiltin) {
        return runtimeReturn(
          runtime.interpreter.callBuiltin(builtinName, builtinArgs),
          runtime,
          stub.outputRep,
        );
      }
      return runtimeReturn(mkUndefined(), runtime, stub.outputRep);
    }
    case ir.IR_CALL_KNOWN_FUNCTION: {
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
    case ir.IR_CHECK_CALL_TARGET: {
      const callee = args[0];
      const expectedTarget = node.props.expectedTarget;
      const match =
        isFunction(callee) && getPayload(callee).compiled === expectedTarget;
      if (node.props.deoptOnMiss && !match) {
        const fs = frameStates ? frameStates[frameStateId] : null;
        throw new DeoptSignal(
          DEOPT_WRONG_CALL_TARGET,
          fs ? fs.bytecodeOffset : 0,
          [],
          [],
          frameStateId,
          new Map(),
        );
      }
      return runtimeReturn(
        match ? mkBool(true) : mkBool(false),
        runtime,
        stub.outputRep,
      );
    }
    case ir.IR_GENERIC_BITAND:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) & (taggedToNumber(args[1]) | 0),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_BITOR:
      return runtimeInt32Result(
        taggedToNumber(args[0]) | 0 | (taggedToNumber(args[1]) | 0),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_BITXOR:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) ^ (taggedToNumber(args[1]) | 0),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_SHL:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) << (taggedToNumber(args[1]) & 0x1f),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_SHR:
      return runtimeInt32Result(
        (taggedToNumber(args[0]) | 0) >> (taggedToNumber(args[1]) & 0x1f),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_USHR:
      return runtimeNumericResult(
        (taggedToNumber(args[0]) | 0) >>> (taggedToNumber(args[1]) & 0x1f),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_POW:
    case ir.IR_FLOAT64_POW:
      return runtimeNumericResult(
        Math.pow(taggedToNumber(args[0]), taggedToNumber(args[1])),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_BITNOT:
      return runtimeInt32Result(
        ~(taggedToNumber(args[0]) | 0),
        runtime,
        stub.outputRep,
      );
    case ir.IR_GENERIC_INSTANCEOF: {
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
    case ir.IR_GENERIC_IN: {
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
    case ir.IR_DISPATCH_MAP:
    case ir.IR_MEGAMORPHIC_LOAD: {
      const obj = args[0];
      const propName = node.props.propertyName || node.props.propName;
      if (node.type === ir.IR_DISPATCH_MAP && node.props.isStore === true) {
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
    case ir.IR_MEGAMORPHIC_STORE: {
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
