import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/bytecode/register/interpreter/index.js", () => {
  class MockRegisterFrame {
    constructor(compiledFn, args, thisValue) {
      this.compiledFn = compiledFn;
      this.locals = new Array(compiledFn.registerCount || 4).fill(undefined);
      this.acc = undefined;
      this.thisValue = thisValue;
      this.pc = 0;
    }
  }
  return { RegisterFrame: MockRegisterFrame, MAX_DEOPT_COUNT: 3, updateCallMode: () => {} };
});

import { Deoptimizer } from "../../src/deopt/deoptimizer.js";
import { DeoptSignal } from "../../src/deopt/signal.js";
import { FrameState } from "../../src/deopt/frame-state.js";
import {
  mkSmi,
  mkUndefined,
  mkString,
  isSmi,
  isUndefined,
  getPayload,
} from "../../src/core/value/index.js";

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
    const signal = new DeoptSignal("smi-check-failed", 10, [], [], 0, new Map());
    const frameStates = [fs];

    const result = deopt.deoptimize(signal, frameStates);
    expect(interpreter.resumeAt).toHaveBeenCalledTimes(1);
    expect(result).toBe(mkSmi(42));
    expect(deopt.deoptCount).toBe(1);
    expect(deopt.lastDeoptReason).toBe("smi-check-failed");
  });

  it("routes to deoptimizeFromSignalState when frameStateId is -1", () => {
    const deopt = new Deoptimizer(makeInterpreter(null));
    const signal = new DeoptSignal("overflow", 5, [], [], -1, new Map());

    expect(() => deopt.deoptimize(signal, [])).toThrow(
      /Deoptimization without FrameState not fully supported/,
    );
    expect(deopt.deoptCount).toBe(1);
  });

  it("routes to deoptimizeFromSignalState when frameStates is null", () => {
    const deopt = new Deoptimizer(makeInterpreter(null));
    const signal = new DeoptSignal("overflow", 5, [], [], 0, new Map());

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
      const signal = new DeoptSignal("map-check-failed", 0, [], [], 0, new Map());
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

    const signal = new DeoptSignal("smi-check-failed", 15, [], [], 0, new Map());
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

    const signal = new DeoptSignal("overflow", 0, [], [], 0, new Map());
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
    const signal = new DeoptSignal("guard-failure", 0, [], [], 0, runtimeValues);
    deopt.deoptimize(signal, [fs]);

    expect(calls[0].thisValue).toBe(thisVal);
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
    const signal = new DeoptSignal("guard-failure", 0, [], [], 0, runtimeValues);
    deopt.deoptimize(signal, [fs]);

    expect(runtimeValues.has(50)).toBe(true);
  });

  it("disables optimization on the compiled function", () => {
    const interpreter = makeInterpreter(mkSmi(0));
    const deopt = new Deoptimizer(interpreter);
    const fn = makeFn("disableOpt");

    const fs = new FrameState(fn, 0);
    fs.id = 0;
    const signal = new DeoptSignal("overflow", 0, [], [], 0, new Map());
    deopt.deoptimize(signal, [fs]);

    expect(fn.optimizedCode).toBe(null);
    expect(fn.deoptCount).toBe(1);
  });
});

describe("Deoptimizer.deoptimizeFromSignalState", () => {
  it("throws with reason in message", () => {
    const deopt = new Deoptimizer(makeInterpreter(null));
    const signal = new DeoptSignal("bounds-check-failed", 42, [], [], -1, new Map());

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

    const signal = new DeoptSignal("map-check-failed", 5, [], [], 1, new Map());
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

    const signal = new DeoptSignal("overflow", 20, [], [], 2, new Map());
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

    const signal = new DeoptSignal("overflow", 5, [], [], 1, new Map());
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

    const signal = new DeoptSignal("overflow", 5, [], [], 1, new Map());
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

    const signal = new DeoptSignal("overflow", 5, [], [], 1, new Map());
    deopt.deoptimize(signal, [outerFs, innerFs]);

    const outerFrame = frames.find((f) => f.name === "outer");
    expect(getPayload(outerFrame.locals[0])).toBe(111);
    expect(getPayload(outerFrame.locals[1])).toBe(222);
  });
});
