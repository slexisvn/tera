import { describe, it, expect } from "vitest";
import { Engine } from "../../../src/api/engine.js";

describe("baseline inline caches are isolated per function (not by name)", () => {
  it("redefining same-named function with a different object shape does not pollute IC", () => {
    const engine = new Engine({
      tieringPolicy: { jitThreshold: 99999, baselineThreshold: 2 },
    });
    engine.run(`
      fn f():
        o = { a: 1 }
        return o.a
      r = 0
      for k of range(60):
        r = f()
    `);
    const second = engine.runValue(
      `
        fn f():
          o = { p: 0, q: 11 }
          return o.p * o.q + o.p
        r = 0
        for k of range(60):
          r = f()
        r
      `,
    ).value;
    expect(second).toBe(0);
  });

  it("two distinct hot functions with the same name keep separate property caches", () => {
    const engine = new Engine({
      tieringPolicy: { jitThreshold: 99999, baselineThreshold: 2 },
    });
    engine.run(`
      fn g():
        o = { x: 5 }
        return o.x
      for k of range(60):
        g()
    `);
    expect(
      engine.runValue(
        `
          fn g():
            o = { y: 9, z: 7 }
            return o.y + o.z
          r = 0
          for k of range(60):
            r = g()
          r
        `,
      ).value,
    ).toBe(16);
  });
});

describe("baseline compiler bails to interpreter on unsupported opcodes", () => {
  const run = (src) => {
    const engine = new Engine({
      tieringPolicy: { jitThreshold: 99999, baselineThreshold: 2 },
    });
    return engine.runValue(src).value;
  };

  it("object-rest destructuring stays correct past the baseline threshold", () => {
    expect(
      run(
        `fn f(o):
  {a, ...rest} = o
  return a + Object.keys(rest).length
s = 0
i = 0
while i < 10:
  s = f({a: i, b: 1, c: 2})
  i = i + 1
s`,
      ),
    ).toBe(11);
  });

  it("array-rest destructuring stays correct past the baseline threshold", () => {
    expect(
      run(
        `fn f(arr):
  [x, ...y] = arr
  return x + y.length
s = 0
i = 0
while i < 10:
  s = f([i, 1, 2, 3])
  i = i + 1
s`,
      ),
    ).toBe(12);
  });

  it("arguments object stays correct past the baseline threshold", () => {
    expect(
      run(
        `fn f():
  t = 0
  j = 0
  while j < arguments.length:
    t = t + arguments[j]
    j = j + 1
  return t
s = 0
i = 0
while i < 10:
  s = f(1, 2, 3)
  i = i + 1
s`,
      ),
    ).toBe(6);
  });
});
