import {
  mkFunction,
  mkObject,
  mkSmi,
  mkString,
  mkUndefined,
  isArray,
  getPayload,
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
): TaggedValue | null {
  const fn = getPayload(receiver) as RuntimeFunctionPayload;
  if (fn.properties && fn.properties[propName]) return fn.properties[propName];
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
