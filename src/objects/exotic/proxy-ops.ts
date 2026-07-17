import {
  mkArray,
  mkBool,
  mkFunction,
  mkObject,
  mkSmi,
  mkString,
  mkUndefined,
  isArray,
  isBool,
  isDouble,
  isFunction,
  isObject,
  isSmi,
  isString,
  isSymbol,
  toBool,
  toDisplayString,
  toNumber,
  getPayload,
  isUndefined,
  strictEqual,
  getTag,
} from "../../core/value/index.js";
import type { RuntimeFunctionPayload, TaggedValue } from "../../core/value/index.js";
import { VMTypeError } from "../../core/errors/index.js";
import { AccessorPair } from "../heap/js-object.js";
import type { PropertyDescriptor } from "../maps/hidden-class.js";
import {
  createJSArray,
  createJSObject,
  createJSProxy,
} from "../heap/factory.js";
import { isJSProxyObject } from "./js-proxy.js";

function sameValue(a: TaggedValue, b: TaggedValue): boolean {
  const ta = getTag(a);
  const tb = getTag(b);
  if ((ta === "smi" || ta === "double") && (tb === "smi" || tb === "double")) {
    const va = getPayload(a) as number;
    const vb = getPayload(b) as number;
    if (Number.isNaN(va) && Number.isNaN(vb)) return true;
    if (va === 0 && vb === 0) return Object.is(va, vb);
    return va === vb;
  }
  return strictEqual(a, b);
}

function targetOwnDataInvariant(target: TaggedValue, propName: string) {
  if (!isObject(target)) return null;
  const tobj = objectPayload(target);
  const desc = tobj.hiddenClass.lookupProperty(propName);
  if (!desc || desc.configurable) return null;
  return { tobj, desc };
}

type InterpreterLike = {
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
};

type StoredValue = TaggedValue | AccessorPair | undefined;

type RuntimeHiddenClass = {
  lookupProperty(name: string): PropertyDescriptor | null;
  hasProperty(name: string): boolean;
};

type PrototypeLookupResult = {
  found: boolean;
  value: StoredValue;
  descriptor: PropertyDescriptor | null;
};

type RuntimeObject = {
  hiddenClass: RuntimeHiddenClass;
  slots: StoredValue[];
  overflowProperties: Map<string, StoredValue> | null;
  prototype: RuntimeObject | null;
  constructorRef?: TaggedValue | RuntimeFunctionPayload | null;
  setProperty(name: string, value: TaggedValue): boolean;
  defineProperty(
    name: string,
    descriptor: {
      kind?: "data" | "accessor";
      writable?: boolean;
      enumerable?: boolean;
      configurable?: boolean;
      value?: StoredValue;
    },
  ): boolean;
  deleteProperty(name: string): boolean;
  keys(): string[];
  lookupPrototypeChain(name: string): PrototypeLookupResult;
  getSymbolProperty(symbol: TaggedValue): TaggedValue | undefined;
  setSymbolProperty(symbol: TaggedValue, value: TaggedValue): void;
  deleteSymbolProperty(symbol: TaggedValue): boolean;
  hasSymbolProperty(symbol: TaggedValue): boolean;
};

type RuntimeArray = {
  elements: Array<TaggedValue | undefined>;
  getLength(): number;
  getIndex(index: number): TaggedValue | undefined;
  setIndex(index: number, value: TaggedValue): void;
  getProperty(name: string): TaggedValue | number | undefined;
  setProperty(name: string, value: TaggedValue): void;
  setLength(length: number): void;
  keys?: () => string[];
  getSymbolProperty(symbol: TaggedValue): TaggedValue | undefined;
  setSymbolProperty(symbol: TaggedValue, value: TaggedValue): void;
  hasSymbolProperty(symbol: TaggedValue): boolean;
};

type RuntimeProxy = {
  target: TaggedValue;
  handler: TaggedValue;
};

function objectPayload(value: TaggedValue): RuntimeObject {
  return getPayload(value) as RuntimeObject;
}

function arrayPayload(value: TaggedValue): RuntimeArray {
  return getPayload(value) as RuntimeArray;
}

function proxyPayload(value: TaggedValue): RuntimeProxy {
  return getPayload(value) as RuntimeProxy;
}

function functionPayload(value: TaggedValue): RuntimeFunctionPayload {
  return getPayload(value) as RuntimeFunctionPayload;
}

export function isJSProxyValue(value: TaggedValue): boolean {
  return isObject(value) && isJSProxyObject(getPayload(value));
}

export function createProxyValue(
  target: TaggedValue,
  handler: TaggedValue,
): TaggedValue {
  return mkObject(createJSProxy(target, handler));
}

function keyToString(key: string | TaggedValue): string {
  return typeof key === "string" ? key : toDisplayString(key);
}

function slotValue(
  obj: RuntimeObject,
  desc: PropertyDescriptor,
  key: string,
): StoredValue {
  if (desc.offset < obj.slots.length) return obj.slots[desc.offset];
  return obj.overflowProperties ? obj.overflowProperties.get(key) : undefined;
}

function taggedSlotValue(value: StoredValue): TaggedValue {
  return typeof value === "number" ? value : mkUndefined();
}

export function runtimeApply(
  proxyValue: TaggedValue,
  thisArg: TaggedValue,
  args: TaggedValue[],
  interpreter: InterpreterLike,
): TaggedValue {
  const proxy = proxyPayload(proxyValue);
  const trap = getTrap(proxy, "apply", interpreter);
  if (trap) {
    return interpreter.callFunctionValue(
      trap,
      [proxy.target, thisArg, mkArray(createJSArray(args.slice()))],
      mkUndefined(),
    );
  }
  return interpreter.callFunctionValue(proxy.target, args, thisArg);
}

export function runtimeConstruct(
  proxyValue: TaggedValue,
  args: TaggedValue[],
  interpreter: InterpreterLike,
): TaggedValue {
  const proxy = proxyPayload(proxyValue);
  const trap = getTrap(proxy, "construct", interpreter);
  if (trap) {
    return interpreter.callFunctionValue(
      trap,
      [proxy.target, mkArray(createJSArray(args.slice())), proxy.target],
      mkUndefined(),
    );
  }
  return interpreter.constructFunctionValue(proxy.target, args);
}

function getTrap(
  proxy: RuntimeProxy,
  trapName: string,
  interpreter?: InterpreterLike | null,
): TaggedValue | null {
  const trap = runtimeGetProperty(
    proxy.handler,
    trapName,
    interpreter,
    proxy.handler,
  );
  return isFunction(trap) ? trap : null;
}

function ordinaryGetObject(
  taggedReceiver: TaggedValue,
  obj: RuntimeObject,
  key: string,
  interpreter?: InterpreterLike | null,
): TaggedValue {
  const desc = obj.hiddenClass.lookupProperty(key);
  if (desc) {
    const value = slotValue(obj, desc, key);
    if (desc.kind === "accessor") {
      if (value instanceof AccessorPair && value.get && interpreter) {
        return interpreter.callFunctionValue(value.get, [], taggedReceiver);
      }
      return mkUndefined();
    }
    return taggedSlotValue(value);
  }
  if (obj.prototype) {
    const protoResult = obj.lookupPrototypeChain(key);
    if (protoResult.found && protoResult.descriptor) {
      if (protoResult.descriptor.kind === "accessor") {
        const pair = protoResult.value;
        if (pair instanceof AccessorPair && pair.get && interpreter) {
          return interpreter.callFunctionValue(pair.get, [], taggedReceiver);
        }
        return mkUndefined();
      }
      return taggedSlotValue(protoResult.value);
    }
  }
  return mkUndefined();
}

function ordinarySetObject(
  taggedReceiver: TaggedValue,
  obj: RuntimeObject,
  key: string,
  value: TaggedValue,
  interpreter?: InterpreterLike | null,
): boolean {
  const desc = obj.hiddenClass.lookupProperty(key);
  if (desc && desc.kind === "accessor") {
    const pair = slotValue(obj, desc, key);
    if (pair instanceof AccessorPair && pair.set && interpreter) {
      interpreter.callFunctionValue(pair.set, [value], taggedReceiver);
      return true;
    }
    return false;
  }
  if (!desc && obj.prototype) {
    const protoResult = obj.lookupPrototypeChain(key);
    if (
      protoResult.found &&
      protoResult.descriptor &&
      protoResult.descriptor.kind === "accessor"
    ) {
      const pair = protoResult.value;
      if (pair instanceof AccessorPair && pair.set && interpreter) {
        interpreter.callFunctionValue(pair.set, [value], taggedReceiver);
        return true;
      }
      return false;
    }
  }
  return obj.setProperty(key, value);
}

function ordinaryGetDescriptorObject(
  obj: RuntimeObject,
  key: string,
): TaggedValue {
  const desc = obj.hiddenClass.lookupProperty(key);
  if (!desc) return mkUndefined();
  const result = createJSObject();
  const value = slotValue(obj, desc, key);
  if (desc.kind === "accessor") {
    if (value instanceof AccessorPair) {
      result.setProperty("get", (value.get === undefined ? mkUndefined() : value.get));
      result.setProperty("set", (value.set === undefined ? mkUndefined() : value.set));
    }
  } else {
    result.setProperty("value", taggedSlotValue(value));
    result.setProperty("writable", mkBool(desc.writable));
  }
  result.setProperty("enumerable", mkBool(desc.enumerable));
  result.setProperty("configurable", mkBool(desc.configurable));
  return mkObject(result);
}

function ordinaryDefinePropertyObject(
  obj: RuntimeObject,
  key: string,
  descObj: TaggedValue,
): boolean {
  const getterVal = runtimeGetProperty(descObj, "get");
  const setterVal = runtimeGetProperty(descObj, "set");
  if (
    (getterVal && isFunction(getterVal)) ||
    (setterVal && isFunction(setterVal))
  ) {
    const existingDesc = obj.hiddenClass.lookupProperty(key);
    if (existingDesc && existingDesc.kind === "accessor") {
      const existingPair = slotValue(obj, existingDesc, key);
      if (existingPair instanceof AccessorPair) {
        if (getterVal && isFunction(getterVal)) existingPair.get = getterVal;
        if (setterVal && isFunction(setterVal)) existingPair.set = setterVal;
      }
      return true;
    }
    const enumerable = runtimeGetProperty(descObj, "enumerable");
    const configurable = runtimeGetProperty(descObj, "configurable");
    return obj.defineProperty(key, {
      kind: "accessor",
      writable: false,
      enumerable: enumerable !== undefined ? toBool(enumerable) : false,
      configurable: configurable !== undefined ? toBool(configurable) : false,
      value: new AccessorPair(
        getterVal && isFunction(getterVal) ? getterVal : undefined,
        setterVal && isFunction(setterVal) ? setterVal : undefined,
      ),
    });
  }
  const val = runtimeGetProperty(descObj, "value");
  const writable = runtimeGetProperty(descObj, "writable");
  const enumerable = runtimeGetProperty(descObj, "enumerable");
  const configurable = runtimeGetProperty(descObj, "configurable");
  return obj.defineProperty(key, {
    kind: "data",
    writable: writable !== undefined ? toBool(writable) : false,
    enumerable: enumerable !== undefined ? toBool(enumerable) : false,
    configurable: configurable !== undefined ? toBool(configurable) : false,
    value: val !== undefined ? val : mkUndefined(),
  });
}

export function runtimeGetProperty(
  receiver: TaggedValue,
  key: string | TaggedValue,
  interpreter: InterpreterLike | null = null,
  originalReceiver = receiver,
): TaggedValue {
  if (isSymbol(key)) {
    const symbolKey = key as TaggedValue;
    if (isJSProxyValue(receiver)) {
      const proxy = proxyPayload(receiver);
      const trap = getTrap(proxy, "get", interpreter);
      if (trap && interpreter) {
        return interpreter.callFunctionValue(
          trap,
          [proxy.target, symbolKey, originalReceiver],
          proxy.handler,
        );
      }
      return runtimeGetProperty(
        proxy.target,
        symbolKey,
        interpreter,
        originalReceiver,
      );
    }
    if (isObject(receiver)) {
      const val = objectPayload(receiver).getSymbolProperty(symbolKey);
      return val !== undefined ? val : mkUndefined();
    }
    if (isArray(receiver)) {
      const val = arrayPayload(receiver).getSymbolProperty(symbolKey);
      return val !== undefined ? val : mkUndefined();
    }
    return mkUndefined();
  }
  const propName = keyToString(key);
  if (isJSProxyValue(receiver)) {
    const proxy = proxyPayload(receiver);
    const trap = getTrap(proxy, "get", interpreter);
    if (trap && interpreter) {
      const trapResult = interpreter.callFunctionValue(
        trap,
        [proxy.target, mkString(propName), originalReceiver],
        proxy.handler,
      );
      const inv = targetOwnDataInvariant(proxy.target, propName);
      if (inv) {
        if (inv.desc.kind !== "accessor" && !inv.desc.writable) {
          const tval = slotValue(inv.tobj, inv.desc, propName);
          const targetVal = taggedSlotValue(tval);
          if (!sameValue(trapResult, targetVal)) {
            throw new VMTypeError(
              `'get' on proxy: property '${propName}' is a read-only and non-configurable data property on the proxy target but the proxy did not return its actual value`,
            );
          }
        } else if (inv.desc.kind === "accessor") {
          const pair = slotValue(inv.tobj, inv.desc, propName);
          if (pair instanceof AccessorPair && !pair.get && !isUndefined(trapResult)) {
            throw new VMTypeError(
              `'get' on proxy: property '${propName}' is a non-configurable accessor property on the proxy target and does not have a getter function, but the trap did not return undefined`,
            );
          }
        }
      }
      return trapResult;
    }
    return runtimeGetProperty(
      proxy.target,
      propName,
      interpreter,
      originalReceiver,
    );
  }
  if (isObject(receiver)) {
    return ordinaryGetObject(
      receiver,
      objectPayload(receiver),
      propName,
      interpreter,
    );
  }
  if (isArray(receiver)) {
    const arr = arrayPayload(receiver);
    if (propName === "length") return mkSmi(arr.getLength());
    const idx = Number(propName);
    if (Number.isInteger(idx)) {
      const val = arr.getIndex(idx);
      return val !== undefined ? val : mkUndefined();
    }
    const val = arr.getProperty(propName);
    return val !== undefined ? val : mkUndefined();
  }
  if (isString(receiver)) {
    if (propName === "length") return mkSmi((getPayload(receiver) as string).length);
    const idx = Number(propName);
    if (Number.isInteger(idx)) {
      const ch = (getPayload(receiver) as string)[idx];
      return ch !== undefined ? mkString(ch) : mkUndefined();
    }
  }
  if (isFunction(receiver)) {
    const fn = functionPayload(receiver);
    if (fn.properties && fn.properties[propName])
      return fn.properties[propName];
    if (propName === "prototype") {
      if (!fn.prototypeObj) {
        fn.prototypeObj = createJSObject();
        fn.prototypeObj.constructorRef = receiver;
      }
      return mkObject(fn.prototypeObj);
    }
  }
  return mkUndefined();
}

export function runtimeSetProperty(
  receiver: TaggedValue,
  key: string | TaggedValue,
  value: TaggedValue,
  interpreter: InterpreterLike | null = null,
  originalReceiver = receiver,
): boolean {
  if (isSymbol(key)) {
    const symbolKey = key as TaggedValue;
    if (isJSProxyValue(receiver)) {
      const proxy = proxyPayload(receiver);
      const trap = getTrap(proxy, "set", interpreter);
      if (trap && interpreter) {
        return toBool(
          interpreter.callFunctionValue(
            trap,
            [proxy.target, symbolKey, value, originalReceiver],
            proxy.handler,
          ),
        );
      }
      return runtimeSetProperty(
        proxy.target,
        symbolKey,
        value,
        interpreter,
        originalReceiver,
      );
    }
    if (isObject(receiver)) {
      objectPayload(receiver).setSymbolProperty(symbolKey, value);
      return true;
    }
    if (isArray(receiver)) {
      arrayPayload(receiver).setSymbolProperty(symbolKey, value);
      return true;
    }
    return false;
  }
  const propName = keyToString(key);
  if (isJSProxyValue(receiver)) {
    const proxy = proxyPayload(receiver);
    const trap = getTrap(proxy, "set", interpreter);
    if (trap && interpreter) {
      return toBool(
        interpreter.callFunctionValue(
          trap,
          [proxy.target, mkString(propName), value, originalReceiver],
          proxy.handler,
        ),
      );
    }
    return runtimeSetProperty(
      proxy.target,
      propName,
      value,
      interpreter,
      originalReceiver,
    );
  }
  if (isObject(receiver))
    return ordinarySetObject(
      receiver,
      objectPayload(receiver),
      propName,
      value,
      interpreter,
    );
  if (isArray(receiver)) {
    const arr = arrayPayload(receiver);
    if (propName === "length") {
      arr.setLength(toNumber(value));
      return true;
    }
    const idx = Number(propName);
    if (Number.isInteger(idx)) arr.setIndex(idx, value);
    else arr.setProperty(propName, value);
    return true;
  }
  return false;
}

export function runtimeHasProperty(
  receiver: TaggedValue,
  key: string | TaggedValue,
  interpreter: InterpreterLike | null = null,
): boolean {
  if (isSymbol(key)) {
    const symbolKey = key as TaggedValue;
    if (isJSProxyValue(receiver)) {
      const proxy = proxyPayload(receiver);
      const trap = getTrap(proxy, "has", interpreter);
      if (trap && interpreter) {
        return toBool(
          interpreter.callFunctionValue(
            trap,
            [proxy.target, symbolKey],
            proxy.handler,
          ),
        );
      }
      return runtimeHasProperty(proxy.target, symbolKey, interpreter);
    }
    if (isObject(receiver)) return objectPayload(receiver).hasSymbolProperty(symbolKey);
    if (isArray(receiver)) return arrayPayload(receiver).hasSymbolProperty(symbolKey);
    return false;
  }
  const propName = keyToString(key);
  if (isJSProxyValue(receiver)) {
    const proxy = proxyPayload(receiver);
    const trap = getTrap(proxy, "has", interpreter);
    if (trap && interpreter) {
      const trapResult = toBool(
        interpreter.callFunctionValue(
          trap,
          [proxy.target, mkString(propName)],
          proxy.handler,
        ),
      );
      if (!trapResult && targetOwnDataInvariant(proxy.target, propName)) {
        throw new VMTypeError(
          `'has' on proxy: trap returned falsish for property '${propName}' which exists in the proxy target as a non-configurable property`,
        );
      }
      return trapResult;
    }
    return runtimeHasProperty(proxy.target, propName, interpreter);
  }
  if (isObject(receiver)) {
    const obj = objectPayload(receiver);
    if (obj.hiddenClass.hasProperty(propName)) return true;
    return !!(obj.prototype && obj.lookupPrototypeChain(propName).found);
  }
  if (isArray(receiver)) {
    const idx = Number(propName);
    if (Number.isInteger(idx))
      return idx >= 0 && idx < arrayPayload(receiver).getLength();
    return arrayPayload(receiver).getProperty(propName) !== undefined;
  }
  return false;
}

export function runtimeDeleteProperty(
  receiver: TaggedValue,
  key: string | TaggedValue,
  interpreter: InterpreterLike | null = null,
): boolean {
  if (isSymbol(key)) {
    const symbolKey = key as TaggedValue;
    if (isJSProxyValue(receiver)) {
      const proxy = proxyPayload(receiver);
      const trap = getTrap(proxy, "deleteProperty", interpreter);
      if (trap && interpreter) {
        return toBool(
          interpreter.callFunctionValue(
            trap,
            [proxy.target, symbolKey],
            proxy.handler,
          ),
        );
      }
      return runtimeDeleteProperty(proxy.target, symbolKey, interpreter);
    }
    if (isObject(receiver))
      return objectPayload(receiver).deleteSymbolProperty(symbolKey);
    return true;
  }
  const propName = keyToString(key);
  if (isJSProxyValue(receiver)) {
    const proxy = proxyPayload(receiver);
    const trap = getTrap(proxy, "deleteProperty", interpreter);
    if (trap && interpreter) {
      const trapResult = toBool(
        interpreter.callFunctionValue(
          trap,
          [proxy.target, mkString(propName)],
          proxy.handler,
        ),
      );
      if (trapResult && targetOwnDataInvariant(proxy.target, propName)) {
        throw new VMTypeError(
          `'deleteProperty' on proxy: trap returned truish for property '${propName}' which is non-configurable in the proxy target`,
        );
      }
      return trapResult;
    }
    return runtimeDeleteProperty(proxy.target, propName, interpreter);
  }
  if (isObject(receiver)) return objectPayload(receiver).deleteProperty(propName);
  return true;
}

export function runtimeOwnKeys(
  receiver: TaggedValue,
  interpreter: InterpreterLike | null = null,
): string[] {
  if (isJSProxyValue(receiver)) {
    const proxy = proxyPayload(receiver);
    const trap = getTrap(proxy, "ownKeys", interpreter);
    if (trap && interpreter) {
      const result = interpreter.callFunctionValue(
        trap,
        [proxy.target],
        proxy.handler,
      );
      if (isArray(result))
        return arrayPayload(result).elements.map((key) =>
          keyToString(key === undefined ? mkUndefined() : key),
        );
      return [];
    }
    return runtimeOwnKeys(proxy.target, interpreter);
  }
  if (isObject(receiver)) return objectPayload(receiver).keys();
  if (isArray(receiver))
  {
    const arr = arrayPayload(receiver);
    return arr.keys ? arr.keys() : [];
  }
  return [];
}

export function runtimeGetOwnPropertyDescriptor(
  receiver: TaggedValue,
  key: string | TaggedValue,
  interpreter: InterpreterLike | null = null,
): TaggedValue {
  const propName = keyToString(key);
  if (isJSProxyValue(receiver)) {
    const proxy = proxyPayload(receiver);
    const trap = getTrap(proxy, "getOwnPropertyDescriptor", interpreter);
    if (trap && interpreter) {
      const result = interpreter.callFunctionValue(
        trap,
        [proxy.target, mkString(propName)],
        proxy.handler,
      );
      return result !== undefined ? result : mkUndefined();
    }
    return runtimeGetOwnPropertyDescriptor(proxy.target, propName, interpreter);
  }
  if (isObject(receiver))
    return ordinaryGetDescriptorObject(objectPayload(receiver), propName);
  return mkUndefined();
}

export function runtimeDefineProperty(
  receiver: TaggedValue,
  key: string | TaggedValue,
  desc: TaggedValue,
  interpreter: InterpreterLike | null = null,
): boolean {
  const propName = keyToString(key);
  if (isJSProxyValue(receiver)) {
    const proxy = proxyPayload(receiver);
    const trap = getTrap(proxy, "defineProperty", interpreter);
    if (trap && interpreter) {
      return toBool(
        interpreter.callFunctionValue(
          trap,
          [proxy.target, mkString(propName), desc],
          proxy.handler,
        ),
      );
    }
    return runtimeDefineProperty(proxy.target, propName, desc, interpreter);
  }
  if (isObject(receiver) && isObject(desc))
    return ordinaryDefinePropertyObject(objectPayload(receiver), propName, desc);
  return false;
}

export function keysArray(keys: string[]): TaggedValue {
  return mkArray(createJSArray(keys.map((key) => mkString(key))));
}

export function proxyTargetIsValid(value: TaggedValue): boolean {
  return isObject(value) || isArray(value) || isFunction(value);
}
