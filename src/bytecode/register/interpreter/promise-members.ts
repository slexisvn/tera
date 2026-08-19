import {
  getPayload,
  isFunction,
  mkFunction,
  mkString,
  mkUndefined,
  type PromiseValue,
  type TaggedValue,
} from "../../../core/value/index.js";
import {
  mkPromiseCapability,
  promiseThen,
  PROMISE_FULFILLED,
  type PromiseInterpreter,
} from "../../../runtime/async/promise.js";

export function asPromiseMemberInterpreter(
  interpreter: unknown,
): PromiseInterpreter | null {
  const candidate = interpreter as PromiseInterpreter | null | undefined;
  return candidate &&
    typeof candidate.callFunctionValue === "function" &&
    typeof candidate.exceptionToValue === "function" &&
    candidate.microtaskQueue !== undefined
    ? candidate
    : null;
}

export function promiseMemberValue(
  interp: PromiseInterpreter,
  obj: PromiseValue,
  propName: string,
): TaggedValue {
  const p = getPayload(obj);
  if (propName === "then") {
    return mkFunction({
      name: "Promise.prototype.then",
      call: (args: TaggedValue[], receiver: TaggedValue | null | undefined, interpreter: PromiseInterpreter) => {
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
      call: (args: TaggedValue[], receiver: TaggedValue | null | undefined, interpreter: PromiseInterpreter) => {
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
      call: (args: TaggedValue[], receiver: TaggedValue | null | undefined, interpreter: PromiseInterpreter) => {
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
