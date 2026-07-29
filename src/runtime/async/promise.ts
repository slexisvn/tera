import {
  mkFunction,
  mkPromise,
  mkUndefined,
  isObject,
  isPromise,
  isFunction,
  getPayload,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { tracer } from "../../core/tracing/index.js";
import {
  MicrotaskQueue,
  PromiseReactionMicrotask,
  PromiseResolveThenableMicrotask,
} from "../microtasks/microtask.js";

export const PROMISE_PENDING = "pending";
export const PROMISE_FULFILLED = "fulfilled";
export const PROMISE_REJECTED = "rejected";

type PromiseState =
  | typeof PROMISE_PENDING
  | typeof PROMISE_FULFILLED
  | typeof PROMISE_REJECTED;

type PromiseReaction = (state: string, result: TaggedValue) => void;

type InterpreterLike = {
  microtaskQueue: MicrotaskQueue;
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
  exceptionToValue(error: ThrownValue): TaggedValue;
};

type ThrownValue =
  | object
  | string
  | number
  | boolean
  | symbol
  | null
  | undefined;

type CallablePayload = {
  call(args: TaggedValue[], thisValue?: TaggedValue): TaggedValue;
};

type ObjectPayload = {
  getProperty(name: string): TaggedValue | undefined;
};

function promisePayload(value: TaggedValue): JSPromise {
  return getPayload(value) as JSPromise;
}

function callablePayload(value: TaggedValue): CallablePayload {
  return getPayload(value) as CallablePayload;
}

export class JSPromise {
  queue: MicrotaskQueue;
  state: PromiseState;
  result: TaggedValue;
  reactions: PromiseReaction[];
  asyncFunctionName: string | null;
  resumePc: number;

  constructor(queue: MicrotaskQueue) {
    this.queue = queue;
    this.state = PROMISE_PENDING;
    this.result = mkUndefined();
    this.reactions = [];
    this.asyncFunctionName = null;
    this.resumePc = -1;
  }

  fulfill(value: TaggedValue): void {
    this.settle(PROMISE_FULFILLED, value);
  }

  reject(reason: TaggedValue): void {
    if (this.state !== PROMISE_PENDING) return;
    const hadReactions = this.reactions.length > 0;
    this.settle(PROMISE_REJECTED, reason);
    if (!hadReactions) {
      this.queue.trackRejection(this, reason);
    }
  }

  settle(state: PromiseState, value: TaggedValue): void {
    if (this.state !== PROMISE_PENDING) return;
    this.state = state;
    this.result = value;
    const reactions = this.reactions.splice(0);
    for (const reaction of reactions) {
      this.queue.enqueue(
        new PromiseReactionMicrotask(reaction, this, state, value),
      );
    }
  }

  addReaction(reaction: PromiseReaction): void {
    if (this.state === PROMISE_PENDING) {
      this.reactions.push(reaction);
      return;
    }
    const state = this.state;
    const result = this.result;
    this.queue.enqueue(
      new PromiseReactionMicrotask(reaction, this, state, result),
    );

    if (state === PROMISE_REJECTED) {
      this.queue.trackHandle(this);
    }
  }
}

export class PromiseCapability {
  promise: JSPromise;
  resolve: (value: TaggedValue, interpreter?: InterpreterLike | null) => void;
  reject: (reason: TaggedValue) => void;

  constructor(queue: MicrotaskQueue) {
    this.promise = new JSPromise(queue);
    this.resolve = (value) => resolvePromise(queue, this.promise, value);
    this.reject = (reason) => this.promise.reject(reason);
  }
}

export function mkPromiseCapability(queue: MicrotaskQueue) {
  const capability = new PromiseCapability(queue);
  return { capability, value: mkPromise(capability.promise) };
}

export function promiseResolve(
  queue: MicrotaskQueue,
  value: TaggedValue,
  interpreter: InterpreterLike | null = null,
): TaggedValue {
  if (isPromise(value)) return value;
  const { capability, value: promiseValue } = mkPromiseCapability(queue);
  resolvePromise(queue, capability.promise, value, interpreter);
  return promiseValue;
}

export function promiseReject(
  queue: MicrotaskQueue,
  reason: TaggedValue,
): TaggedValue {
  const { capability, value: promiseValue } = mkPromiseCapability(queue);
  capability.reject(reason);
  return promiseValue;
}

export function resolvePromise(
  queue: MicrotaskQueue,
  promise: JSPromise,
  value: TaggedValue,
  interpreter: InterpreterLike | null = null,
): void {
  if (isPromise(value)) {
    const then = mkFunction({
      name: "Promise.then",
      call: (args: TaggedValue[]) => {
        const onFulfilled = args[0];
        const onRejected = args[1];
        promisePayload(value).addReaction((state, result) => {
          if (state === PROMISE_FULFILLED) {
            if (onFulfilled !== undefined && isFunction(onFulfilled))
              callablePayload(onFulfilled).call([result]);
            else promise.fulfill(result);
          } else {
            if (onRejected !== undefined && isFunction(onRejected))
              callablePayload(onRejected).call([result]);
            else promise.reject(result);
          }
        });
        return mkUndefined();
      },
    });
    queue.enqueue(
      new PromiseResolveThenableMicrotask(promise, value, then, interpreter),
    );
    return;
  }
  if (isObject(value)) {
    const payload = getPayload(value) as ObjectPayload;
    const then = payload.getProperty("then");
    if (then !== undefined && isFunction(then)) {
      queue.enqueue(
        new PromiseResolveThenableMicrotask(promise, value, then, interpreter),
      );
      return;
    }
  }
  promise.fulfill(value);
}

export function promiseThen(
  interpreter: InterpreterLike,
  receiver: TaggedValue,
  onFulfilled: TaggedValue,
  onRejected: TaggedValue,
): TaggedValue {
  const source = isPromise(receiver)
    ? promisePayload(receiver)
    : promisePayload(promiseResolve(interpreter.microtaskQueue, receiver, interpreter));
  const { capability, value: nextPromise } = mkPromiseCapability(
    interpreter.microtaskQueue,
  );
  source.addReaction((state, result) => {
    try {
      const handler = state === PROMISE_FULFILLED ? onFulfilled : onRejected;
      if (isFunction(handler)) {
        const handled = interpreter.callFunctionValue(
          handler,
          [result],
          mkUndefined(),
        );
        capability.resolve(handled);
      } else if (state === PROMISE_FULFILLED) {
        capability.resolve(result);
      } else {
        capability.reject(result);
      }
    } catch (e) {
      const thrown =
        e === null ||
        e === undefined ||
        typeof e === "object" ||
        typeof e === "string" ||
        typeof e === "number" ||
        typeof e === "boolean" ||
        typeof e === "symbol"
          ? e
          : String(e);
      capability.reject(interpreter.exceptionToValue(thrown));
    }
  });
  tracer.log("promise", "Promise reaction registered");
  return nextPromise;
}
