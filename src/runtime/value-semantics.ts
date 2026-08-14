import {
  isSmi,
  isDouble,
  isNumber,
  isBool,
  isArray,
  isString,
  isRegex,
  isGenerator,
  mkSmi,
  mkString,
  mkUndefined,
  toNumber,
  abstractLooseEqual,
  abstractRelational,
  getPayload,
  strictEqual,
  stringCharAt,
  type GeneratorValue,
  type TaggedValue,
} from "../core/value/index.js";
import {
  runtimeGetProperty as proxyRuntimeGetProperty,
  type InterpreterLike as ProxyInterpreterLike,
} from "../objects/exotic/proxy-ops.js";
import { getRegexProperty } from "./intrinsics/regex-methods.js";
import {
  asGeneratorMemberInterpreter,
  generatorMemberValue,
} from "../bytecode/register/interpreter/generator-members.js";

export type BuiltinPrototypeSet = {
  arrayPrototype: TaggedValue;
  stringPrototype: TaggedValue;
  regexPrototype: TaggedValue;
  numberPrototype: TaggedValue;
  booleanPrototype: TaggedValue;
};

export type PropertyLookupInterpreter = ProxyInterpreterLike & {
  builtinPrototypes?: BuiltinPrototypeSet;
  _lookupBuiltinPrototype(proto: TaggedValue, propName: string): TaggedValue;
};

export function taggedToNumber(v: TaggedValue) {
  if (!v) return 0;
  return toNumber(v);
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

export function getRuntimeProperty(
  obj: TaggedValue,
  propName: string,
  interpreter: PropertyLookupInterpreter | null = null,
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
  if (isGenerator(obj)) {
    const generatorInterpreter = asGeneratorMemberInterpreter(interpreter);
    if (generatorInterpreter) {
      return generatorMemberValue(generatorInterpreter, obj as GeneratorValue, propName);
    }
    return mkUndefined();
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
