import { describe, it, expect } from "vitest";
import {
  MicrotaskQueue,
  MicrotaskPolicy,
  Microtask,
  PromiseReactionMicrotask,
  CallbackMicrotask,
  MicrotasksScope,
} from "../../../src/runtime/microtasks/microtask.js";
import { mkFunction, mkUndefined, mkSmi, getPayload } from "../../../src/core/value/index.js";

function simpleMicrotask(fn) {
  const m = new Microtask("test");
  m.run = fn;
  return m;
}

describe("MicrotaskQueue", () => {
  describe("enqueue and drain", () => {
    it("drain executes all enqueued microtasks in FIFO order", () => {
      const q = new MicrotaskQueue();
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.enqueue(simpleMicrotask(() => order.push(2)));
      q.enqueue(simpleMicrotask(() => order.push(3)));
      q.drain(null);
      expect(order).toEqual([1, 2, 3]);
      expect(q.getStats().executed).toBe(3);
    });

    it("drain processes microtasks enqueued during drain", () => {
      const q = new MicrotaskQueue();
      const order = [];
      q.enqueue(simpleMicrotask(() => {
        order.push(1);
        q.enqueue(simpleMicrotask(() => order.push(2)));
      }));
      q.drain(null);
      expect(order).toEqual([1, 2]);
    });

    it("drain throws when limit exceeded", () => {
      const q = new MicrotaskQueue();
      q.enqueue(simpleMicrotask(() => {
        q.enqueue(simpleMicrotask(() => q.enqueue(simpleMicrotask(() => {}))));
      }));
      for (let i = 0; i < 5; i++) q.enqueue(simpleMicrotask(() => {}));
      expect(() => q.drain(null, 3)).toThrow(/limit exceeded/);
    });

    it("rejects non-Microtask instances", () => {
      const q = new MicrotaskQueue();
      expect(() => q.enqueue({ type: "fake", run() {} })).toThrow(/expected Microtask/);
    });

    it("runOne returns false on empty queue", () => {
      const q = new MicrotaskQueue();
      expect(q.runOne(null)).toBe(false);
    });

    it("compacts the backing array after a full drain", () => {
      const q = new MicrotaskQueue();
      for (let i = 0; i < 100; i++) q.enqueue(simpleMicrotask(() => {}));
      q.drain(null);
      expect(q.queue.length).toBe(0);
      expect(q.head).toBe(0);
      expect(q.getStats().pending).toBe(0);
    });

    it("preserves FIFO order across repeated drain/enqueue cycles", () => {
      const q = new MicrotaskQueue();
      const order = [];
      for (let i = 0; i < 50; i++) q.enqueue(simpleMicrotask(() => order.push(i)));
      q.drain(null);
      for (let i = 50; i < 100; i++) q.enqueue(simpleMicrotask(() => order.push(i)));
      q.drain(null);
      expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });

    it("reports pending as the not-yet-run count while draining", () => {
      const q = new MicrotaskQueue();
      const seen = [];
      for (let i = 0; i < 5; i++) {
        q.enqueue(simpleMicrotask(() => seen.push(q.getStats().pending)));
      }
      q.drain(null);
      expect(seen).toEqual([4, 3, 2, 1, 0]);
    });

    it("runOne executes exactly one microtask", () => {
      const q = new MicrotaskQueue();
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.enqueue(simpleMicrotask(() => order.push(2)));
      expect(q.runOne(null)).toBe(true);
      expect(order).toEqual([1]);
      expect(q.getStats().pending).toBe(1);
    });
  });

  describe("suppression", () => {
    it("suppression blocks drain", () => {
      const q = new MicrotaskQueue();
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.incrementSuppressionDepth();
      q.drain(null);
      expect(order).toEqual([]);
      q.decrementSuppressionDepth();
      q.drain(null);
      expect(order).toEqual([1]);
    });

    it("suppression depth stacks", () => {
      const q = new MicrotaskQueue();
      q.incrementSuppressionDepth();
      q.incrementSuppressionDepth();
      q.decrementSuppressionDepth();
      q.enqueue(simpleMicrotask(() => {}));
      q.drain(null);
      expect(q.getStats().pending).toBe(1);
      q.decrementSuppressionDepth();
      q.drain(null);
      expect(q.getStats().pending).toBe(0);
    });

    it("decrement below zero stays at zero", () => {
      const q = new MicrotaskQueue();
      q.decrementSuppressionDepth();
      q.decrementSuppressionDepth();
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.drain(null);
      expect(order).toEqual([1]);
    });
  });

  describe("policy and checkpoint", () => {
    it("AUTO policy drains on checkpoint", () => {
      const q = new MicrotaskQueue({ policy: MicrotaskPolicy.AUTO });
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.performCheckpoint(null);
      expect(order).toEqual([1]);
    });

    it("EXPLICIT policy skips checkpoint", () => {
      const q = new MicrotaskQueue({ policy: MicrotaskPolicy.EXPLICIT });
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.performCheckpoint(null);
      expect(order).toEqual([]);
    });

    it("SCOPED policy skips checkpoint", () => {
      const q = new MicrotaskQueue({ policy: MicrotaskPolicy.SCOPED });
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.performCheckpoint(null);
      expect(order).toEqual([]);
    });

    it("setPolicy changes behavior", () => {
      const q = new MicrotaskQueue({ policy: MicrotaskPolicy.AUTO });
      q.setPolicy(MicrotaskPolicy.EXPLICIT);
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      q.performCheckpoint(null);
      expect(order).toEqual([]);
    });
  });

  describe("reentrant drain protection", () => {
    it("nested drain is a no-op while already running", () => {
      const q = new MicrotaskQueue();
      const order = [];
      q.enqueue(simpleMicrotask(() => {
        order.push("outer");
        q.enqueue(simpleMicrotask(() => order.push("inner")));
        q.drain(null);
      }));
      q.drain(null);
      expect(order).toEqual(["outer", "inner"]);
    });
  });

  describe("rejection tracking", () => {
    it("trackRejection and trackHandle toggle pending state", () => {
      const q = new MicrotaskQueue();
      const fakePromise = { id: 1 };
      q.trackRejection(fakePromise, "error");
      expect(q.getStats().pendingRejections).toBe(1);
      q.trackHandle(fakePromise);
      expect(q.getStats().pendingRejections).toBe(0);
    });

    it("rejectionHandler receives events", () => {
      const q = new MicrotaskQueue();
      const events = [];
      q.setRejectionHandler((p, type) => events.push(type));
      const fakePromise = { id: 1 };
      q.trackRejection(fakePromise, "err");
      q.trackHandle(fakePromise);
      expect(events).toEqual(["reject", "handle"]);
    });

    it("trackHandle on unknown promise is a no-op", () => {
      const q = new MicrotaskQueue();
      q.trackHandle({ id: 999 });
      expect(q.getStats().pendingRejections).toBe(0);
    });
  });

  describe("MicrotasksScope", () => {
    it("SCOPED policy drains on scope exit at nesting depth 0", () => {
      const q = new MicrotaskQueue({ policy: MicrotaskPolicy.SCOPED });
      const order = [];
      q.enqueue(simpleMicrotask(() => order.push(1)));
      const scope = new MicrotasksScope(q, null);
      expect(order).toEqual([]);
      scope.exit();
      expect(order).toEqual([1]);
    });

    it("nested scopes defer drain until outermost exits", () => {
      const q = new MicrotaskQueue({ policy: MicrotaskPolicy.SCOPED });
      const order = [];
      const outer = new MicrotasksScope(q, null);
      const inner = new MicrotasksScope(q, null);
      q.enqueue(simpleMicrotask(() => order.push(1)));
      inner.exit();
      expect(order).toEqual([]);
      outer.exit();
      expect(order).toEqual([1]);
    });
  });

  describe("PromiseReactionMicrotask", () => {
    it("invokes reaction with state and value", () => {
      let captured;
      const reaction = (state, value) => { captured = { state, value }; };
      const task = new PromiseReactionMicrotask(reaction, null, "fulfilled", 42);
      task.run(null);
      expect(captured).toEqual({ state: "fulfilled", value: 42 });
    });
  });

  describe("CallbackMicrotask", () => {
    it("calls function payload directly when no interpreter", () => {
      let called = false;
      const fn = mkFunction({ name: "test", call: () => { called = true; return mkUndefined(); } });
      const task = new CallbackMicrotask(fn);
      task.run(null);
      expect(called).toBe(true);
    });
  });

  describe("stats", () => {
    it("tracks enqueued, executed, checkpoints, pending", () => {
      const q = new MicrotaskQueue();
      q.enqueue(simpleMicrotask(() => {}));
      q.enqueue(simpleMicrotask(() => {}));
      q.performCheckpoint(null);
      const stats = q.getStats();
      expect(stats.enqueued).toBe(2);
      expect(stats.executed).toBe(2);
      expect(stats.checkpoints).toBe(1);
      expect(stats.pending).toBe(0);
    });
  });
});
