import { describe, it, expect } from "vitest";
import {
  JSPromise,
  PromiseCapability,
  mkPromiseCapability,
  resolvePromise,
  promiseReject,
  PROMISE_PENDING,
  PROMISE_FULFILLED,
  PROMISE_REJECTED,
} from "../../../src/runtime/async/promise.js";
import { MicrotaskQueue } from "../../../src/runtime/microtasks/microtask.js";
import { mkSmi, mkString, mkUndefined, mkPromise, getPayload } from "../../../src/core/value/index.js";

function drainQueue(q) {
  q.drain(null, 100);
}

describe("JSPromise", () => {
  describe("state machine", () => {
    it("starts in pending state", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      expect(p.state).toBe(PROMISE_PENDING);
      expect(p.result).toBe(mkUndefined());
    });

    it("fulfill transitions to fulfilled with result", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.fulfill(mkSmi(42));
      expect(p.state).toBe(PROMISE_FULFILLED);
      expect(p.result).toBe(mkSmi(42));
    });

    it("reject transitions to rejected with reason", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      const reason = mkString("err");
      p.reject(reason);
      expect(p.state).toBe(PROMISE_REJECTED);
      expect(p.result).toBe(reason);
    });

    it("settle is idempotent — second fulfill is ignored", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.fulfill(mkSmi(1));
      p.fulfill(mkSmi(2));
      expect(p.result).toBe(mkSmi(1));
    });

    it("settle is idempotent — reject after fulfill is ignored", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.fulfill(mkSmi(1));
      p.reject(mkString("err"));
      expect(p.state).toBe(PROMISE_FULFILLED);
    });

    it("settle is idempotent — fulfill after reject is ignored", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.reject(mkString("err"));
      p.fulfill(mkSmi(1));
      expect(p.state).toBe(PROMISE_REJECTED);
    });
  });

  describe("reactions", () => {
    it("reactions added before settle fire on settle via microtask", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      let captured;
      p.addReaction((state, value) => { captured = { state, value }; });
      expect(captured).toBeUndefined();
      p.fulfill(mkSmi(99));
      drainQueue(q);
      expect(captured).toEqual({ state: PROMISE_FULFILLED, value: mkSmi(99) });
    });

    it("reactions added after settle fire immediately via microtask", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.fulfill(mkSmi(10));
      let captured;
      p.addReaction((state, value) => { captured = { state, value }; });
      drainQueue(q);
      expect(captured).toEqual({ state: PROMISE_FULFILLED, value: mkSmi(10) });
    });

    it("multiple reactions all fire in order", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      const order = [];
      p.addReaction(() => order.push(1));
      p.addReaction(() => order.push(2));
      p.addReaction(() => order.push(3));
      p.fulfill(mkSmi(0));
      drainQueue(q);
      expect(order).toEqual([1, 2, 3]);
    });

    it("reactions list is cleared after settle", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.addReaction(() => {});
      p.addReaction(() => {});
      expect(p.reactions).toHaveLength(2);
      p.fulfill(mkSmi(0));
      expect(p.reactions).toHaveLength(0);
    });
  });

  describe("rejection tracking", () => {
    it("reject without reactions tracks unhandled rejection", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.reject(mkString("err"));
      expect(q.getStats().pendingRejections).toBe(1);
    });

    it("reject with pre-existing reaction does not track", () => {
      const q = new MicrotaskQueue();
      const p = new JSPromise(q);
      p.addReaction(() => {});
      p.reject(mkString("err"));
      expect(q.getStats().pendingRejections).toBe(0);
    });

    it("adding reaction to already-rejected promise tracks handle", () => {
      const q = new MicrotaskQueue();
      const events = [];
      q.setRejectionHandler((_, type) => events.push(type));
      const p = new JSPromise(q);
      p.reject(mkString("err"));
      p.addReaction(() => {});
      expect(events).toContain("handle");
    });
  });
});

describe("PromiseCapability", () => {
  it("resolve settles the internal promise", () => {
    const q = new MicrotaskQueue();
    const cap = new PromiseCapability(q);
    cap.resolve(mkSmi(42));
    drainQueue(q);
    expect(cap.promise.state).toBe(PROMISE_FULFILLED);
    expect(cap.promise.result).toBe(mkSmi(42));
  });

  it("reject settles the internal promise", () => {
    const q = new MicrotaskQueue();
    const cap = new PromiseCapability(q);
    cap.reject(mkString("fail"));
    expect(cap.promise.state).toBe(PROMISE_REJECTED);
  });
});

describe("resolvePromise", () => {
  it("non-promise non-thenable fulfills directly", () => {
    const q = new MicrotaskQueue();
    const p = new JSPromise(q);
    resolvePromise(q, p, mkSmi(5));
    expect(p.state).toBe(PROMISE_FULFILLED);
    expect(p.result).toBe(mkSmi(5));
  });

  it("promise value enqueues thenable resolution", () => {
    const q = new MicrotaskQueue();
    const inner = new JSPromise(q);
    inner.fulfill(mkSmi(10));
    const outer = new JSPromise(q);
    resolvePromise(q, outer, mkPromise(inner));
    expect(outer.state).toBe(PROMISE_PENDING);
    expect(q.getStats().pending).toBeGreaterThan(0);
  });
});

describe("promiseReject", () => {
  it("creates a rejected promise value", () => {
    const q = new MicrotaskQueue();
    const reason = mkString("oops");
    const val = promiseReject(q, reason);
    const p = getPayload(val);
    expect(p.state).toBe(PROMISE_REJECTED);
    expect(p.result).toBe(reason);
  });
});
