import {
  mkFunction,
  mkArray,
  mkObject,
  mkUndefined,
  mkString,
  isFunction,
  getPayload,
  isIterator,
  isPromise,
} from "../../../core/value/index.js";
import type { GeneratorPayload, PromisePayload, TaggedValue } from "../../../core/value/index.js";

import { createJSArray, createJSObject } from "../../../objects/heap/factory.js";
import { CallbackMicrotask } from "../../../runtime/microtasks/microtask.js";
import {
  mkPromiseCapability,
  promiseResolve,
  promiseReject,
  PROMISE_FULFILLED,
  PROMISE_REJECTED,
} from "../../../runtime/async/promise.js";
import {
  getIterator,
  iteratorDone,
  iteratorValue,
} from "../../../runtime/iteration/iterator.js";
import { VMTypeError } from "../../../core/errors/index.js";
import { RegisterException } from "./helpers.js";

type GlobalCellsLike = {
  write(name: string, value: TaggedValue): void;
};

type InterpreterLike = {
  microtaskQueue: Parameters<typeof mkPromiseCapability>[0];
  globalCells: GlobalCellsLike;
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
  generatorNext(gen: GeneratorPayload, value: TaggedValue): TaggedValue;
  exceptionToValue(error: object | string | number | boolean | symbol | null | undefined): TaggedValue;
};

type CallablePayload = {
  name: string;
  properties: Record<string, TaggedValue>;
  construct?: (args: TaggedValue[]) => TaggedValue;
  call?: (args: TaggedValue[]) => TaggedValue;
};

function argOrUndefined(args: TaggedValue[], index = 0): TaggedValue {
  return args.length > index ? args[index]! : mkUndefined();
}

function promiseRecord(value: TaggedValue, context: string): PromisePayload {
  if (!isPromise(value)) {
    throw new VMTypeError(`${context}: expected promise`);
  }
  return getPayload(value);
}

function iteratorRecord(value: TaggedValue) {
  if (!isIterator(value)) {
    throw new VMTypeError("Expected iterator object");
  }
  return getPayload(value);
}

type ThrownValue =
  | RegisterException
  | Error
  | object
  | string
  | number
  | boolean
  | symbol
  | null
  | undefined;

function collectIteratorItems(
  interpreter: InterpreterLike,
  iterable: TaggedValue,
): TaggedValue[] {
  const iter = getIterator(iterable, interpreter);
  const items: TaggedValue[] = [];
  while (true) {
    const next = iteratorRecord(iter).nextValue(interpreter);
    if (iteratorDone(next)) break;
    items.push(iteratorValue(next));
  }
  return items;
}

export function installPromiseBuiltin(interpreter: InterpreterLike): void {
  const promiseCtor = {
    name: "Promise",
    properties: {},
    construct: (args: TaggedValue[]) => {
      const executor = argOrUndefined(args);
      const { capability, value } = mkPromiseCapability(
        interpreter.microtaskQueue,
      );
      if (isFunction(executor)) {
        const resolveFn = mkFunction({
          name: "Promise.resolveCapability",
          call: (resolveArgs: TaggedValue[]) => {
            capability.resolve(argOrUndefined(resolveArgs));
            return mkUndefined();
          },
        });
        const rejectFn = mkFunction({
          name: "Promise.rejectCapability",
          call: (rejectArgs: TaggedValue[]) => {
            capability.reject(argOrUndefined(rejectArgs));
            return mkUndefined();
          },
        });
        try {
          interpreter.callFunctionValue(
            executor,
            [resolveFn, rejectFn],
            mkUndefined(),
          );
        } catch (e) {
          capability.reject(exceptionToValue(e as ThrownValue));
        }
      }
      return value;
    },
  };

  const ctorPayload = promiseCtor as CallablePayload;

  ctorPayload.properties.resolve = mkFunction({
    name: "Promise.resolve",
    call: (args: TaggedValue[]) =>
      promiseResolve(
        interpreter.microtaskQueue,
        argOrUndefined(args),
        interpreter,
      ),
  });
  ctorPayload.properties.reject = mkFunction({
    name: "Promise.reject",
    call: (args: TaggedValue[]) =>
      promiseReject(interpreter.microtaskQueue, argOrUndefined(args)),
  });
  ctorPayload.properties.all = mkFunction({
    name: "Promise.all",
    call: (args: TaggedValue[]) => promiseAll(interpreter, argOrUndefined(args)),
  });
  ctorPayload.properties.race = mkFunction({
    name: "Promise.race",
    call: (args: TaggedValue[]) => promiseRace(interpreter, argOrUndefined(args)),
  });
  ctorPayload.properties.allSettled = mkFunction({
    name: "Promise.allSettled",
    call: (args: TaggedValue[]) =>
      promiseAllSettled(interpreter, argOrUndefined(args)),
  });
  ctorPayload.properties.any = mkFunction({
    name: "Promise.any",
    call: (args: TaggedValue[]) => promiseAny(interpreter, argOrUndefined(args)),
  });

  interpreter.globalCells.write("Promise", mkFunction(ctorPayload));
  interpreter.globalCells.write(
    "queueMicrotask",
    mkFunction({
      name: "queueMicrotask",
      call: (args: TaggedValue[]) => {
        const callback = argOrUndefined(args);
        if (!isFunction(callback)) {
          throw new VMTypeError("queueMicrotask requires a function argument");
        }
        interpreter.microtaskQueue.enqueue(new CallbackMicrotask(callback));
        return mkUndefined();
      },
    }),
  );
}

export function exceptionToValue(
  e: object | string | number | boolean | symbol | null | undefined,
): TaggedValue {
  if (e instanceof RegisterException) return e.value;
  if (e && typeof e === "object" && typeof (e as { value?: RuntimeValue }).value === "number")
    return (e as { value: TaggedValue }).value;
  return mkString(e instanceof Error ? e.message : String(e));
}

export function promiseAll(
  interpreter: InterpreterLike,
  iterable: TaggedValue,
): TaggedValue {
  const { capability, value } = mkPromiseCapability(interpreter.microtaskQueue);
  try {
    const items = collectIteratorItems(interpreter, iterable);
    const results = new Array<TaggedValue>(items.length);
    if (items.length === 0) {
      capability.resolve(mkArray(createJSArray([])));
      return value;
    }
    let remaining = items.length;
    items.forEach((item, index) => {
      const itemPromise = promiseResolve(interpreter.microtaskQueue, item, interpreter);
      promiseRecord(itemPromise, "Promise.all").addReaction((state: string, result: TaggedValue) => {
        if (state === PROMISE_REJECTED) {
          capability.reject(result);
          return;
        }
        results[index] = result;
        remaining--;
        if (remaining === 0)
          capability.resolve(mkArray(createJSArray(results)));
      });
    });
  } catch (e) {
    capability.reject(exceptionToValue(e as ThrownValue));
  }
  return value;
}

export function promiseAllSettled(
  interpreter: InterpreterLike,
  iterable: TaggedValue,
): TaggedValue {
  const { capability, value } = mkPromiseCapability(interpreter.microtaskQueue);
  try {
    const items = collectIteratorItems(interpreter, iterable);
    const results = new Array<TaggedValue>(items.length);
    if (items.length === 0) {
      capability.resolve(mkArray(createJSArray([])));
      return value;
    }
    let remaining = items.length;
    items.forEach((item, index) => {
      const itemPromise = promiseResolve(interpreter.microtaskQueue, item, interpreter);
      promiseRecord(itemPromise, "Promise.allSettled").addReaction((state: string, result: TaggedValue) => {
        const obj = createJSObject();
        if (state === PROMISE_REJECTED) {
          obj.setProperty("status", mkString("rejected"));
          obj.setProperty("reason", result);
        } else {
          obj.setProperty("status", mkString("fulfilled"));
          obj.setProperty("value", result);
        }
        results[index] = mkObject(obj);
        remaining--;
        if (remaining === 0)
          capability.resolve(mkArray(createJSArray(results)));
      });
    });
  } catch (e) {
    capability.reject(exceptionToValue(e as ThrownValue));
  }
  return value;
}

export function promiseAny(
  interpreter: InterpreterLike,
  iterable: TaggedValue,
): TaggedValue {
  const { capability, value } = mkPromiseCapability(interpreter.microtaskQueue);
  try {
    const items = collectIteratorItems(interpreter, iterable);
    if (items.length === 0) {
      capability.reject(mkString("AggregateError: All promises were rejected"));
      return value;
    }
    let remaining = items.length;
    items.forEach((item) => {
      const itemPromise = promiseResolve(interpreter.microtaskQueue, item, interpreter);
      promiseRecord(itemPromise, "Promise.any").addReaction((state: string, result: TaggedValue) => {
        if (state === PROMISE_FULFILLED) {
          capability.resolve(result);
          return;
        }
        remaining--;
        if (remaining === 0)
          capability.reject(
            mkString("AggregateError: All promises were rejected"),
          );
      });
    });
  } catch (e) {
    capability.reject(exceptionToValue(e as ThrownValue));
  }
  return value;
}

export function promiseRace(
  interpreter: InterpreterLike,
  iterable: TaggedValue,
): TaggedValue {
  const { capability, value } = mkPromiseCapability(interpreter.microtaskQueue);
  try {
    const iter = getIterator(iterable, interpreter);
    while (true) {
      const next = iteratorRecord(iter).nextValue(interpreter);
      if (iteratorDone(next)) break;
      const itemPromise = promiseResolve(
        interpreter.microtaskQueue,
        iteratorValue(next),
        interpreter,
      );
      promiseRecord(itemPromise, "Promise.race").addReaction((state: string, result: TaggedValue) => {
        if (state === PROMISE_FULFILLED) capability.resolve(result);
        else capability.reject(result);
      });
    }
  } catch (e) {
    capability.reject(exceptionToValue(e as ThrownValue));
  }
  return value;
}
