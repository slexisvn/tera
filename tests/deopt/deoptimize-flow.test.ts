import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/bytecode/register/interpreter/index.js", async () => {
  const { CODE_UNDEFINED } = await import("../../src/core/value/index.js");
  class MockRegisterFrame {
    constructor(compiledFn, args, thisValue, closureEnv) {
      this.compiledFn = compiledFn;
      this.locals = new Array(compiledFn.registerCount || 4).fill(CODE_UNDEFINED);
      this.acc = CODE_UNDEFINED;
      this.thisValue = thisValue || CODE_UNDEFINED;
      this.closureEnv = closureEnv || null;
      this.pc = 0;
    }
  }
  return { RegisterFrame: MockRegisterFrame, MAX_DEOPT_COUNT: 3, updateCallMode: () => {} };
});

import { Deoptimizer } from "../../src/deopt/deoptimizer.js";
import { DeoptSignal } from "../../src/deopt/signal.js";
import { FrameState } from "../../src/deopt/frame-state.js";
import { Environment } from "../../src/runtime/intrinsics/environment.js";
import {
  mkSmi,
  mkUndefined,
  mkString,
  mkObject,
  isSmi,
  isBool,
  isUndefined,
  getPayload,
} from "../../src/core/value/index.js";
import { createJSObject } from "../../src/objects/heap/factory.js";
import {
  IR_GENERIC_COMPARE,
  IR_GENERIC_GET_PROP,
  IR_LOAD_FIELD,
  IR_LOAD_GLOBAL,
  IR_PARAMETER,
} from "../../src/optimizing/ir/index.js";

function makeFn(name, registerCount = 4) {
  return {
    name,
    id: Math.random(),
    registerCount,
    paramCount: 0,
    deoptCount: 0,
    optimizedCode: {},
    optimizedDependencies: [],
  };
}

function makeInterpreter(resumeResult) {
  return {
    resumeAt: vi.fn(() => resumeResult),
    tieringPolicy: null,
  };
}

describe("Deoptimizer.deoptimize dispatch", () => {
  it("routes to deoptimizeFromFrameState when valid frameStateId and frameStates exist", () => {
    const interpreter = makeInterpreter(mkSmi(42));
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("test");
    const fs = new FrameState(fn, 10);
    fs.id = 0;
    const signal = new DeoptSignal("smi-check-failed", 10, 0, new Map());
    const frameStates = [fs];

    const result = deopt.deoptimize(signal, frameStates);
    expect(interpreter.resumeAt).toHaveBeenCalledTimes(1);
    expect(result).toBe(mkSmi(42));
    expect(deopt.deoptCount).toBe(1);
    expect(deopt.lastDeoptReason).toBe("smi-check-failed");
  });

  it("routes to deoptimizeFromSignalState when frameStateId is -1", () => {
    const deopt = new Deoptimizer(makeInterpreter(null));
    const signal = new DeoptSignal("overflow", 5, -1, new Map());

    expect(() => deopt.deoptimize(signal, [])).toThrow(
      /Deoptimization without FrameState not fully supported/,
    );
    expect(deopt.deoptCount).toBe(1);
  });

  it("routes to deoptimizeFromSignalState when frameStates is null", () => {
    const deopt = new Deoptimizer(makeInterpreter(null));
    const signal = new DeoptSignal("overflow", 5, 0, new Map());

    expect(() => deopt.deoptimize(signal, null)).toThrow(
      /Deoptimization without FrameState/,
    );
  });

  it("increments deoptCount and records reason on every call", () => {
    const interpreter = makeInterpreter(mkSmi(1));
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("fn");

    for (let i = 0; i < 3; i++) {
      const fs = new FrameState(fn, 0);
      fs.id = 0;
      fn.optimizedCode = {};
      fn.optimizedDependencies = [];
      const signal = new DeoptSignal("map-check-failed", 0, 0, new Map());
      deopt.deoptimize(signal, [fs]);
    }

    expect(deopt.deoptCount).toBe(3);
    const stats = deopt.getStats();
    expect(stats.reasons["map-check-failed"]).toBe(3);
  });
});

describe("Deoptimizer.deoptimizeFromFrameState", () => {
  it("restores locals from frameState into the resumed frame", () => {
    const calls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        calls.push({
          locals: [...frame.locals],
          pc: frame.pc,
        });
        return mkSmi(100);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("restoreLocals", 3);

    const fs = new FrameState(fn, 15);
    fs.id = 0;
    fs.setLocal(0, { id: 1, type: "Constant", props: { value: 10 } });
    fs.setLocal(2, { id: 2, type: "Constant", props: { value: 20 } });

    const signal = new DeoptSignal("smi-check-failed", 15, 0, new Map());
    deopt.deoptimize(signal, [fs]);

    const resumed = calls[0];
    expect(resumed.pc).toBe(15);
    expect(getPayload(resumed.locals[0])).toBe(10);
    expect(isUndefined(resumed.locals[1])).toBe(true);
    expect(getPayload(resumed.locals[2])).toBe(20);
  });

  it("restores accumulator from last stack value", () => {
    const calls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        calls.push({ acc: frame.acc });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("restoreAcc");

    const fs = new FrameState(fn, 0);
    fs.id = 0;
    fs.pushStack({ id: 10, type: "Constant", props: { value: 77 } });
    fs.pushStack({ id: 11, type: "Constant", props: { value: 88 } });

    const signal = new DeoptSignal("overflow", 0, 0, new Map());
    deopt.deoptimize(signal, [fs]);

    expect(getPayload(calls[0].acc)).toBe(88);
  });

  it("restores thisValue from frameState", () => {
    const calls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        calls.push({ thisValue: frame.thisValue });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("restoreThis");

    const fs = new FrameState(fn, 0);
    fs.id = 0;
    const thisVal = mkSmi(999);
    fs.setThis(thisVal);

    const runtimeValues = new Map();
    const signal = new DeoptSignal("guard-failure", 0, 0, runtimeValues);
    deopt.deoptimize(signal, [fs]);

    expect(calls[0].thisValue).toBe(thisVal);
  });

  it("restores closure environment from deopt signal", () => {
    let resumedFrame = null;
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        resumedFrame = frame;
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("closure");
    const fs = new FrameState(fn, 0);
    fs.id = 0;
    const env = new Environment([]);
    const signal = new DeoptSignal("guard-failure", 0, 0, new Map(), env);

    deopt.deoptimize(signal, [fs]);

    expect(resumedFrame.closureEnv).toBe(env);
  });

  it("materializes sunk allocations and merges into runtimeValues", () => {
    const calls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        calls.push({ locals: [...frame.locals] });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("sunkAllocs");

    const fs = new FrameState(fn, 0);
    fs.id = 0;
    fs.setSunkAllocations(
      new Map([
        [
          50,
          {
            props: new Map([
              ["x", { id: 60, type: "Constant", props: { value: 42 } }],
            ]),
          },
        ],
      ]),
    );
    fs.setLocal(0, { id: 50, type: "Alloc" });

    const runtimeValues = new Map();
    const signal = new DeoptSignal("guard-failure", 0, 0, runtimeValues);
    deopt.deoptimize(signal, [fs]);

    expect(runtimeValues.has(50)).toBe(true);
  });

  it("disables optimization on the compiled function", () => {
    const interpreter = makeInterpreter(mkSmi(0));
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("disableOpt");

    const fs = new FrameState(fn, 0);
    fs.id = 0;
    const signal = new DeoptSignal("overflow", 0, 0, new Map());
    deopt.deoptimize(signal, [fs]);

    expect(fn.optimizedCode).toBe(null);
    expect(fn.deoptCount).toBe(1);
  });
});

describe("Deoptimizer.deoptimizeFromSignalState", () => {
  it("throws with reason in message", () => {
    const deopt = new Deoptimizer(makeInterpreter(null));
    const signal = new DeoptSignal("bounds-check-failed", 42, -1, new Map());

    expect(() => deopt.deoptimize(signal, [])).toThrow("bounds-check-failed");
  });
});

describe("Deoptimizer.resumeCascaded", () => {
  it("unwinds two-level inline chain calling resumeAt for each frame", () => {
    const resumeCalls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        resumeCalls.push(frame.compiledFn.name);
        return mkSmi(resumeCalls.length);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);

    const outerFn = makeFn("outer");
    const innerFn = makeFn("inner");

    const outerFs = new FrameState(outerFn, 20);
    outerFs.id = 0;

    const innerFs = new FrameState(innerFn, 5);
    innerFs.id = 1;
    innerFs.setCallerFrame(outerFs);

    const signal = new DeoptSignal("map-check-failed", 5, 1, new Map());
    const result = deopt.deoptimize(signal, [outerFs, innerFs]);

    expect(resumeCalls).toEqual(["inner", "outer"]);
    expect(result).toBe(mkSmi(2));
  });

  it("unwinds three-level chain in correct order", () => {
    const resumeCalls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        resumeCalls.push(frame.compiledFn.name);
        return mkSmi(resumeCalls.length * 10);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);

    const a = makeFn("a");
    const b = makeFn("b");
    const c = makeFn("c");

    const fsA = new FrameState(a, 0);
    fsA.id = 0;
    const fsB = new FrameState(b, 10);
    fsB.id = 1;
    fsB.setCallerFrame(fsA);
    const fsC = new FrameState(c, 20);
    fsC.id = 2;
    fsC.setCallerFrame(fsB);

    const signal = new DeoptSignal("overflow", 20, 2, new Map());
    const result = deopt.deoptimize(signal, [fsA, fsB, fsC]);

    expect(resumeCalls).toEqual(["c", "b", "a"]);
    expect(result).toBe(mkSmi(30));
  });

  it("passes inner result as accumulator to outer frame", () => {
    const accValues = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        accValues.push(frame.acc);
        return mkSmi(accValues.length * 100);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);

    const outer = makeFn("outer");
    const inner = makeFn("inner");

    const outerFs = new FrameState(outer, 0);
    outerFs.id = 0;
    const innerFs = new FrameState(inner, 5);
    innerFs.id = 1;
    innerFs.setCallerFrame(outerFs);

    const signal = new DeoptSignal("overflow", 5, 1, new Map());
    deopt.deoptimize(signal, [outerFs, innerFs]);

    expect(accValues[1]).toBe(mkSmi(100));
  });

  it("disables optimization for each function in the chain", () => {
    const interpreter = makeInterpreter(mkSmi(0));
    const deopt = new Deoptimizer(interpreter);

    const outer = makeFn("outer");
    const inner = makeFn("inner");

    const outerFs = new FrameState(outer, 0);
    outerFs.id = 0;
    const innerFs = new FrameState(inner, 5);
    innerFs.id = 1;
    innerFs.setCallerFrame(outerFs);

    const signal = new DeoptSignal("overflow", 5, 1, new Map());
    deopt.deoptimize(signal, [outerFs, innerFs]);

    expect(inner.optimizedCode).toBe(null);
    expect(inner.deoptCount).toBe(1);
    expect(outer.optimizedCode).toBe(null);
    expect(outer.deoptCount).toBe(1);
  });

  it("restores caller locals from callerFrameState", () => {
    const frames = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        frames.push({ name: frame.compiledFn.name, locals: [...frame.locals] });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);

    const outer = makeFn("outer", 2);
    const inner = makeFn("inner", 2);

    const outerFs = new FrameState(outer, 0);
    outerFs.id = 0;
    outerFs.setLocal(0, { id: 1, type: "Constant", props: { value: 111 } });
    outerFs.setLocal(1, { id: 2, type: "Constant", props: { value: 222 } });

    const innerFs = new FrameState(inner, 5);
    innerFs.id = 1;
    innerFs.setCallerFrame(outerFs);

    const signal = new DeoptSignal("overflow", 5, 1, new Map());
    deopt.deoptimize(signal, [outerFs, innerFs]);

    const outerFrame = frames.find((f) => f.name === "outer");
    expect(getPayload(outerFrame.locals[0])).toBe(111);
    expect(getPayload(outerFrame.locals[1])).toBe(222);
  });

  it("materializes caller frame values from the same runtime values", () => {
    const frames = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        frames.push({ name: frame.compiledFn.name, locals: [...frame.locals] });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);

    const outer = makeFn("outer", 1);
    const inner = makeFn("inner", 1);
    const liveValue = { id: 77, type: "LiveValue" };

    const outerFs = new FrameState(outer, 0);
    outerFs.id = 0;
    outerFs.setLocal(0, liveValue);

    const innerFs = new FrameState(inner, 5);
    innerFs.id = 1;
    innerFs.setCallerFrame(outerFs);

    const runtimeValues = new Map([[77, mkSmi(333)]]);
    const signal = new DeoptSignal("overflow", 5, 1, runtimeValues);
    deopt.deoptimize(signal, [outerFs, innerFs]);

    const outerFrame = frames.find((f) => f.name === "outer");
    expect(getPayload(outerFrame.locals[0])).toBe(333);
  });
});

describe("Deoptimizer.materializeValue — node kinds the JIT frame materializer supports", () => {
  const node = (type, props = {}, inputs = []) => ({
    id: Math.floor(Math.random() * 100000),
    type,
    props,
    inputs,
  });

  it("reads a field through the prototype chain for IR_GENERIC_GET_PROP", () => {
    const proto = createJSObject();
    proto.setProperty("v", mkSmi(9));
    const receiver = createJSObject();
    receiver.setPrototype(proto);

    const deopt = new Deoptimizer(makeInterpreter(mkSmi(0)));
    const load = node(IR_GENERIC_GET_PROP, { propName: "v" }, [mkObject(receiver)]);

    expect(getPayload(deopt.materializeValue(load, new Map()))).toBe(9);
  });

  it("reads an own field by offset for IR_LOAD_FIELD", () => {
    const obj = createJSObject();
    obj.setProperty("x", mkSmi(41));
    const offset = obj.hiddenClass.lookupProperty("x").offset;

    const deopt = new Deoptimizer(makeInterpreter(mkSmi(0)));
    const load = node(IR_LOAD_FIELD, { offset }, [mkObject(obj)]);

    expect(getPayload(deopt.materializeValue(load, new Map()))).toBe(41);
  });

  it("reads a global cell for IR_LOAD_GLOBAL", () => {
    const deopt = new Deoptimizer({
      resumeAt: vi.fn(() => mkSmi(0)),
      tieringPolicy: null,
      globalCells: { read: (name) => (name === "g" ? mkSmi(7) : undefined) },
    });
    const load = node(IR_LOAD_GLOBAL, { name: "g" }, []);

    expect(getPayload(deopt.materializeValue(load, new Map()))).toBe(7);
  });

  it("evaluates IR_GENERIC_COMPARE instead of yielding undefined", () => {
    const deopt = new Deoptimizer(makeInterpreter(mkSmi(0)));
    const cmp = node(IR_GENERIC_COMPARE, { op: "<" }, [mkSmi(1), mkSmi(2)]);

    const result = deopt.materializeValue(cmp, new Map());
    expect(isBool(result)).toBe(true);
    expect(getPayload(result)).toBe(true);
  });

  it("prefers a captured runtime value over re-deriving the node", () => {
    const proto = createJSObject();
    proto.setProperty("v", mkSmi(9));
    const receiver = createJSObject();
    receiver.setPrototype(proto);

    const deopt = new Deoptimizer(makeInterpreter(mkSmi(0)));
    const load = node(IR_GENERIC_GET_PROP, { propName: "v" }, [mkObject(receiver)]);

    const captured = new Map([[load.id, mkSmi(123)]]);
    expect(getPayload(deopt.materializeValue(load, captured))).toBe(123);
  });

  it("resolves IR_PARAMETER from the activation args", () => {
    const deopt = new Deoptimizer(makeInterpreter(mkSmi(0)));
    const param = node(IR_PARAMETER, { index: 1 }, []);

    const result = deopt.materializeValue(param, new Map(), [mkSmi(5), mkSmi(6)]);
    expect(getPayload(result)).toBe(6);
  });

  it("yields undefined for IR_PARAMETER when the index is out of range", () => {
    const deopt = new Deoptimizer(makeInterpreter(mkSmi(0)));
    const param = node(IR_PARAMETER, { index: 3 }, []);

    expect(isUndefined(deopt.materializeValue(param, new Map(), [mkSmi(5)]))).toBe(true);
  });
});

describe("Deoptimizer.deoptimize — activation args reach the resumed frame", () => {
  it("materializes parameter-backed locals from the args passed to deoptimize", () => {
    const calls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        calls.push({ locals: [...frame.locals] });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("withParams", 2);

    const fs = new FrameState(fn, 0);
    fs.id = 0;
    fs.setLocal(0, { id: 1, type: IR_PARAMETER, props: { index: 0 }, inputs: [] });
    fs.setLocal(1, { id: 2, type: IR_PARAMETER, props: { index: 1 }, inputs: [] });

    const signal = new DeoptSignal("smi-check-failed", 0, 0, new Map());
    deopt.deoptimize(signal, [fs], [mkSmi(11), mkSmi(22)]);

    expect(getPayload(calls[0].locals[0])).toBe(11);
    expect(getPayload(calls[0].locals[1])).toBe(22);
  });

  it("still prefers a captured runtime value over the activation args", () => {
    const calls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        calls.push({ locals: [...frame.locals] });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("captured", 1);

    const fs = new FrameState(fn, 0);
    fs.id = 0;
    fs.setLocal(0, { id: 7, type: IR_PARAMETER, props: { index: 0 }, inputs: [] });

    const signal = new DeoptSignal("smi-check-failed", 0, 0, new Map([[7, mkSmi(99)]]));
    deopt.deoptimize(signal, [fs], [mkSmi(11)]);

    expect(getPayload(calls[0].locals[0])).toBe(99);
  });

  it("restores thisValue from the activation when the frame state has none", () => {
    const calls = [];
    const interpreter = {
      resumeAt: vi.fn((frame) => {
        calls.push({ thisValue: frame.thisValue });
        return mkSmi(0);
      }),
      tieringPolicy: null,
    };
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("withThis", 1);

    const fs = new FrameState(fn, 0);
    fs.id = 0;

    const receiver = mkSmi(314);
    deopt.deoptimize(new DeoptSignal("overflow", 0, 0, new Map()), [fs], [], receiver);

    expect(calls[0].thisValue).toBe(receiver);
  });
});
