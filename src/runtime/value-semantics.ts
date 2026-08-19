import {
  isNumber,
  isBool,
  isString,
  toNumber,
  abstractLooseEqual,
  abstractRelational,
  getPayload,
  strictEqual,
  type TaggedValue,
} from "../core/value/index.js";
import { runtimeGetProperty as proxyRuntimeGetProperty } from "../objects/exotic/proxy-ops.js";
import { memberLookupValue, type MemberLookupInterpreter } from "./member-lookup.js";

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
  interpreter: MemberLookupInterpreter | null = null,
): TaggedValue {
  const member = memberLookupValue(obj, propName, interpreter);
  return member !== null
    ? member
    : proxyRuntimeGetProperty(obj, propName, interpreter);
}
