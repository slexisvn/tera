import { describe, it, expect } from "vitest";
import { modelBridge } from "../../../src/runtime/domain/model-builtins.js";
import { withHostAsync } from "../../../src/runtime/domain/host.js";
import { MicrotaskQueue } from "../../../src/runtime/microtasks/microtask.js";
import { createJSObject } from "../../../src/objects/heap/factory.js";
import { MODEL_MARKER } from "../../../src/frontend/parser/index.js";
import {
  getPayload,
  mkFunction,
  mkObject,
  mkSmi,
  mkString,
  mkUndefined,
  type TaggedValue,
} from "../../../src/core/value/index.js";

type Trace = string[];

function hostBinding(trace: Trace, result: TaggedValue) {
  return {
    queue: new MicrotaskQueue(),
    drain: () => {},
    interpreter: {
      callFunctionValue(fn: TaggedValue) {
        trace.push(`call:${getPayload(fn).name}`);
        return result;
      },
      constructFunctionValue: () => mkUndefined(),
    },
    run: <T,>(fn: () => T): T => {
      trace.push("scope:enter");
      try {
        return fn();
      } finally {
        trace.push("scope:exit");
      }
    },
  };
}

function modelValue(methods: readonly string[]): TaggedValue {
  const object = createJSObject();
  object.setProperty(MODEL_MARKER, mkString("Tiny"));
  for (const method of methods) {
    object.setProperty(method, mkFunction({ name: method, call: () => mkUndefined() }));
  }
  return mkObject(object);
}

function bridgeFor(methods: readonly string[], trace: Trace, result: TaggedValue) {
  const binding = hostBinding(trace, result);
  const model = modelValue(methods);
  const bridge = withHostAsync(binding, () =>
    modelBridge(model, binding.interpreter),
  ) as Record<string, (...args: unknown[]) => unknown>;
  trace.length = 0;
  return bridge;
}

describe("model bridge re-entry", () => {
  it("re-enters the runtime scope for a step invoked after the scope has exited", () => {
    const trace: Trace = [];
    const bridge = bridgeFor(["train"], trace, mkSmi(7));

    expect(bridge.trainingStep!([])).toBe(7);
    expect(trace).toEqual(["scope:enter", "call:train", "scope:exit"]);
  });

  it("re-enters the runtime scope for forward invoked after the scope has exited", () => {
    const trace: Trace = [];
    const bridge = bridgeFor(["train", "forward"], trace, mkSmi(3));

    expect(bridge.forward!(1)).toBe(3);
    expect(trace).toEqual(["scope:enter", "call:forward", "scope:exit"]);
  });

  it("re-enters the runtime scope for every step the model declares", () => {
    const trace: Trace = [];
    const bridge = bridgeFor(["train", "validate", "optimizer"], trace, mkUndefined());

    bridge.validationStep!([]);
    bridge.configureOptimizers!();

    expect(trace).toEqual([
      "scope:enter",
      "call:validate",
      "scope:exit",
      "scope:enter",
      "call:optimizer",
      "scope:exit",
    ]);
  });
});
