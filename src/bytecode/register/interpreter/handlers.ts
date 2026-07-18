import {
  mkSmi,
  mkString,
  mkObject,
  mkFunction,
  mkUndefined,
  mkBool,
  mkGenerator,
  mkRegex,
  mkArray,
  mkNumber,
  isSmi,
  isNumber,
  isString,
  isObject,
  isFunction,
  isArray,
  isRegex,
  isPromise,
  isGenerator,
  isSymbol,
  isBool,
  isDouble,
  toNumber,
  toDisplayString,
  getPayload,
  type GeneratorValue,
  type RuntimeFunctionPayload,
  type PromiseValue,
  type TaggedValue,
} from "../../../core/value/index.js";

import {
  AccessorPair,
  presizeInstanceSlots,
  recordConstruction,
} from "../../../objects/heap/js-object.js";
import {
  INSTANCE_TYPE_MAP,
  INSTANCE_TYPE_SET,
  INSTANCE_TYPE_STRING_WRAPPER,
  INSTANCE_TYPE_NUMBER_WRAPPER,
  INSTANCE_TYPE_BOOLEAN_WRAPPER,
} from "../../../objects/maps/hidden-class.js";
import {
  createJSObject,
  createJSArray,
} from "../../../objects/heap/factory.js";
import {
  mkPromiseCapability,
  promiseThen,
  PROMISE_FULFILLED,
  PROMISE_REJECTED,
} from "../../../runtime/async/promise.js";
import { createIteratorResult } from "../../../runtime/iteration/iterator.js";
import {
  GEN_NEWBORN,
  GEN_SUSPENDED,
  GEN_COMPLETED,
} from "../../../runtime/iteration/generator.js";
import { getRegexProperty } from "../../../runtime/intrinsics/regex-methods.js";
import { VMTypeError } from "../../../core/errors/index.js";
import {
  isJSProxyValue,
  runtimeDeleteProperty,
  runtimeGetProperty,
  runtimeSetProperty,
  runtimeOwnKeys,
  runtimeHasProperty,
} from "../../../objects/exotic/proxy-ops.js";
import { RegisterException, runGeneratorFrame } from "./helpers.js";
import { RegisterFrame } from "./frame.js";
import { isNull, isUndefined as isUndefinedVal, typeOf } from "../../../core/value/index.js";
import type { RegisterCompiledFunction } from "../ops/bytecode.js";
import type { InlineCacheManager } from "../../../feedback/ic/index.js";
import type { MicrotaskQueue } from "../../../runtime/microtasks/microtask.js";
import type { JSObject } from "../../../objects/heap/js-object.js";

type InterpreterLike = {
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
  execute(
    compiledFn: RegisterCompiledFunction,
    args?: TaggedValue[],
    thisValue?: TaggedValue | null,
  ): TaggedValue;
  runFrame(frame: RegisterFrame): TaggedValue;
  initFeedbackVector(compiledFn: RegisterCompiledFunction): void;
  getConstructorStub(
    compiledFn: RegisterCompiledFunction,
    fn: RuntimeFunctionPayload,
  ): ((args: TaggedValue[]) => TaggedValue) | null;
  _lookupBuiltinPrototype(proto: JSObject, propName: string): TaggedValue;
  icManager: InlineCacheManager;
  builtinPrototypes: Record<string, JSObject>;
  microtaskQueue: MicrotaskQueue;
  exceptionToValue(error: object | string | number | boolean | symbol | null | undefined): TaggedValue;
};
type CompiledFunctionLike = RegisterCompiledFunction;
type OperandList = number[];

function constantPropertyName(
  compiledFn: CompiledFunctionLike,
  constantIndex: number,
): string {
  return String(compiledFn.constants[constantIndex]);
}

function spreadArrayArg(arrVal: TaggedValue): TaggedValue[] {
  const out: TaggedValue[] = [];
  if (isArray(arrVal)) {
    const arr = getPayload(arrVal);
    for (let i = 0; i < arr.getLength(); i++) {
      const v = arr.getIndex(i);
      out.push(v === undefined ? mkUndefined() : v);
    }
  }
  return out;
}

function makeFunctionMethod(targetFn: TaggedValue, kind: string): TaggedValue {
  if (kind === "call") {
    return mkFunction({
      name: "call",
      call(callArgs: TaggedValue[], _t: RuntimeValue, interp: InterpreterLike) {
        const thisArg = callArgs.length > 0 ? callArgs[0] : mkUndefined();
        return interp.callFunctionValue(targetFn, callArgs.slice(1), thisArg);
      },
    });
  }
  if (kind === "apply") {
    return mkFunction({
      name: "apply",
      call(callArgs: TaggedValue[], _t: RuntimeValue, interp: InterpreterLike) {
        const thisArg = callArgs.length > 0 ? callArgs[0] : mkUndefined();
        const applyArgs =
          callArgs.length > 1 ? spreadArrayArg(callArgs[1]) : [];
        return interp.callFunctionValue(targetFn, applyArgs, thisArg);
      },
    });
  }
  return mkFunction({
    name: "bind",
    call(bindArgs: TaggedValue[], _t: RuntimeValue, interp: InterpreterLike) {
      const boundThis = bindArgs.length > 0 ? bindArgs[0] : mkUndefined();
      const partial = bindArgs.slice(1);
      return mkFunction({
        name: "bound",
        call(callArgs: TaggedValue[], _t2: RuntimeValue, ip: InterpreterLike) {
          return ip.callFunctionValue(
            targetFn,
            partial.concat(callArgs),
            boundThis,
          );
        },
        construct(callArgs: TaggedValue[], ip: InterpreterLike) {
          return ip.callFunctionValue(
            targetFn,
            partial.concat(callArgs),
            mkUndefined(),
          );
        },
      });
    },
  });
}

type PropertyFeedbackSlot = {
  recordPropertyAccess(
    hiddenClassId: number,
    offset: number,
    mapVersion?: number,
    protoDepth?: number,
  ): void;
};

function recordPropertyFeedback(
  slot: PropertyFeedbackSlot,
  jsObj: JSObject,
  propName: string,
): void {
  const info = jsObj.hiddenClass.lookupProperty(propName);
  if (info) {
    if (info.kind === "accessor") return;
    slot.recordPropertyAccess(
      jsObj.hiddenClass.id,
      info.offset,
      jsObj.hiddenClass.version,
      0,
    );
  } else if (jsObj.prototype) {
    const protoResult_ = jsObj.lookupPrototypeChain(propName);
    if (protoResult_.found && protoResult_.descriptor) {
      if (protoResult_.descriptor.kind === "accessor") return;
      slot.recordPropertyAccess(
        jsObj.hiddenClass.id,
        protoResult_.descriptor.offset,
        jsObj.hiddenClass.version,
        protoResult_.depth,
      );
    }
  }
}

function throwNullishAccess(
  isNullObj: boolean,
  propName: string,
  write: boolean,
): never {
  const typeName = isNullObj ? "null" : "undefined";
  const verb = write ? "set" : "read";
  const gerund = write ? "setting" : "reading";
  throw new VMTypeError(`Cannot ${verb} properties of ${typeName} (${gerund} '${propName}')`);
}

function throwIfNullish(obj: TaggedValue, propName: string, write = false): void {
  if (isNull(obj) || isUndefinedVal(obj)) {
    throwNullishAccess(isNull(obj), propName, write);
  }
}

function throwIfNullishKey(
  obj: TaggedValue,
  index: TaggedValue,
  write = false,
): void {
  if (isNull(obj) || isUndefinedVal(obj)) {
    const key = isString(index) ? getPayload(index) : toDisplayString(index);
    throwNullishAccess(isNull(obj), key, write);
  }
}

export function handleLdaProp(
  interp: InterpreterLike,
  frame: RegisterFrame,
  operands: OperandList,
  compiledFn: CompiledFunctionLike,
  funcName: string | null | undefined,
): TaggedValue {
  const objReg = operands[0];
  const propNameIdx = operands[1];
  const fbSlotIdx = operands[2];
  const obj = frame.getReg(objReg);
  const propName = constantPropertyName(compiledFn, propNameIdx);

  throwIfNullish(obj, propName);

  if (isJSProxyValue(obj)) {
    return runtimeGetProperty(obj, propName, interp);
  }

  if (isObject(obj)) {
    const jsObj = getPayload(obj);

    const accDesc = jsObj.hiddenClass.lookupProperty(propName);
    if (accDesc && accDesc.kind === "accessor") {
      const pair = jsObj.storedProperty(propName);
      if (pair instanceof AccessorPair && pair.get) {
        return interp.callFunctionValue(pair.get, [], obj);
      } else {
        return mkUndefined();
      }
    }
    if (!accDesc && jsObj.prototype) {
      const protoAcc = jsObj.lookupPrototypeChain(propName);
      if (
        protoAcc.found &&
        protoAcc.descriptor &&
        protoAcc.descriptor.kind === "accessor"
      ) {
        const pair = protoAcc.value;
        if (pair instanceof AccessorPair && pair.get) {
          return interp.callFunctionValue(pair.get, [], obj);
        } else {
          return mkUndefined();
        }
      }
    }

    if (propName === "size") {
      const itype = jsObj.hiddenClass.instanceType;
      if (itype === INSTANCE_TYPE_MAP) return mkSmi(jsObj._mapData!.size);
      if (itype === INSTANCE_TYPE_SET) return mkSmi(jsObj._setData!.size);
    }

    const wrapperType = jsObj.hiddenClass.instanceType;
    if (
      wrapperType === INSTANCE_TYPE_STRING_WRAPPER &&
      jsObj._primitiveValue !== undefined &&
      isString(jsObj._primitiveValue)
    ) {
      const primitiveString = getPayload(jsObj._primitiveValue);
      if (propName === "length") return mkSmi(primitiveString.length);
      const idx = Number(propName);
      if (Number.isInteger(idx)) {
        const ch = primitiveString[idx];
        return ch !== undefined ? mkString(ch) : mkUndefined();
      }
    }

    const icKey = compiledFn.getICKey(funcName, fbSlotIdx);
    const ic = interp.icManager.getOrCreate(icKey);
    const result = ic.lookup(jsObj, propName);

    const slot = compiledFn.feedbackVector
      ? compiledFn.feedbackVector.getSlot(fbSlotIdx)
      : null;
    if (slot) {
      recordPropertyFeedback(slot, jsObj, propName);
    }

    if (result.hit) {
      const cached = result.value;
      return cached !== undefined &&
        !(typeof cached === "object" && cached instanceof AccessorPair)
        ? cached
        : mkUndefined();
    } else {
      let val: TaggedValue | AccessorPair | undefined = jsObj.getProperty(propName);
      if (val === undefined && jsObj.prototype) {
        const protoResult = jsObj.lookupPrototypeChain(propName);
        if (protoResult.found) val = protoResult.value;
      }
      return val !== undefined &&
        !(typeof val === "object" && val instanceof AccessorPair)
        ? val
        : mkUndefined();
    }
  } else if (isArray(obj)) {
    if (propName === "length") {
      const slot_arr = compiledFn.feedbackVector
        ? compiledFn.feedbackVector.getSlot(fbSlotIdx)
        : null;
      if (slot_arr)
        slot_arr.recordArrayLengthAccess(
          true,
          getPayload(obj).getElementsKind(),
        );
      return mkSmi(getPayload(obj).getLength());
    } else {
      const idx = Number(propName);
      if (Number.isInteger(idx)) {
        const val = getPayload(obj).getIndex(idx);
        return val !== undefined ? val : mkUndefined();
      } else {
        const jsArr = getPayload(obj);
        const ownVal = jsArr.getProperty(propName);
        if (ownVal !== undefined) {
          return ownVal;
        } else {
          return interp._lookupBuiltinPrototype(
            interp.builtinPrototypes.arrayPrototype,
            propName,
          );
        }
      }
    }
  } else if (isString(obj)) {
    if (propName === "length") {
      return mkSmi(getPayload(obj).length);
    } else {
      const idx = Number(propName);
      if (Number.isInteger(idx)) {
        const ch = getPayload(obj)[idx];
        return ch !== undefined ? mkString(ch) : mkUndefined();
      } else {
        return interp._lookupBuiltinPrototype(
          interp.builtinPrototypes.stringPrototype,
          propName,
        );
      }
    }
  } else if (isRegex(obj)) {
    const rv = getPayload(obj);
    const regexProp = getRegexProperty(propName, rv);
    if (regexProp !== null) {
      return regexProp;
    } else {
      return interp._lookupBuiltinPrototype(
        interp.builtinPrototypes.regexPrototype,
        propName,
      );
    }
  } else if (isGenerator(obj)) {
    return handleGeneratorProp(interp, obj, propName);
  } else if (isPromise(obj)) {
    return handlePromiseProp(interp, obj, propName);
  } else if (isFunction(obj)) {
    const fn = getPayload(obj);
    if (fn.properties && fn.properties[propName]) {
      return fn.properties[propName];
    } else if (propName === "call" || propName === "apply" || propName === "bind") {
      return makeFunctionMethod(obj, propName);
    } else if (propName === "name") {
      return mkString(fn.name || "");
    } else if (propName === "length") {
      return mkSmi(
        typeof fn.paramCount === "number"
          ? fn.paramCount
          : fn.compiled && typeof fn.compiled.paramCount === "number"
            ? fn.compiled.paramCount
            : 0,
      );
    } else if (propName === "prototype") {
      if (!fn.prototypeObj) {
        fn.prototypeObj = createJSObject();
        fn.prototypeObj.constructorRef = fn;
      }
      return mkObject(fn.prototypeObj);
    } else {
      return mkUndefined();
    }
  } else if (isSmi(obj) || isDouble(obj)) {
    return interp._lookupBuiltinPrototype(
      interp.builtinPrototypes.numberPrototype,
      propName,
    );
  } else if (isBool(obj)) {
    return interp._lookupBuiltinPrototype(
      interp.builtinPrototypes.booleanPrototype,
      propName,
    );
  } else {
    return mkUndefined();
  }
}

function handleGeneratorProp(
  interp: InterpreterLike,
  obj: GeneratorValue,
  propName: string,
): TaggedValue {
  const gen = getPayload(obj);
  if (propName === "next") {
    return mkFunction({
      name: "next",
      call: (args: TaggedValue[]) => {
        if (gen.state === GEN_COMPLETED)
          return createIteratorResult(mkUndefined(), true);
        if (gen.state === GEN_NEWBORN || gen.state === GEN_SUSPENDED) {
          const wasNewborn = gen.state === GEN_NEWBORN;
          if (args.length > 0 && !wasNewborn) gen.frame.acc = args[0];
          return runGeneratorFrame(interp, gen);
        }
        return createIteratorResult(mkUndefined(), true);
      },
      compiled: null,
    });
  } else if (propName === "return") {
    return mkFunction({
      name: "return",
      call: (args: TaggedValue[]) => {
        gen.state = GEN_COMPLETED;
        return createIteratorResult(
          args.length > 0 ? args[0] : mkUndefined(),
          true,
        );
      },
      compiled: null,
    });
  } else if (propName === "throw") {
    return mkFunction({
      name: "Generator.throw",
      call: (args: TaggedValue[]) => {
        const error = (args[0] === undefined ? mkUndefined() : args[0]);
        if (gen.state === GEN_COMPLETED || gen.state === GEN_NEWBORN) {
          gen.state = GEN_COMPLETED;
          throw new RegisterException(error);
        }
        if (
          gen.frame.exceptionHandlers &&
          gen.frame.exceptionHandlers.length > 0
        ) {
          const handler = gen.frame.exceptionHandlers.pop() as { catchPC: number };
          gen.frame.acc = error;
          gen.frame.pc = handler.catchPC;
          return runGeneratorFrame(interp, gen);
        }
        gen.state = GEN_COMPLETED;
        throw new RegisterException(error);
      },
      compiled: null,
    });
  } else {
    return mkUndefined();
  }
}

function handlePromiseProp(
  interp: InterpreterLike,
  obj: PromiseValue,
  propName: string,
): TaggedValue {
  const p = getPayload(obj);
  if (propName === "then") {
    return mkFunction({
      name: "Promise.prototype.then",
      call: (args: TaggedValue[], receiver: TaggedValue | null | undefined, interpreter: InterpreterLike) => {
        return promiseThen(
          interpreter,
          receiver || obj,
          (args[0] === undefined ? mkUndefined() : args[0]),
          (args[1] === undefined ? mkUndefined() : args[1]),
        );
      },
      compiled: null,
    });
  } else if (propName === "catch") {
    return mkFunction({
      name: "Promise.prototype.catch",
      call: (args: TaggedValue[], receiver: TaggedValue | null | undefined, interpreter: InterpreterLike) => {
        return promiseThen(
          interpreter,
          receiver || obj,
          mkUndefined(),
          (args[0] === undefined ? mkUndefined() : args[0]),
        );
      },
      compiled: null,
    });
  } else if (propName === "finally") {
    return mkFunction({
      name: "Promise.prototype.finally",
      call: (args: TaggedValue[], receiver: TaggedValue | null | undefined, interpreter: InterpreterLike) => {
        const { capability, value } = mkPromiseCapability(
          interpreter.microtaskQueue,
        );
        const callback = args[0];
        p.addReaction((state: string, result: TaggedValue) => {
          try {
            if (isFunction(callback))
              interpreter.callFunctionValue(callback, [], mkUndefined());
            if (state === PROMISE_FULFILLED) capability.resolve(result);
            else capability.reject(result);
          } catch (e) {
            const thrown = e instanceof Error ? e : String(e);
            capability.reject(interpreter.exceptionToValue(thrown));
          }
        });
        return value;
      },
      compiled: null,
    });
  } else if (propName === "state") {
    return mkString(p.state);
  } else {
    return mkUndefined();
  }
}

export function handleStaProp(
  interp: InterpreterLike,
  frame: RegisterFrame,
  operands: OperandList,
  compiledFn: CompiledFunctionLike,
  funcName: string | null | undefined,
): void {
  const objReg = operands[0];
  const propNameIdx = operands[1];
  const fbSlotIdx = operands[2];
  const obj = frame.getReg(objReg);
  const propName = constantPropertyName(compiledFn, propNameIdx);
  const value = frame.acc;

  throwIfNullish(obj, propName, true);

  if (isJSProxyValue(obj)) {
    runtimeSetProperty(obj, propName, value, interp);
    return;
  }

  if (isObject(obj)) {
    const jsObj = getPayload(obj);

    if (jsObj._frozen) return;
    if (
      (jsObj._sealed || jsObj._nonExtensible) &&
      !jsObj.hiddenClass.lookupProperty(propName)
    )
      return;

    const setAccDesc = jsObj.hiddenClass.lookupProperty(propName);
    if (setAccDesc && setAccDesc.kind === "accessor") {
      const pair = jsObj.storedProperty(propName);
      if (pair instanceof AccessorPair && pair.set) {
        interp.callFunctionValue(pair.set, [value], obj);
      }
      return;
    }
    if (!setAccDesc && jsObj.prototype) {
      const protoAcc = jsObj.lookupPrototypeChain(propName);
      if (
        protoAcc.found &&
        protoAcc.descriptor &&
        protoAcc.descriptor.kind === "accessor"
      ) {
        const pair = protoAcc.value;
        if (pair instanceof AccessorPair && pair.set) {
          interp.callFunctionValue(pair.set, [value], obj);
        }
        return;
      }
    }

    const icKey = compiledFn.getICKey(funcName, fbSlotIdx);
    const ic = interp.icManager.getOrCreate(icKey);
    ic.lookupForWrite(jsObj, propName, value);

    const slot = compiledFn.feedbackVector
      ? compiledFn.feedbackVector.getSlot(fbSlotIdx)
      : null;
    if (slot) {
      recordPropertyFeedback(slot, jsObj, propName);
    }
  } else if (isArray(obj)) {
    const jsArr = getPayload(obj);
    if (propName === "length") {
      jsArr.setLength(toNumber(value));
    } else {
      const idx = Number(propName);
      if (Number.isInteger(idx) && idx >= 0) {
        jsArr.setIndex(idx, value);
      } else {
        jsArr.setProperty(propName, value);
      }
    }
  } else if (isFunction(obj)) {
    const fn = getPayload(obj);
    if (!fn.properties) fn.properties = {};
    fn.properties[propName] = value;
    if (propName === "prototype" && isObject(value)) {
      fn.prototypeObj = getPayload(value);
    }
  } else if (isRegex(obj) && propName === "lastIndex") {
    getPayload(obj).lastIndex = toNumber(value);
  }
}

export function handleLdaIndex(
  interp: InterpreterLike,
  frame: RegisterFrame,
  operands: OperandList,
  compiledFn: CompiledFunctionLike,
  funcName: string | null | undefined,
): TaggedValue {
  const objReg = operands[0];
  const idxReg = operands[1];
  const fbSlotIdx_idx = operands.length > 2 ? operands[2] : -1;
  const obj = frame.getReg(objReg);
  const index = frame.getReg(idxReg);

  throwIfNullishKey(obj, index);

  if (isSymbol(index)) {
    return runtimeGetProperty(obj, index, interp);
  }

  if (isJSProxyValue(obj)) {
    const key = isString(index) ? getPayload(index) : toDisplayString(index);
    return runtimeGetProperty(obj, key, interp);
  }

  if (fbSlotIdx_idx >= 0 && compiledFn.feedbackVector) {
    const slot = compiledFn.feedbackVector.getSlot(fbSlotIdx_idx);
    if (slot)
      slot.recordArrayAccess(
        isArray(obj),
        isSmi(index),
        isArray(obj) ? getPayload(obj).getElementsKind() : null,
      );
  }

  if (isArray(obj)) {
    const idx = toNumber(index);
    const key = isString(index) ? getPayload(index) : toDisplayString(index);
    const icKey = compiledFn.getICKey(
      funcName,
      fbSlotIdx_idx >= 0 ? fbSlotIdx_idx : 0,
    );
    const ic = interp.icManager.getOrCreate(icKey);
    const result = Number.isInteger(idx)
      ? ic.lookupElement(getPayload(obj), idx)
      : { value: runtimeGetProperty(obj, key, interp) };
    const resultValue = result.value;
    return resultValue !== undefined &&
      !(typeof resultValue === "object" && resultValue instanceof AccessorPair)
      ? resultValue
      : mkUndefined();
  } else if (isString(obj) && isNumber(index)) {
    const idx = toNumber(index);
    const ch = getPayload(obj)[idx];
    return ch !== undefined ? mkString(ch) : mkUndefined();
  } else if (isObject(obj)) {
    const key = isString(index) ? getPayload(index) : toDisplayString(index);
    return runtimeGetProperty(obj, key, interp);
  } else {
    return mkUndefined();
  }
}

export function handleStaIndex(
  interp: InterpreterLike,
  frame: RegisterFrame,
  operands: OperandList,
  compiledFn: CompiledFunctionLike,
  funcName: string | null | undefined,
): void {
  const objReg = operands[0];
  const idxReg = operands[1];
  const fbSlotIdx_si = operands.length > 2 ? operands[2] : -1;
  const obj = frame.getReg(objReg);
  const index = frame.getReg(idxReg);
  const value = frame.acc;

  throwIfNullishKey(obj, index, true);

  if (isSymbol(index)) {
    runtimeSetProperty(obj, index, value, interp);
    return;
  }

  if (isJSProxyValue(obj)) {
    const key = isString(index) ? getPayload(index) : toDisplayString(index);
    runtimeSetProperty(obj, key, value, interp);
    return;
  }

  if (fbSlotIdx_si >= 0 && compiledFn.feedbackVector) {
    const slot = compiledFn.feedbackVector.getSlot(fbSlotIdx_si);
    if (slot)
      slot.recordArrayAccess(
        isArray(obj),
        isSmi(index),
        isArray(obj) ? getPayload(obj).getElementsKind() : null,
      );
  }

  if (isArray(obj)) {
    const idx = toNumber(index);
    if (Number.isInteger(idx)) {
      const icKey = compiledFn.getICKey(
        funcName,
        fbSlotIdx_si >= 0 ? fbSlotIdx_si : 0,
      );
      const ic = interp.icManager.getOrCreate(icKey);
      ic.lookupElementForWrite(getPayload(obj), idx, value);
    } else {
      const key = isString(index) ? getPayload(index) : toDisplayString(index);
      runtimeSetProperty(obj, key, value, interp);
    }
  } else if (isObject(obj)) {
    const key = isString(index) ? getPayload(index) : toDisplayString(index);
    runtimeSetProperty(obj, key, value, interp);
  }
}

export function handleNew(
  interp: InterpreterLike,
  frame: RegisterFrame,
  operands: OperandList,
  compiledFn: CompiledFunctionLike,
): TaggedValue {
  const funcReg = operands[0];
  const firstArgReg = operands[1];
  const argCount = operands[2];

  const callee = frame.getReg(funcReg);
  const args = [];
  for (let i = 0; i < argCount; i++) {
    args.push(frame.getReg(firstArgReg + i));
  }

  if (isFunction(callee)) {
    const fn = getPayload(callee);
    if (fn.construct) {
      return fn.construct(args);
    } else if (fn.compiled) {
      if (fn.compiled) interp.initFeedbackVector(fn.compiled);
      const stub = !fn.closure
        ? interp.getConstructorStub(fn.compiled, fn)
        : null;
      if (stub) {
        return stub(args);
      } else {
        const newObj = createJSObject();
        if (!fn.prototypeObj) {
          fn.prototypeObj = createJSObject();
          fn.prototypeObj.constructorRef = fn;
        }
        newObj.setPrototype(fn.prototypeObj);
        presizeInstanceSlots(newObj, fn);
        const thisVal = mkObject(newObj);
        let returnVal;
        if (fn.closure) {
          interp.initFeedbackVector(fn.compiled);
          const ctorFrame = new RegisterFrame(
            fn.compiled,
            args,
            thisVal,
            fn.closure,
          );
          returnVal = interp.runFrame(ctorFrame);
        } else {
          returnVal = interp.execute(fn.compiled, args, thisVal);
        }
        recordConstruction(fn, newObj);
        return isObject(returnVal) ? returnVal : thisVal;
      }
    } else {
      throw new VMTypeError(`${toDisplayString(callee)} is not a constructor`);
    }
  } else {
    throw new VMTypeError(`${toDisplayString(callee)} is not a constructor`);
  }
}

export function handleDefineAccessor(
  interp: InterpreterLike,
  frame: RegisterFrame,
  operands: OperandList,
  compiledFn: CompiledFunctionLike,
): void {
  const daObjReg = operands[0];
  const daPropIdx = operands[1];
  const daGetterReg = operands[2];
  const daSetterReg = operands[3];
  const daObj = frame.getReg(daObjReg);
  if (isObject(daObj)) {
    const jsObj = getPayload(daObj);
    const propName = constantPropertyName(compiledFn, daPropIdx);
    const getter = daGetterReg >= 0 ? frame.getReg(daGetterReg) : null;
    const setter = daSetterReg >= 0 ? frame.getReg(daSetterReg) : null;
    const existingDesc = jsObj.hiddenClass.lookupProperty(propName);
    if (existingDesc && existingDesc.kind === "accessor") {
      const existingPair = jsObj.storedProperty(propName);
      if (existingPair instanceof AccessorPair) {
        if (getter) existingPair.get = getter;
        if (setter) existingPair.set = setter;
      }
    } else {
      const pair = new AccessorPair(
        getter as TaggedValue | undefined,
        setter as TaggedValue | undefined,
      );
      jsObj.defineProperty(propName, {
        kind: "accessor",
        writable: false,
        enumerable: true,
        configurable: true,
        value: pair,
      });
    }
  }
}

export function handleInstanceof(
  interp: InterpreterLike,
  frame: RegisterFrame,
  left: TaggedValue,
  right: TaggedValue,
): TaggedValue {
  let result = false;
  if (isFunction(right)) {
    const fn = getPayload(right);
    const ctorName = fn.name;
    if (ctorName === "Array") {
      result = isArray(left);
    } else if (ctorName === "Function") {
      result = isFunction(left);
    } else if (ctorName === "Object") {
      result = isObject(left) || isArray(left) || isFunction(left);
    } else if (fn.isErrorConstructor && isObject(left)) {
      const obj = getPayload(left);
      const flag = obj.getProperty("__isError__");
      if (flag && getPayload(flag)) {
        if (ctorName === "Error") {
          result = true;
        } else {
          const nm = obj.getProperty("name");
          result = nm !== undefined && getPayload(nm) === ctorName;
        }
      }
    } else if (isObject(left) && fn.prototypeObj) {
      let proto = getPayload(left).prototype;
      while (proto) {
        if (proto === fn.prototypeObj) {
          result = true;
          break;
        }
        proto = proto.prototype;
      }
    }
  }
  return mkBool(result);
}

export function handleIn(
  interp: InterpreterLike,
  frame: RegisterFrame,
  left: TaggedValue,
  right: TaggedValue,
): TaggedValue {
  let result = false;
  if (isSymbol(left)) {
    result = runtimeHasProperty(right, left, interp);
  } else if (isObject(right)) {
    const key = isString(left) ? getPayload(left) : toDisplayString(left);
    result = runtimeHasProperty(right, key, interp);
  } else if (isArray(right)) {
    const arr = getPayload(right);
    if (isString(left)) {
      const key = getPayload(left);
      if (key === "length") {
        result = true;
      } else {
        const idx = Number(key);
        if (Number.isInteger(idx) && idx >= 0 && idx < arr.getLength()) {
          result = true;
        } else {
          result = arr.getProperty(key) !== undefined;
        }
      }
    } else {
      const idx = toNumber(left);
      result = Number.isInteger(idx) && idx >= 0 && idx < arr.getLength();
    }
  }
  return mkBool(result);
}

export function handleDeleteProp(
  interp: InterpreterLike,
  frame: RegisterFrame,
  operands: OperandList,
  compiledFn: CompiledFunctionLike,
): TaggedValue {
  const objReg = operands[0];
  const propNameIdx = operands[1];
  const keyReg = operands.length > 2 ? operands[2] : -1;
  const obj = frame.getReg(objReg);
  var propName;
  if (keyReg >= 0) {
    propName = toDisplayString(frame.getReg(keyReg));
  } else {
    propName = constantPropertyName(compiledFn, propNameIdx);
  }
  if (isObject(obj)) {
    runtimeDeleteProperty(obj, propName, interp);
  }
  return mkBool(true);
}
