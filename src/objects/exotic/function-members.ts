import {
  mkFunction,
  mkObject,
  mkSmi,
  mkString,
  mkUndefined,
  isArray,
  isObject,
  getPayload,
  type FunctionAccessor,
  type RuntimeFunctionPayload,
  type TaggedValue,
} from "../../core/value/index.js";
import { createJSObject } from "../heap/factory.js";

type MethodInterpreter = {
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
};

type FunctionSlot =
  | { kind: "data"; value: TaggedValue }
  | { kind: "accessor"; accessor: FunctionAccessor };

function hasOwn(record: Record<string, unknown> | undefined, key: string): boolean {
  return !!record && Object.prototype.hasOwnProperty.call(record, key);
}

function resolveFunctionSlot(fn: RuntimeFunctionPayload, propName: string): FunctionSlot | null {
  for (let current: RuntimeFunctionPayload | null | undefined = fn; current; current = current.staticBase) {
    if (hasOwn(current.accessors, propName)) return { kind: "accessor", accessor: current.accessors![propName] };
    if (hasOwn(current.properties, propName)) return { kind: "data", value: current.properties![propName] };
  }
  return null;
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

export function makeFunctionMethod(
  targetFn: TaggedValue,
  kind: string,
): TaggedValue {
  if (kind === "call") {
    return mkFunction({
      name: "call",
      call(callArgs: TaggedValue[], _t: TaggedValue, interp: MethodInterpreter) {
        const thisArg = callArgs.length > 0 ? callArgs[0] : mkUndefined();
        return interp.callFunctionValue(targetFn, callArgs.slice(1), thisArg);
      },
    });
  }
  if (kind === "apply") {
    return mkFunction({
      name: "apply",
      call(callArgs: TaggedValue[], _t: TaggedValue, interp: MethodInterpreter) {
        const thisArg = callArgs.length > 0 ? callArgs[0] : mkUndefined();
        const applyArgs =
          callArgs.length > 1 ? spreadArrayArg(callArgs[1]) : [];
        return interp.callFunctionValue(targetFn, applyArgs, thisArg);
      },
    });
  }
  return mkFunction({
    name: "bind",
    call(bindArgs: TaggedValue[], _t: TaggedValue, interp: MethodInterpreter) {
      const boundThis = bindArgs.length > 0 ? bindArgs[0] : mkUndefined();
      const partial = bindArgs.slice(1);
      return mkFunction({
        name: "bound",
        call(callArgs: TaggedValue[], _t2: TaggedValue, ip: MethodInterpreter) {
          return ip.callFunctionValue(
            targetFn,
            partial.concat(callArgs),
            boundThis,
          );
        },
        construct(callArgs: TaggedValue[], ip: MethodInterpreter) {
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

const FUNCTION_METHOD_NAMES = new Set(["call", "apply", "bind"]);

function functionArity(fn: RuntimeFunctionPayload): number {
  if (typeof fn.paramCount === "number") return fn.paramCount;
  if (fn.compiled && typeof fn.compiled.paramCount === "number")
    return fn.compiled.paramCount;
  return 0;
}

export function functionMemberValue(
  receiver: TaggedValue,
  propName: string,
  interp?: MethodInterpreter,
): TaggedValue | null {
  const fn = getPayload(receiver) as RuntimeFunctionPayload;
  const slot = resolveFunctionSlot(fn, propName);
  if (slot) {
    if (slot.kind === "data") return slot.value;
    return slot.accessor.get && interp
      ? interp.callFunctionValue(slot.accessor.get, [], receiver)
      : mkUndefined();
  }
  if (FUNCTION_METHOD_NAMES.has(propName))
    return makeFunctionMethod(receiver, propName);
  if (propName === "name") return mkString(fn.name || "");
  if (propName === "length") return mkSmi(functionArity(fn));
  if (propName === "prototype") {
    if (!fn.prototypeObj) {
      fn.prototypeObj = createJSObject();
      fn.prototypeObj.constructorRef = fn;
    }
    return mkObject(fn.prototypeObj);
  }
  return null;
}

export function setFunctionMember(
  receiver: TaggedValue,
  propName: string,
  value: TaggedValue,
  interp?: MethodInterpreter,
): void {
  const fn = getPayload(receiver) as RuntimeFunctionPayload;
  const slot = resolveFunctionSlot(fn, propName);
  if (slot?.kind === "accessor") {
    if (slot.accessor.set && interp) interp.callFunctionValue(slot.accessor.set, [value], receiver);
    return;
  }
  if (!fn.properties) fn.properties = {};
  fn.properties[propName] = value;
  if (propName === "prototype" && isObject(value)) fn.prototypeObj = getPayload(value);
}

export function defineFunctionAccessor(
  receiver: TaggedValue,
  propName: string,
  getter: TaggedValue | null,
  setter: TaggedValue | null,
): void {
  const fn = getPayload(receiver) as RuntimeFunctionPayload;
  if (!fn.accessors) fn.accessors = {};
  const existing = fn.accessors[propName];
  if (existing) {
    if (getter) existing.get = getter;
    if (setter) existing.set = setter;
    return;
  }
  fn.accessors[propName] = { get: getter ?? undefined, set: setter ?? undefined };
}

export function setFunctionStaticBase(receiver: TaggedValue, base: TaggedValue): void {
  (getPayload(receiver) as RuntimeFunctionPayload).staticBase = getPayload(base) as RuntimeFunctionPayload;
}
