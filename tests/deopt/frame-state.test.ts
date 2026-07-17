import { describe, it, expect } from "vitest";
import { FrameState, FrameStateBuilder } from "../../src/deopt/frame-state.js";

describe("FrameState locals", () => {
  it("setLocal/getLocal/hasLocal roundtrip", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.setLocal(0, "val0");
    fs.setLocal(2, "val2");
    expect(fs.getLocal(0)).toBe("val0");
    expect(fs.getLocal(2)).toBe("val2");
    expect(fs.hasLocal(0)).toBe(true);
    expect(fs.hasLocal(1)).toBe(false);
  });

  it("getLocalsArray fills gaps with null", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.setLocal(0, "a");
    fs.setLocal(3, "d");
    const arr = fs.getLocalsArray();
    expect(arr).toEqual(["a", null, null, "d"]);
  });

  it("localCount reflects number of set locals", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.setLocal(5, "x");
    fs.setLocal(10, "y");
    expect(fs.localCount).toBe(2);
  });
});

describe("FrameState stack", () => {
  it("push/pop/peek operate in LIFO order", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.pushStack("a");
    fs.pushStack("b");
    expect(fs.peekStack()).toBe("b");
    expect(fs.popStack()).toBe("b");
    expect(fs.popStack()).toBe("a");
  });

  it("stackDepth tracks push/pop", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    expect(fs.stackDepth).toBe(0);
    fs.pushStack("x");
    fs.pushStack("y");
    expect(fs.stackDepth).toBe(2);
    fs.popStack();
    expect(fs.stackDepth).toBe(1);
  });
});

describe("FrameState clone", () => {
  it("clone produces independent copy of locals and stack", () => {
    const fs = new FrameState({ name: "fn" }, 10);
    fs.setLocal(0, "a");
    fs.pushStack("s1");
    fs.setThis("this");
    fs.id = 5;
    const cloned = fs.clone();
    expect(cloned.getLocal(0)).toBe("a");
    expect(cloned.peekStack()).toBe("s1");
    expect(cloned.thisValue).toBe("this");
    expect(cloned.id).toBe(5);
    expect(cloned.bytecodeOffset).toBe(10);
    cloned.setLocal(0, "changed");
    cloned.pushStack("s2");
    expect(fs.getLocal(0)).toBe("a");
    expect(fs.stackDepth).toBe(1);
  });

  it("clone copies sunkAllocations independently", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.setSunkAllocations(new Map([[1, { props: new Map() }]]));
    const cloned = fs.clone();
    cloned.sunkAllocations.set(2, { props: new Map() });
    expect(fs.sunkAllocations.has(2)).toBe(false);
  });
});

describe("FrameState matches", () => {
  it("matches identical frame states", () => {
    const fn = { name: "fn" };
    const a = new FrameState(fn, 5);
    a.setLocal(0, "x");
    a.pushStack("s");
    const b = new FrameState(fn, 5);
    b.setLocal(0, "x");
    b.pushStack("s");
    expect(a.matches(b)).toBe(true);
  });

  it("does not match different bytecodeOffset", () => {
    const fn = { name: "fn" };
    const a = new FrameState(fn, 5);
    const b = new FrameState(fn, 6);
    expect(a.matches(b)).toBe(false);
  });

  it("does not match different locals", () => {
    const fn = { name: "fn" };
    const a = new FrameState(fn, 0);
    a.setLocal(0, "x");
    const b = new FrameState(fn, 0);
    b.setLocal(0, "y");
    expect(a.matches(b)).toBe(false);
  });

  it("does not match different stack", () => {
    const fn = { name: "fn" };
    const a = new FrameState(fn, 0);
    a.pushStack("x");
    const b = new FrameState(fn, 0);
    a.pushStack("y");
    expect(a.matches(b)).toBe(false);
  });

  it("does not match different local count", () => {
    const fn = { name: "fn" };
    const a = new FrameState(fn, 0);
    a.setLocal(0, "x");
    const b = new FrameState(fn, 0);
    expect(a.matches(b)).toBe(false);
  });
});

describe("FrameState inline chain", () => {
  it("getInlineChain returns chain from inner to outer", () => {
    const outer = new FrameState({ name: "outer" }, 0);
    const inner = new FrameState({ name: "inner" }, 5);
    inner.setCallerFrame(outer);
    const chain = inner.getInlineChain();
    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(inner);
    expect(chain[1]).toBe(outer);
  });

  it("getInlineDepth counts caller frames", () => {
    const a = new FrameState({ name: "a" }, 0);
    const b = new FrameState({ name: "b" }, 0);
    const c = new FrameState({ name: "c" }, 0);
    c.setCallerFrame(b);
    b.setCallerFrame(a);
    expect(c.getInlineDepth()).toBe(2);
    expect(b.getInlineDepth()).toBe(1);
    expect(a.getInlineDepth()).toBe(0);
  });

  it("setCallerFrame marks frame as inlined", () => {
    const caller = new FrameState({ name: "caller" }, 0);
    const callee = new FrameState({ name: "callee" }, 0);
    expect(callee.isInlinedFrame).toBe(false);
    callee.setCallerFrame(caller);
    expect(callee.isInlinedFrame).toBe(true);
    expect(callee.callerFrameState).toBe(caller);
  });
});

describe("FrameState toCompact", () => {
  it("includes function name, offset, local/stack counts", () => {
    const fs = new FrameState({ name: "myFunc" }, 42);
    fs.id = 3;
    fs.setLocal(0, "a");
    fs.setLocal(1, "b");
    fs.pushStack("s");
    const compact = fs.toCompact();
    expect(compact).toContain("myFunc");
    expect(compact).toContain("bc:42");
    expect(compact).toContain("L=2");
    expect(compact).toContain("S=1");
    expect(compact).toContain("fs#3");
  });

  it("shows [inlined] for inlined frames", () => {
    const caller = new FrameState({ name: "caller" }, 0);
    const callee = new FrameState({ name: "callee" }, 0);
    callee.setCallerFrame(caller);
    expect(callee.toCompact()).toContain("[inlined]");
  });

  it("shows [safepoint] when marked", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.markAsSafepoint();
    expect(fs.toCompact()).toContain("[safepoint]");
  });
});

describe("FrameState functionName", () => {
  it("returns function name or <anonymous>", () => {
    expect(new FrameState({ name: "foo" }, 0).functionName).toBe("foo");
    expect(new FrameState({}, 0).functionName).toBe("<anonymous>");
    expect(new FrameState(null, 0).functionName).toBe("<anonymous>");
  });
});

describe("FrameStateBuilder", () => {
  it("capture with Map locals", () => {
    const builder = new FrameStateBuilder();
    const locals = new Map([[0, "a"], [1, "b"]]);
    const fn = { name: "test" };
    const fs = builder.capture(fn, 10, locals, ["s1"], "thisVal", null);
    expect(fs.getLocal(0)).toBe("a");
    expect(fs.getLocal(1)).toBe("b");
    expect(fs.peekStack()).toBe("s1");
    expect(fs.thisValue).toBe("thisVal");
    expect(fs.bytecodeOffset).toBe(10);
    expect(fs.id).toBe(0);
  });

  it("capture with Array locals skips null/undefined", () => {
    const builder = new FrameStateBuilder();
    const fs = builder.capture({ name: "fn" }, 0, ["a", null, "c"], [], null, null);
    expect(fs.hasLocal(0)).toBe(true);
    expect(fs.hasLocal(1)).toBe(false);
    expect(fs.hasLocal(2)).toBe(true);
  });

  it("capture with callerFS sets caller frame", () => {
    const builder = new FrameStateBuilder();
    const caller = builder.capture({ name: "outer" }, 0, [], [], null, null);
    const callee = builder.capture({ name: "inner" }, 5, [], [], null, caller);
    expect(callee.isInlinedFrame).toBe(true);
    expect(callee.callerFrameState).toBe(caller);
  });

  it("getState retrieves by id", () => {
    const builder = new FrameStateBuilder();
    const fs0 = builder.capture({ name: "a" }, 0, [], [], null, null);
    const fs1 = builder.capture({ name: "b" }, 0, [], [], null, null);
    expect(builder.getState(0)).toBe(fs0);
    expect(builder.getState(1)).toBe(fs1);
    expect(builder.getState(999)).toBe(null);
  });

  it("count tracks number of captured states", () => {
    const builder = new FrameStateBuilder();
    expect(builder.count).toBe(0);
    builder.capture({ name: "fn" }, 0, [], [], null, null);
    builder.capture({ name: "fn" }, 0, [], [], null, null);
    expect(builder.count).toBe(2);
  });

  it("assigns sequential ids", () => {
    const builder = new FrameStateBuilder();
    const a = builder.capture({ name: "a" }, 0, [], [], null, null);
    const b = builder.capture({ name: "b" }, 0, [], [], null, null);
    expect(a.id).toBe(0);
    expect(b.id).toBe(1);
  });
});
