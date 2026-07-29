import {
  mkFunction,
  mkUndefined,
  getPayload,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { tracer } from "../../core/tracing/index.js";

export type MicrotaskPolicyValue = "auto" | "explicit" | "scoped";

export const MicrotaskPolicy = Object.freeze({
  AUTO: "auto",
  EXPLICIT: "explicit",
  SCOPED: "scoped",
} satisfies Record<string, MicrotaskPolicyValue>);

export type MicrotaskInterpreter = {
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
};

type CallablePayload = {
  call(args: TaggedValue[], thisValue?: TaggedValue): TaggedValue;
};

type PromiseLikeRecord = {
  fulfill(value: TaggedValue): void;
  reject(reason: TaggedValue): void;
};
type PromiseHandle = TaggedValue | PromiseLikeRecord;

type PromiseReaction = (
  state: string,
  value: TaggedValue,
) => void;

type MicrotaskQueueOptions = {
  policy?: MicrotaskPolicyValue;
};

type MicrotaskStats = {
  enqueued: number;
  executed: number;
  checkpoints: number;
};

type RejectionHandler = (promise: PromiseHandle, type: "reject" | "handle") => void;

function callablePayload(value: TaggedValue): CallablePayload | null {
  const payload = getPayload(value) as Partial<CallablePayload> | null;
  return payload && typeof payload.call === "function"
    ? (payload as CallablePayload)
    : null;
}

export class Microtask {
  type: string;
  label?: string;

  constructor(type: string) {
    this.type = type;
  }

  run(_interpreter?: MicrotaskInterpreter | null): void {
    throw new Error("Microtask.run() is abstract");
  }
}

export class PromiseReactionMicrotask extends Microtask {
  reaction: PromiseReaction;
  promise: PromiseHandle;
  state: string;
  value: TaggedValue;

  constructor(
    reaction: PromiseReaction,
    promise: PromiseHandle,
    state: string,
    value: TaggedValue,
  ) {
    super("promise-reaction");
    this.reaction = reaction;
    this.promise = promise;
    this.state = state;
    this.value = value;
  }

  run(_interpreter?: MicrotaskInterpreter | null): void {
    this.reaction(this.state, this.value);
  }
}

export class PromiseResolveThenableMicrotask extends Microtask {
  promiseToResolve: PromiseLikeRecord;
  thenable: TaggedValue;
  thenMethod: TaggedValue;
  _interpreter?: MicrotaskInterpreter | null;

  constructor(
    promiseToResolve: PromiseLikeRecord,
    thenable: TaggedValue,
    thenMethod: TaggedValue,
    interpreter?: MicrotaskInterpreter | null,
  ) {
    super("promise-resolve-thenable");
    this.promiseToResolve = promiseToResolve;
    this.thenable = thenable;
    this.thenMethod = thenMethod;
    this._interpreter = interpreter;
  }

  run(interpreter?: MicrotaskInterpreter | null): void {
    const interp = interpreter || this._interpreter;
    let alreadyResolved = false;
    const resolveFn = mkFunction({
      name: "Thenable.resolve",
      call: (args: TaggedValue[]) => {
        if (alreadyResolved) return mkUndefined();
        alreadyResolved = true;
        this.promiseToResolve.fulfill(
          args[0] === undefined ? mkUndefined() : args[0],
        );
        return mkUndefined();
      },
    });
    const rejectFn = mkFunction({
      name: "Thenable.reject",
      call: (args: TaggedValue[]) => {
        if (alreadyResolved) return mkUndefined();
        alreadyResolved = true;
        this.promiseToResolve.reject(
          args[0] === undefined ? mkUndefined() : args[0],
        );
        return mkUndefined();
      },
    });
    try {
      if (interp) {
        interp.callFunctionValue(
          this.thenMethod,
          [resolveFn, rejectFn],
          this.thenable,
        );
      } else {
        const thenPayload = callablePayload(this.thenMethod);
        if (thenPayload) {
          thenPayload.call([resolveFn, rejectFn], this.thenable);
        } else {
          this.promiseToResolve.reject(mkUndefined());
        }
      }
    } catch (e) {
      this.promiseToResolve.reject(mkUndefined());
    }
  }
}

export class CallbackMicrotask extends Microtask {
  callback: TaggedValue;

  constructor(callback: TaggedValue) {
    super("callback");
    this.callback = callback;
  }

  run(interpreter?: MicrotaskInterpreter | null): void {
    if (interpreter) {
      interpreter.callFunctionValue(this.callback, [], mkUndefined());
    } else {
      callablePayload(this.callback)?.call([], mkUndefined());
    }
  }
}

export class MicrotaskQueue {
  queue: Array<Microtask | undefined>;
  head: number;
  policy: MicrotaskPolicyValue;
  nestingDepth: number;
  suppressionDepth: number;
  running: boolean;
  pendingRejections: Map<PromiseHandle, TaggedValue>;
  rejectionHandler: RejectionHandler | null;
  stats: MicrotaskStats;

  constructor(options: MicrotaskQueueOptions = {}) {
    this.queue = [];
    this.head = 0;

    this.policy = options.policy || MicrotaskPolicy.AUTO;

    this.nestingDepth = 0;

    this.suppressionDepth = 0;

    this.running = false;

    this.pendingRejections = new Map();

    this.rejectionHandler = null;

    this.stats = {
      enqueued: 0,
      executed: 0,
      checkpoints: 0,
    };
  }

  enqueue(microtask: Microtask): void {
    if (!(microtask instanceof Microtask)) {
      throw new Error("MicrotaskQueue.enqueue: expected Microtask");
    }
    this.queue.push(microtask);
    this.stats.enqueued++;
    tracer.log(
      "microtask",
      `Enqueue: ${microtask.type}${microtask.label ? ` (${microtask.label})` : ""}`,
    );
  }

  runOne(interpreter?: MicrotaskInterpreter | null): boolean {
    if (this.head >= this.queue.length) return false;
    const microtask = this.queue[this.head];
    if (!microtask) return false;
    this.queue[this.head] = undefined;
    this.head++;
    tracer.log(
      "microtask",
      `Run: ${microtask.type}${microtask.label ? ` (${microtask.label})` : ""}`,
    );
    microtask.run(interpreter);
    this.stats.executed++;
    if (this.head >= this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    }
    return true;
  }

  drain(interpreter?: MicrotaskInterpreter | null, limit = 10000): void {
    if (this.running) return;
    if (this.suppressionDepth > 0) return;

    this.running = true;
    this.nestingDepth++;
    try {
      let count = 0;
      while (this.head < this.queue.length) {
        if (count++ >= limit) {
          throw new Error("Microtask queue limit exceeded");
        }
        this.runOne(interpreter);
      }
    } finally {
      this.nestingDepth--;
      this.running = false;
      this._checkPendingRejections();
    }
  }

  performCheckpoint(interpreter?: MicrotaskInterpreter | null): void {
    if (this.policy === MicrotaskPolicy.EXPLICIT) return;
    if (this.policy === MicrotaskPolicy.SCOPED) return;
    if (this.suppressionDepth > 0) return;
    this.stats.checkpoints++;
    tracer.log(
      "microtask",
      `Checkpoint (queue=${this.queue.length - this.head}, nesting=${this.nestingDepth})`,
    );
    this.drain(interpreter);
  }

  incrementSuppressionDepth(): void {
    this.suppressionDepth++;
  }

  decrementSuppressionDepth(): void {
    if (this.suppressionDepth > 0) this.suppressionDepth--;
  }

  setPolicy(policy: MicrotaskPolicyValue): void {
    this.policy = policy;
  }

  trackRejection(promise: PromiseHandle, value: TaggedValue): void {
    this.pendingRejections.set(promise, value);
    tracer.log(
      "microtask",
      `UnhandledRejection tracked (pending=${this.pendingRejections.size})`,
    );
    if (this.rejectionHandler) {
      this.rejectionHandler(promise, "reject");
    }
  }

  trackHandle(promise: PromiseHandle): void {
    if (this.pendingRejections.has(promise)) {
      this.pendingRejections.delete(promise);
      tracer.log(
        "microtask",
        `RejectionHandled (pending=${this.pendingRejections.size})`,
      );
      if (this.rejectionHandler) {
        this.rejectionHandler(promise, "handle");
      }
    }
  }

  _checkPendingRejections(): void {
    if (this.pendingRejections.size === 0) return;
    for (const [promise, value] of this.pendingRejections) {
      tracer.log(
        "microtask",
        `WARNING: Unhandled promise rejection (value=${value})`,
      );
    }
  }

  setRejectionHandler(handler: RejectionHandler | null): void {
    this.rejectionHandler = handler;
  }

  getStats() {
    return {
      ...this.stats,
      pending: this.queue.length - this.head,
      pendingRejections: this.pendingRejections.size,
      policy: this.policy,
    };
  }
}

export class MicrotasksScope {
  queue: MicrotaskQueue;
  interpreter?: MicrotaskInterpreter | null;

  constructor(queue: MicrotaskQueue, interpreter?: MicrotaskInterpreter | null) {
    this.queue = queue;
    this.interpreter = interpreter;
    this.queue.nestingDepth++;
  }

  exit(): void {
    this.queue.nestingDepth--;
    if (this.queue.nestingDepth === 0) {
      if (this.queue.policy === MicrotaskPolicy.SCOPED) {
        this.queue.drain(this.interpreter);
      } else {
        this.queue.performCheckpoint(this.interpreter);
      }
    }
  }
}
