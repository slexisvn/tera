import * as bytecode from "../../bytecode/register/ops/bytecode.js";
import { isInsideWasmExecution } from "../wasm/codegen.js";
import { constantString } from "../builder/feedback-utils.js";
import { applyBinaryOverload, applyRelational, applyUnaryOverload, type RelationalOverload } from "../../runtime/operators.js";

const CMP_METHOD: readonly RelationalOverload[] = ["lt", "gt", "le", "ge"];
import { forInKeys } from "../../runtime/enumerate.js";

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
  toNumber,
  toBool,
  toString,
  toPrimitive,
  abstractRelational,
  toDisplayString,
  typeOf,
  getPayload,
  getTag,
  pinHeapSlot,
  abstractLooseEqual,
  type TaggedValue,
  stringCharAt,
} from "../../core/value/index.js";

import { createJSObject, createJSArray } from "../../objects/heap/factory.js";
import { AccessorPair } from "../../objects/heap/js-object.js";
import { UpvalueCell } from "../../runtime/intrinsics/environment.js";
import {
  isJSProxyValue,
  runtimeDeleteProperty,
  runtimeGetProperty,
  runtimeHasProperty,
  runtimeSetProperty,
} from "../../objects/exotic/proxy-ops.js";

export type BaselineInterpreter = {
  globalCells: {
    get(name: string): { read(): TaggedValue | undefined; writeCount: number } | undefined;
    write(name: string, value: TaggedValue): void;
  };
  icManager: {
    getOrCreate(key: string): {
      lookup(object: object, property: string): { hit: boolean; value: TaggedValue | AccessorPair | undefined };
      lookupForWrite(object: object, property: string, value: TaggedValue): void;
      lookupElement(object: object, index: number): { value: TaggedValue | AccessorPair | undefined };
      lookupElementForWrite(object: object, index: number, value: TaggedValue): void;
      lookupCall(callee: object, argc: number, receiver: number | null): void;
    };
  };
  builtinPrototypes: Record<string, {
    getProperty(name: string): TaggedValue | undefined;
    lookupPrototypeChain(name: string): { found: boolean; value?: TaggedValue | AccessorPair };
  }>;
  _lookupBuiltinPrototype(proto: object, propName: string): TaggedValue;
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
  tieringPolicy?: { jitThreshold: number } | null;
  jitEngine?: { optimizeFunction?: (fn: bytecode.RegisterCompiledFunction) => void } | null;
  baselineFrames?: BaselineFrameRoots[];
};

export type BaselineFrameRoots = { registers: TaggedValue[] };

const MAX_CALL_DEPTH = 1000;
let globalCallDepth = 0;

type PropertyCacheEntry = {
  hiddenClassId: number;
  version: number;
  offset: number;
};

type GlobalCacheEntry = {
  cell: { read(): TaggedValue | undefined; writeCount: number };
  writeCount: number;
  value: TaggedValue;
};

type ReceiverInfo = {
  receiver: TaggedValue;
  receiverMapId: number | null;
  receiverMapVersion: number | null;
} | null;

type BaselineCompiledMetadata = bytecode.RegisterCompiledFunction & {
  hasConstructorCalls?: boolean;
  hasMethodCalls?: boolean;
};
type BaselineCall0 = NonNullable<bytecode.BaselineCode["_call0"]>;
type BaselineCall1 = NonNullable<bytecode.BaselineCode["_call1"]>;
type BaselineCall2 = NonNullable<bytecode.BaselineCode["_call2"]>;
type BaselineCall3 = NonNullable<bytecode.BaselineCode["_call3"]>;

function constantCompiledFunction(
  constants: bytecode.RegisterConstant[],
  index: number,
): bytecode.RegisterCompiledFunction {
  const value = constants[index];
  if (!(value instanceof bytecode.RegisterCompiledFunction)) {
    throw new Error(`Expected function constant at index ${index}`);
  }
  return value;
}

function constantRegExp(
  constants: bytecode.RegisterConstant[],
  index: number,
): { pattern: string; flags: string } {
  const value = constants[index];
  if (
    !value ||
    typeof value !== "object" ||
    !("pattern" in value) ||
    typeof value.pattern !== "string" ||
    !("flags" in value) ||
    typeof value.flags !== "string"
  ) {
    throw new Error(`Expected regex constant at index ${index}`);
  }
  const pattern = value.pattern;
  const flags = value.flags;
  return { pattern, flags };
}

function isConstructorLike(fn: {
  compiled?: { isClassConstructor?: boolean; simpleConstructorInfo?: unknown } | null;
  prototypeObj?: unknown;
  constructorOf?: unknown;
}): boolean {
  return Boolean(
    fn.compiled &&
      (fn.compiled.isClassConstructor ||
        fn.prototypeObj ||
        fn.compiled.simpleConstructorInfo ||
        fn.constructorOf),
  );
}

export class BaselineRuntime {
  cf: bytecode.RegisterCompiledFunction;
  interp: BaselineInterpreter;
  consts: bytecode.RegisterConstant[];
  u: TaggedValue;
  n: TaggedValue;
  t: TaggedValue;
  f: TaggedValue;
  loadCaches: Array<PropertyCacheEntry | undefined>;
  storeCaches: Array<PropertyCacheEntry | undefined>;
  constValueCache: Array<TaggedValue | undefined>;
  globalCaches: Array<GlobalCacheEntry | null | undefined>;

  constructor(compiledFn: bytecode.RegisterCompiledFunction, interpreter: BaselineInterpreter) {
    this.cf = compiledFn;
    this.interp = interpreter;
    this.consts = compiledFn.constants;
    this.u = mkUndefined();
    this.n = mkNull();
    this.t = mkBool(true);
    this.f = mkBool(false);
    this.loadCaches = [];
    this.storeCaches = [];
    this.constValueCache = [];
    this.globalCaches = [];
  }

  get fv() {
    return this.cf.feedbackVector;
  }

  wc(idx: number) {
    const c = this.consts[idx];
    if (typeof c === "number") {
      return mkNumber(c);
    }
    if (typeof c === "string") return mkString(c);
    if (typeof c === "boolean") return mkBool(c);
    if (c === null) return this.n;
    if (c === undefined) return this.u;
    if (c instanceof bytecode.RegisterCompiledFunction) {
      return mkFunction({
        name: c.name ?? undefined,
        compiled: c,
        closure: null,
      });
    }
    return this.u;
  }

  c(idx: number) {
    let val = this.constValueCache[idx];
    if (val === undefined) {
      val = this.wc(idx);
      this.constValueCache[idx] = val;
      pinHeapSlot(val);
    }
    return val;
  }

  lg(nameIdx: number) {
    const name = constantString(this.consts, nameIdx);
    const cached = this.globalCaches[nameIdx];
    if (cached && cached.cell.writeCount === cached.writeCount)
      return cached.value;
    const cell = this.interp.globalCells.get(name);
    const val = cell ? cell.read() : undefined;
    if (val === undefined) {
      throw new Error(`ReferenceError: ${name} is not defined`);
    }
    if (cell)
      this.globalCaches[nameIdx] = {
        cell,
        writeCount: cell.writeCount,
        value: val,
      };
    return val;
  }

  sg(nameIdx: number, val: TaggedValue) {
    const name = constantString(this.consts, nameIdx);
    this.globalCaches[nameIdx] = null;
    this.interp.globalCells.write(name, val);
  }

  gp(obj: TaggedValue, nameIdx: number, fbSlot: number) {
    const propName = constantString(this.consts, nameIdx);
    if (isJSProxyValue(obj)) {
      return runtimeGetProperty(obj, propName, this.interp);
    }
    if (isObject(obj)) {
      const jsObj = getPayload(obj);
      const ownDesc = jsObj.hiddenClass.lookupProperty(propName);
      if (ownDesc && ownDesc.kind === "accessor") {
        return runtimeGetProperty(obj, propName, this.interp);
      }
      if (!ownDesc && jsObj.prototype) {
        const protoResult = jsObj.lookupPrototypeChain(propName);
        if (
          protoResult.found &&
          protoResult.descriptor &&
          protoResult.descriptor.kind === "accessor"
        ) {
          return runtimeGetProperty(obj, propName, this.interp);
        }
      }
      const cached = this.loadCaches[fbSlot];
      if (
        cached &&
        jsObj.hiddenClass.id === cached.hiddenClassId &&
        jsObj.hiddenClass.version === cached.version &&
        !jsObj.hiddenClass.isDeprecated
      ) {
        if (cached.offset < 10) {
          const slotValue = jsObj.slots[cached.offset];
          const val = typeof slotValue === "number" ? slotValue : undefined;
          return val !== undefined ? val : this.u;
        }
        const overflowValue = jsObj.overflowProperties?.get(propName);
        const val = typeof overflowValue === "number" ? overflowValue : undefined;
        return val !== undefined ? val : this.u;
      }
      const icKey = this.cf.getICKey(this.cf.name, fbSlot);
      const ic = this.interp.icManager.getOrCreate(icKey);
      const result = ic.lookup(jsObj, propName);

      if (this.fv) {
        const slot = this.fv.getSlot(fbSlot);
        if (slot) {
          const info = jsObj.hiddenClass.lookupProperty(propName);
          if (info && info.kind !== "accessor") {
            slot.recordPropertyAccess(
              jsObj.hiddenClass.id,
              info.offset,
              jsObj.hiddenClass.version,
              0,
            );
            this.loadCaches[fbSlot] = {
              hiddenClassId: jsObj.hiddenClass.id,
              version: jsObj.hiddenClass.version,
              offset: info.offset,
            };
          } else if (!info && jsObj.prototype) {
            const protoResult = jsObj.lookupPrototypeChain(propName);
            if (protoResult.found && protoResult.descriptor && protoResult.descriptor.kind !== "accessor") {
              slot.recordPropertyAccess(
                jsObj.hiddenClass.id,
                protoResult.descriptor.offset,
                jsObj.hiddenClass.version,
                protoResult.depth,
              );
            }
          }
        }
      }

      if (result.hit && typeof result.value === "number") return result.value;
      return runtimeGetProperty(obj, propName, this.interp);
    }
    if (isArray(obj)) {
      const arr = getPayload(obj);
      if (propName === "length") return mkSmi(arr.getLength());
      const idx = Number(propName);
      if (Number.isInteger(idx)) {
        const val = arr.getIndex(idx);
        return val !== undefined ? val : this.u;
      }
      const ownVal = arr.getProperty(propName);
      if (ownVal !== undefined) return ownVal;
      return this.interp._lookupBuiltinPrototype(
        this.interp.builtinPrototypes.arrayPrototype,
        propName,
      );
    }
    if (isString(obj)) {
      if (propName === "length") return mkSmi(getPayload(obj).length);
      const idx = Number(propName);
      if (Number.isInteger(idx)) {
        const ch = stringCharAt(getPayload(obj), idx);
        return ch !== undefined ? mkString(ch) : this.u;
      }
      return this.interp._lookupBuiltinPrototype(
        this.interp.builtinPrototypes.stringPrototype,
        propName,
      );
    }
    if (isFunction(obj)) {
      const fn = getPayload(obj);
      if (fn.properties && fn.properties[propName] !== undefined) {
        return fn.properties[propName];
      }
      if (propName === "prototype") {
        if (!fn.prototypeObj) {
          fn.prototypeObj = createJSObject();
          fn.prototypeObj.constructorRef = fn;
        }
        return mkObject(fn.prototypeObj);
      }
      return this.u;
    }
    if (isNumber(obj)) {
      return this.interp._lookupBuiltinPrototype(
        this.interp.builtinPrototypes.numberPrototype,
        propName,
      );
    }
    if (isBool(obj)) {
      return this.interp._lookupBuiltinPrototype(
        this.interp.builtinPrototypes.booleanPrototype,
        propName,
      );
    }
    return this.u;
  }

  sp(obj: TaggedValue, nameIdx: number, val: TaggedValue, fbSlot: number) {
    const propName = constantString(this.consts, nameIdx);
    if (isJSProxyValue(obj)) {
      runtimeSetProperty(obj, propName, val, this.interp);
      return;
    }
    if (isObject(obj)) {
      const jsObj = getPayload(obj);
      const ownDesc = jsObj.hiddenClass.lookupProperty(propName);
      if (
        (ownDesc && ownDesc.kind === "accessor") ||
        (!ownDesc && jsObj.prototype)
      ) {
        runtimeSetProperty(obj, propName, val, this.interp);
        return;
      }
      const cached = this.storeCaches[fbSlot];
      if (
        cached &&
        jsObj.hiddenClass.id === cached.hiddenClassId &&
        jsObj.hiddenClass.version === cached.version &&
        !jsObj.hiddenClass.isDeprecated
      ) {
        if (cached.offset < 10) jsObj.slots[cached.offset] = val;
        else {
          if (!jsObj.overflowProperties) jsObj.overflowProperties = new Map();
          jsObj.overflowProperties.set(propName, val);
        }
        return;
      }
      const icKey = this.cf.getICKey(this.cf.name, fbSlot);
      const ic = this.interp.icManager.getOrCreate(icKey);
      ic.lookupForWrite(jsObj, propName, val);

      if (this.fv) {
        const slot = this.fv.getSlot(fbSlot);
        if (slot) {
          const info = jsObj.hiddenClass.lookupProperty(propName);
          if (info) {
            slot.recordPropertyAccess(
              jsObj.hiddenClass.id,
              info.offset,
              jsObj.hiddenClass.version,
              0,
            );
            this.storeCaches[fbSlot] = {
              hiddenClassId: jsObj.hiddenClass.id,
              version: jsObj.hiddenClass.version,
              offset: info.offset,
            };
          }
        }
      }
    }
  }

  enter(registers: TaggedValue[]): void {
    this.interp.baselineFrames?.push({ registers });
  }

  leave(): void {
    this.interp.baselineFrames?.pop();
  }

  gi(obj: TaggedValue, index: TaggedValue, fbSlot: number) {
    if (isJSProxyValue(obj)) {
      const key = isString(index) ? getPayload(index) : toDisplayString(index);
      return runtimeGetProperty(obj, key, this.interp);
    }
    if (this.fv) {
      const slot = this.fv.getSlot(fbSlot);
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
      const icKey = this.cf.getICKey(this.cf.name, fbSlot);
      const ic = this.interp.icManager.getOrCreate(icKey);
      const result = Number.isInteger(idx)
        ? ic.lookupElement(getPayload(obj), idx)
        : { value: runtimeGetProperty(obj, key, this.interp) };
      const val = result.value;
      return val !== undefined ? val : this.u;
    }
    if (isString(obj) && isSmi(index)) {
      const ch = getPayload(obj)[getPayload(index)];
      return ch !== undefined ? mkString(ch) : this.u;
    }
    if (isObject(obj)) {
      const key = isString(index) ? getPayload(index) : toDisplayString(index);
      return runtimeGetProperty(obj, key, this.interp);
    }
    return this.u;
  }

  si(obj: TaggedValue, index: TaggedValue, val: TaggedValue, fbSlot: number) {
    if (isJSProxyValue(obj)) {
      const key = isString(index) ? getPayload(index) : toDisplayString(index);
      runtimeSetProperty(obj, key, val, this.interp);
      return;
    }
    if (this.fv) {
      const slot = this.fv.getSlot(fbSlot);
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
        const icKey = this.cf.getICKey(this.cf.name, fbSlot);
        const ic = this.interp.icManager.getOrCreate(icKey);
        ic.lookupElementForWrite(getPayload(obj), idx, val);
        if (this.fv) {
          const slot = this.fv.getSlot(fbSlot);
          if (slot)
            slot.recordArrayAccess(
              true,
              true,
              getPayload(obj).getElementsKind(),
            );
        }
      } else {
        const key = isString(index)
          ? getPayload(index)
          : toDisplayString(index);
        runtimeSetProperty(obj, key, val, this.interp);
      }
    } else if (isObject(obj)) {
      const key = isString(index) ? getPayload(index) : toDisplayString(index);
      runtimeSetProperty(obj, key, val, this.interp);
    }
  }

  add(l: TaggedValue, r: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    if (isSmi(l) && isSmi(r)) {
      const res = getPayload(l) + getPayload(r);
      return res === (res | 0) ? mkSmi(res) : mkDouble(res);
    }
    if (isNumber(l) && isNumber(r)) return mkDouble(toNumber(l) + toNumber(r));
    const overloaded = applyBinaryOverload("add", l, r, this.interp);
    if (overloaded !== null) return overloaded;
    const lp = toPrimitive(l);
    const rp = toPrimitive(r);
    if (isString(lp) || isString(rp))
      return mkString(toString(lp) + toString(rp));
    return mkDouble(toNumber(lp) + toNumber(rp));
  }

  sub(l: TaggedValue, r: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    if (isSmi(l) && isSmi(r)) {
      const res = getPayload(l) - getPayload(r);
      return res === (res | 0) ? mkSmi(res) : mkDouble(res);
    }
    return applyBinaryOverload("sub", l, r, this.interp)
      ?? mkDouble(toNumber(l) - toNumber(r));
  }

  mul(l: TaggedValue, r: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    if (isSmi(l) && isSmi(r)) {
      const res = getPayload(l) * getPayload(r);
      return res === (res | 0) ? mkSmi(res) : mkDouble(res);
    }
    return applyBinaryOverload("mul", l, r, this.interp)
      ?? mkDouble(toNumber(l) * toNumber(r));
  }

  div(l: TaggedValue, r: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    const overloaded = applyBinaryOverload("div", l, r, this.interp);
    if (overloaded !== null) return overloaded;
    const res = toNumber(l) / toNumber(r);
    return Number.isInteger(res) && res === (res | 0)
      ? mkSmi(res)
      : mkDouble(res);
  }

  mod(l: TaggedValue, r: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    if (isSmi(l) && isSmi(r) && getPayload(r) !== 0)
      return mkSmi(getPayload(l) % getPayload(r));
    return mkDouble(toNumber(l) % toNumber(r));
  }

  eq(l: TaggedValue, r: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    if (isSmi(l) && isSmi(r)) return mkBool(getPayload(l) === getPayload(r));
    if (isNumber(l) && isNumber(r)) return mkBool(toNumber(l) === toNumber(r));
    if (isString(l) && isString(r))
      return mkBool(getPayload(l) === getPayload(r));
    if (isBool(l) && isBool(r)) return mkBool(getPayload(l) === getPayload(r));
    if (isNull(l) && isNull(r)) return this.t;
    if (isUndefined(l) && isUndefined(r)) return this.t;
    if ((isNull(l) || isUndefined(l)) && (isNull(r) || isUndefined(r)))
      return this.t;
    return this.f;
  }

  neq(l: TaggedValue, r: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    if (isSmi(l) && isSmi(r)) return mkBool(getPayload(l) !== getPayload(r));
    if (isNumber(l) && isNumber(r)) return mkBool(toNumber(l) !== toNumber(r));
    if (isString(l) && isString(r))
      return mkBool(getPayload(l) !== getPayload(r));
    if (isBool(l) && isBool(r)) return mkBool(getPayload(l) !== getPayload(r));
    if ((isNull(l) || isUndefined(l)) && (isNull(r) || isUndefined(r)))
      return this.f;
    return this.t;
  }

  cmp(l: TaggedValue, r: TaggedValue, op: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, l, r);
    let result;
    if (isNumber(l) && isNumber(r)) {
      const ln = toNumber(l),
        rn = toNumber(r);
      switch (op) {
        case 0:
          result = ln < rn;
          break;
        case 1:
          result = ln > rn;
          break;
        case 2:
          result = ln <= rn;
          break;
        case 3:
          result = ln >= rn;
          break;
      }
    } else if (isString(l) && isString(r)) {
      switch (op) {
        case 0:
          result = getPayload(l) < getPayload(r);
          break;
        case 1:
          result = getPayload(l) > getPayload(r);
          break;
        case 2:
          result = getPayload(l) <= getPayload(r);
          break;
        case 3:
          result = getPayload(l) >= getPayload(r);
          break;
      }
    } else {
      return applyRelational(CMP_METHOD[op as unknown as number]!, l, r, this.interp);
    }
    return mkBool(result === true);
  }

  not(val: TaggedValue, fbSlot: number) {
    if (fbSlot >= 0 && this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) slot.recordUnaryOp(getTag(val));
    }
    return mkBool(!toBool(val));
  }

  neg(val: TaggedValue, fbSlot: number) {
    if (fbSlot >= 0 && this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) slot.recordUnaryOp(getTag(val));
    }
    return applyUnaryOverload("neg", val, this.interp) ?? mkNumber(-toNumber(val));
  }

  typeofOp(val: TaggedValue) {
    return mkString(typeOf(val));
  }

  bitand(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    return mkSmi((toNumber(left) | 0) & (toNumber(right) | 0));
  }
  bitor(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    return mkSmi(toNumber(left) | 0 | (toNumber(right) | 0));
  }
  bitxor(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    return mkSmi((toNumber(left) | 0) ^ (toNumber(right) | 0));
  }
  shl(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    return mkSmi((toNumber(left) | 0) << (toNumber(right) & 0x1f));
  }
  shr(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    return mkSmi((toNumber(left) | 0) >> (toNumber(right) & 0x1f));
  }
  ushr(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    const result = (toNumber(left) | 0) >>> (toNumber(right) & 0x1f);
    return result === (result | 0) ? mkSmi(result) : mkDouble(result);
  }
  pow(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    const overloaded = applyBinaryOverload("pow", left, right, this.interp);
    if (overloaded !== null) return overloaded;
    const result = toNumber(left) ** toNumber(right);
    return Number.isInteger(result) && result === (result | 0)
      ? mkSmi(result)
      : mkDouble(result);
  }
  bitnot(val: TaggedValue, fbSlot: number) {
    if (fbSlot >= 0 && this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) slot.recordUnaryOp(getTag(val));
    }
    return mkSmi(~(toNumber(val) | 0));
  }
  instanceofOp(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    let result = false;
    if (isObject(left) && isFunction(right)) {
      const fn = getPayload(right);
      if (fn.prototypeObj) {
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
  inOp(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    this._recordBinaryFb(left, right, fbSlot);
    let result = false;
    if (isObject(right)) {
      const key = isString(left) ? getPayload(left) : toDisplayString(left);
      result = runtimeHasProperty(right, key, this.interp);
    } else if (isArray(right)) {
      const idx = toNumber(left);
      result =
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < getPayload(right).getLength();
    }
    return mkBool(result);
  }
  deleteProp(obj: TaggedValue, propNameIdx: number) {
    const propName = constantString(this.cf.constants, propNameIdx);
    if (isObject(obj)) {
      runtimeDeleteProperty(obj, propName, this.interp);
    }
    return mkBool(true);
  }
  _recordBinaryFb(left: TaggedValue, right: TaggedValue, fbSlot: number) {
    if (fbSlot >= 0 && this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) slot.recordBinaryOp(getTag(left), getTag(right));
    }
  }

  branch(fbSlot: number, taken: TaggedValue) {
    if (fbSlot >= 0 && this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) slot.recordBranch(toBool(taken));
    }
  }

  invokeCall(callee: TaggedValue, args: TaggedValue[], receiver: TaggedValue, fbSlot: number, receiverInfo: ReceiverInfo) {
    if (!isFunction(callee)) {
      return this.interp.callFunctionValue(callee, args, receiver);
    }
    if (isConstructorLike(getPayload(callee)) && isUndefined(receiver)) {
      return this.interp.callFunctionValue(callee, args, receiver);
    }
    if (++globalCallDepth > MAX_CALL_DEPTH) {
      globalCallDepth--;
      throw new RangeError("Maximum call stack size exceeded");
    }

    const fn = getPayload(callee);
    const icKey = this.cf.getICKey(this.cf.name, fbSlot);
    const ic = this.interp.icManager.getOrCreate(icKey);
    ic.lookupCall(fn, args.length, receiverInfo ? receiverInfo.receiverMapId : null);
    if (this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) {
        if (receiverInfo) {
          slot.recordCallTarget(
            fn.name || "<anonymous>",
            fn.compiled || null,
            args.length,
            receiverInfo.receiverMapId,
            receiverInfo.receiverMapVersion,
          );
        } else {
          slot.recordCallTarget(
            fn.name || "<anonymous>",
            fn.compiled || null,
            args.length,
          );
        }
      }
    }

    try {
      const result = this.interp.callFunctionValue(callee, args, receiver);

      if (this.fv) {
        const slot = this.fv.getSlot(fbSlot);
        if (slot && result) slot.recordReturnType(getTag(result));
      }

      return result;
    } finally {
      globalCallDepth--;
    }
  }

  invokeCall0(callee: TaggedValue, fbSlot: number) {
    const optimized = this.fastOptimizedCall(callee, []);
    if (optimized !== null) return optimized;
    const fast = this.fastBaselineCall(callee, 0);
    if (fast) return fast(this.u, this.interp);
    return this.invokeCall(callee, [], this.u, fbSlot, null);
  }

  invokeCall1(callee: TaggedValue, a0: TaggedValue, fbSlot: number) {
    const optimized = this.fastOptimizedCall(callee, [a0]);
    if (optimized !== null) return optimized;
    const fast = this.fastBaselineCall(callee, 1);
    if (fast) return fast(a0, this.u, this.interp);
    return this.invokeCall(callee, [a0], this.u, fbSlot, null);
  }

  invokeCall2(callee: TaggedValue, a0: TaggedValue, a1: TaggedValue, fbSlot: number) {
    const optimized = this.fastOptimizedCall(callee, [a0, a1]);
    if (optimized !== null) return optimized;
    const fast = this.fastBaselineCall(callee, 2);
    if (fast) return fast(a0, a1, this.u, this.interp);
    return this.invokeCall(callee, [a0, a1], this.u, fbSlot, null);
  }

  fastOptimizedCall(callee: TaggedValue, args: TaggedValue[]) {
    if (!isFunction(callee)) return null;
    const fn = getPayload(callee);
    if (isConstructorLike(fn)) return null;
    if (
      !fn.compiled ||
      fn.closure ||
      fn.compiled.disableOptimization ||
      !fn.compiled.optimizedCode
    )
      return null;
    if (this.hasConstructorCalls(fn.compiled)) return null;
    if (isInsideWasmExecution()) return null;
    return fn.compiled.optimizedCode(args, this.u, this.interp);
  }

  hasConstructorCalls(compiledFn: BaselineCompiledMetadata) {
    if (compiledFn.hasConstructorCalls !== undefined)
      return compiledFn.hasConstructorCalls;
    compiledFn.hasConstructorCalls = compiledFn.instructions.some(
      (instr) => instr.opcode === bytecode.ROP_NEW,
    );
    return compiledFn.hasConstructorCalls;
  }

  hasMethodCalls(compiledFn: BaselineCompiledMetadata) {
    if (compiledFn.hasMethodCalls !== undefined)
      return compiledFn.hasMethodCalls;
    compiledFn.hasMethodCalls = compiledFn.instructions.some(
      (instr) => instr.opcode === bytecode.ROP_CALL_METHOD,
    );
    return compiledFn.hasMethodCalls;
  }

  fastBaselineCall(
    callee: TaggedValue,
    argc: 0,
  ): BaselineCall0 | null;
  fastBaselineCall(
    callee: TaggedValue,
    argc: 1,
  ): BaselineCall1 | null;
  fastBaselineCall(
    callee: TaggedValue,
    argc: 2,
  ): BaselineCall2 | null;
  fastBaselineCall(
    callee: TaggedValue,
    argc: number,
  ): BaselineCall0 | BaselineCall1 | BaselineCall2 | BaselineCall3 | null;
  fastBaselineCall(
    callee: TaggedValue,
    argc: number,
  ): BaselineCall0 | BaselineCall1 | BaselineCall2 | BaselineCall3 | null {
    if (!isFunction(callee)) return null;
    const fn = getPayload(callee);
    if (isConstructorLike(fn)) return null;
    if (
      !fn.compiled ||
      fn.closure ||
      fn.compiled.disableOptimization ||
      !fn.compiled.baselineCode
    )
      return null;
    if (this.hasMethodCalls(fn.compiled)) return null;
    if (
      fn.compiled.optimizedCode &&
      !this.hasConstructorCalls(fn.compiled) &&
      !isInsideWasmExecution()
    )
      return null;
    fn.compiled.invocationCount = (fn.compiled.invocationCount || 0) + 1;
    if (
      this.interp.tieringPolicy &&
      fn.compiled.invocationCount === this.interp.tieringPolicy.jitThreshold &&
      !fn.compiled.optimizedCode &&
      !fn.compiled.disableOptimization &&
      this.interp.jitEngine &&
      typeof this.interp.jitEngine.optimizeFunction === "function"
    ) {
      this.interp.jitEngine.optimizeFunction(fn.compiled);
      if (fn.compiled.optimizedCode) {
        return null;
      }
    }
    switch (argc) {
      case 0:
        return fn.compiled.baselineCode._call0 || null;
      case 1:
        return fn.compiled.baselineCode._call1 || null;
      case 2:
        return fn.compiled.baselineCode._call2 || null;
      case 3:
        return fn.compiled.baselineCode._call3 || null;
      default:
        return null;
    }
  }

  callMethod(callee: TaggedValue, receiver: TaggedValue, args: TaggedValue[], fbSlot: number) {
    if (!isFunction(callee)) {
      return this.interp.callFunctionValue(callee, args, receiver);
    }

    const receiverMapId = isObject(receiver)
      ? getPayload(receiver).hiddenClass.id
      : null;
    const receiverMapVersion = isObject(receiver)
      ? getPayload(receiver).hiddenClass.version
      : null;
    return this.invokeCall(callee, args, receiver, fbSlot, {
      receiver,
      receiverMapId,
      receiverMapVersion,
    });
  }

  rcn(callee: TaggedValue, args: TaggedValue[], fbSlot: number) {
    if (this.fv && fbSlot >= 0 && isFunction(callee)) {
      const slot = this.fv.getSlot(fbSlot);
      const fn = getPayload(callee);
      if (slot)
        slot.recordCallTarget(
          fn.name || "<anonymous>",
          fn.compiled || null,
          args.length,
        );
    }
    return this.interp.constructFunctionValue(callee, args);
  }

  newObj() {
    return mkObject(createJSObject());
  }

  newArr(elements: TaggedValue[]) {
    return mkArray(createJSArray(elements));
  }

  rfb(fbSlot: number, l: TaggedValue, r: TaggedValue) {
    if (this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) slot.recordBinaryOp(getTag(l), getTag(r));
    }
  }

  toBool(v: TaggedValue) {
    return toBool(v);
  }

  looseEq(a: TaggedValue, b: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, a, b);
    return abstractLooseEqual(a, b) ? this.t : this.f;
  }

  looseNeq(a: TaggedValue, b: TaggedValue, fbSlot: number) {
    this.rfb(fbSlot, a, b);
    return abstractLooseEqual(a, b) ? this.f : this.t;
  }

  isNullish(v: TaggedValue) {
    return isNull(v) || isUndefined(v);
  }

  newRegex(constIdx: number) {
    const { pattern, flags } = constantRegExp(this.consts, constIdx);
    return mkRegex(new RegExp(pattern, flags));
  }

  getLength(obj: TaggedValue) {
    if (isArray(obj)) return mkSmi(getPayload(obj).getLength());
    if (isString(obj)) return mkSmi(getPayload(obj).length);
    return mkUndefined();
  }

  getKeys(obj: TaggedValue) {
    const keys = forInKeys(obj, this.interp);
    return mkArray(createJSArray(keys.map((key) => mkString(key))));
  }

  restArgs(registers: TaggedValue[], startReg: number, argCount: number) {
    const rest = [];
    for (let i = startReg; i < argCount; i++) {
      rest.push(registers[i] || this.u);
    }
    return mkArray(createJSArray(rest));
  }

  spreadArray(arr: TaggedValue) {
    if (isArray(arr)) {
      const payload = getPayload(arr);
    return payload.elements ? payload.elements.map((value) => value ?? this.u) : [];
    }
    return [];
  }

  copyProps(target: TaggedValue, source: TaggedValue) {
    if (isObject(target) && isObject(source)) {
      const tPayload = getPayload(target);
      const sPayload = getPayload(source);
      const keys = sPayload.hiddenClass.getEnumerablePropertyNames();
      for (const key of keys) {
        const val = sPayload.getProperty(key);
        if (val !== undefined) tPayload.setProperty(key, val);
      }
    }
    return target;
  }

  setComputedProp(obj: TaggedValue, key: TaggedValue, val: TaggedValue) {
    if (isObject(obj)) {
      const propName = toDisplayString(key);
      getPayload(obj).setProperty(propName, val);
    }
    return val;
  }

  callSpread(callee: TaggedValue, spreadArr: TaggedValue) {
    const args = this.spreadArray(spreadArr);
    return this.interp.callFunctionValue(callee, args, this.u);
  }

  arrayPush(arr: TaggedValue, val: TaggedValue) {
    if (isArray(arr)) {
      getPayload(arr).push(val);
    }
    return val;
  }

  closure(
    compiled: bytecode.RegisterCompiledFunction,
    registers: TaggedValue[],
    closureEnv: UpvalueCell[] | null,
    openUpvalues: Map<number, UpvalueCell>,
  ) {
    const upvalueCount = compiled.upvalues.length;
    const cells: UpvalueCell[] = [];
    for (let i = 0; i < upvalueCount; i++) {
      const uv = compiled.upvalues[i];
      if (!uv) {
        throw new Error(`Missing upvalue descriptor ${i}`);
      }
      if (uv.isLocal) {
        if (uv.index === undefined) {
          throw new Error(`Missing upvalue index ${i}`);
        }
        if (openUpvalues.has(uv.index)) {
          const existing = openUpvalues.get(uv.index);
          if (!existing) throw new Error(`Missing open upvalue ${uv.index}`);
          cells.push(existing);
        } else {
          const cell = new UpvalueCell({ locals: registers }, uv.index);
          openUpvalues.set(uv.index, cell);
          cells.push(cell);
        }
      } else {
        if (!closureEnv) {
          throw new Error("Missing closure environment");
        }
        if (uv.index === undefined) {
          throw new Error(`Missing upvalue index ${i}`);
        }
        const captured = closureEnv[uv.index];
        if (!captured) throw new Error(`Missing captured upvalue ${uv.index}`);
        cells.push(captured);
      }
    }
    return mkFunction({
      name: compiled.name ?? undefined,
      compiled,
      closure: null,
    });
  }
}

