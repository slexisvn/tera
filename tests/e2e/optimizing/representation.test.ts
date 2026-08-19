import { describe, expect, it } from "vitest";
import { differential, src, oracle as withoutJit, jit as withJit } from "../../helpers/tiers.js";

const stepping = (body: string[], consume: string[], n: number) =>
  src(
    ...body,
    "fn run(n):",
    "  acc = 0",
    "  i = 0",
    "  while i < n:",
    "    v = step(acc, i)",
    ...consume,
    "    i = i + 1",
    "  return acc",
    `run(${n})`,
  );

const guarded = ["    if i != 40000:", "      acc = v"];

describe("optimized return values keep their representation", () => {
  it("keeps a guarded assignment from taking a string result", () => {
    expect(
      differential(
        stepping(
          ["fn step(a,i):", "  if i == 40000:", '    return "x"', "  return a + 1"],
          guarded,
          60000,
        ),
      ),
    ).toEqual(59999);
  });

  it("keeps a guarded assignment from taking a boolean result", () => {
    expect(
      differential(
        stepping(
          ["fn step(a,i):", "  if i == 40000:", "    return true", "  return a + 1"],
          guarded,
          60000,
        ),
      ),
    ).toEqual(59999);
  });

  it("keeps a guarded assignment from taking a null result", () => {
    expect(
      differential(
        stepping(
          ["fn step(a,i):", "  if i == 40000:", "    return null", "  return a + 1"],
          guarded,
          60000,
        ),
      ),
    ).toEqual(59999);
  });

  it("does not read a numeric result as a constant-pool handle", () => {
    expect(
      differential(
        stepping(
          ["fn step(a,i):", "  if i == 99999999:", '    return "x"', "  return a + 1"],
          ["    acc = v"],
          60000,
        ),
      ),
    ).toEqual(60000);
  });

  it("does not read a numeric result as an object handle", () => {
    expect(
      differential(
        src(
          "fn step(o, a):",
          "  return a + o.k",
          "fn run(n):",
          "  o = {k: 1}",
          "  acc = 0",
          "  i = 0",
          "  while i < n:",
          "    acc = step(o, acc)",
          "    i = i + 1",
          "  return acc",
          "run(4000)",
        ),
      ),
    ).toEqual(4000);
  });

  it("does not read a numeric result as an array handle", () => {
    expect(
      differential(
        src(
          "fn step(arr, a):",
          "  return a + arr[0]",
          "fn run(n):",
          "  arr = [1, 2]",
          "  acc = 0",
          "  i = 0",
          "  while i < n:",
          "    acc = step(arr, acc)",
          "    i = i + 1",
          "  return acc",
          "run(4000)",
        ),
      ),
    ).toEqual(4000);
  });

  it("does not truncate a float return when another return is an integer", () => {
    expect(
      differential(
        src(
          "fn step(a,i):",
          "  if i == 99999999:",
          "    return 1",
          "  return a + 0.5",
          "fn run(n):",
          "  i = 0",
          "  last = 0",
          "  while i < n:",
          "    last = step(i, i)",
          "    i = i + 1",
          "  return last",
          "run(2000)",
        ),
      ),
    ).toEqual(1999.5);
  });

  it("keeps mixed integer and float returns exact", () => {
    expect(
      differential(
        src(
          "fn step(a,i):",
          "  if i % 2 == 0:",
          "    return a * 2",
          "  return a / 4",
          "fn run(n):",
          "  i = 0",
          "  last = 0",
          "  while i < n:",
          "    last = step(i, i)",
          "    i = i + 1",
          "  return last",
          "run(2000)",
        ),
      ),
    ).toEqual(1999 / 4);
  });

  it("keeps a typeof result distinct from a numeric result", () => {
    expect(
      differential(
        stepping(
          ["fn step(a,i):", "  if i == 40000:", "    return typeof a", "  return a + 1"],
          guarded,
          60000,
        ),
      ),
    ).toEqual(59999);
  });

  it("still optimizes a function whose returns share one representation", () => {
    const source = src(
      "fn step(a,i):",
      "  if i % 2 == 0:",
      "    return a + 1",
      "  return a + 2",
      "fn run(n):",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    acc = step(acc, i)",
      "    i = i + 1",
      "  return acc",
      "run(4000)",
    );
    const engine = withJit();
    expect(engine.runNative(source)).toEqual(withoutJit().runNative(source));
    const step = engine.collectFunctions().find((fn) => fn.name === "step");
    expect(step?.optimizedCode).toBeTruthy();
  });

  it("still optimizes a function that only returns strings", () => {
    const source = src(
      "fn step(a,i):",
      "  if i % 2 == 0:",
      '    return "even"',
      '  return "odd"',
      "fn run(n):",
      "  i = 0",
      "  last = 0",
      "  while i < n:",
      "    last = step(i, i)",
      "    i = i + 1",
      "  return last",
      "run(4000)",
    );
    const engine = withJit();
    expect(engine.runNative(source)).toEqual(withoutJit().runNative(source));
    const step = engine.collectFunctions().find((fn) => fn.name === "step");
    expect(step?.optimizedCode).toBeTruthy();
  });

  const mixedReturn = (cold: string) =>
    stepping(["fn step(a,i):", "  if i == 40000:", `    ${cold}`, "  return a + 1"], guarded, 60000);

  const declines = (source: string) => {
    const engine = withJit();
    expect(engine.runNative(source)).toEqual(withoutJit().runNative(source));
    const step = engine.collectFunctions().find((fn) => fn.name === "step");
    expect(step?.optimizedCode).toBeFalsy();
    expect(step?.lastCompileFailureReason).toContain("boxes a numeric return into a handle on a hot path");
    return step;
  };

  it("declines a hot numeric return that a string return forces into a handle", () => {
    declines(mixedReturn('return "x"'));
  });

  it("declines a hot numeric return that an object return forces into a handle", () => {
    declines(mixedReturn("return {v: 1}"));
  });

  it("declines a hot numeric return that a boolean return forces into a handle", () => {
    declines(mixedReturn("return true"));
  });

  it("still optimizes when the boxed numeric return is the cold path", () => {
    const source = stepping(
      ["fn step(a,i):", "  if i == 40000:", "    return a + 1", '  return "x"'],
      ["    if i == 40000:", "      acc = v"],
      60000,
    );
    const engine = withJit();
    expect(engine.runNative(source)).toEqual(withoutJit().runNative(source));
    const step = engine.collectFunctions().find((fn) => fn.name === "step");
    expect(step?.optimizedCode).toBeTruthy();
    expect(step?.lastCompileFailureReason ?? null).toBeNull();
  });

  it("keeps an unguarded field return a handle", () => {
    const source = src(
      'g = {x: "hello"}',
      "fn step(i):",
      "  return g.x",
      "fn run(n):",
      "  i = 0",
      "  last = 0",
      "  while i < n:",
      "    last = step(i)",
      "    i = i + 1",
      '  return "" + last',
      "run(200)",
    );
    const engine = withJit();
    expect(engine.runNative(source)).toEqual(withoutJit().runNative(source));
    const step = engine.collectFunctions().find((fn) => fn.name === "step");
    expect(step?.optimizedCode).toBeTruthy();
  });

  it("stops retrying a function the wasm backend cannot compile", () => {
    const engine = withJit();
    engine.runNative(
      stepping(
        [
          "fn step(a,i):",
          "  near = (i > 1 and i < 5) or (i > 100 and i < 200)",
          "  if near:",
          "    return a + 1",
          "  return a + 2",
        ],
        ["    acc = v"],
        60000,
      ),
    );
    const step = engine.collectFunctions().find((fn) => fn.name === "step");
    expect(step?.optimizedCode).toBeFalsy();
    expect(step?.lastCompileFailureReason).toBeTruthy();
    expect(step?.disableOptimization).toBe(false);
    expect(step?.compileFailureCount ?? 0).toBeLessThan(10);
  });
});

const observed = (body: string, observation: string) =>
  src(
    "fn f0(p0):",
    `  return ${body}`,
    "fn run(n):",
    "  last = 0",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    `    last = ${observation}`,
    "  return last",
    "run(1200)",
  );

const concatenated = (body: string) => observed(body, '"" + f0(1)');

describe("block parameter representation", () => {
  it("keeps a boolean returned out of a logical operator a boolean", () => {
    for (const [body, expected] of [
      ["true and true", "true"],
      ["true or false", "true"],
      ["false or true", "true"],
      ["true and false", "false"],
      ["(p0 == 1) and true", "true"],
      ["p0 and true", "true"],
    ] as const) {
      expect(differential(concatenated(body))).toEqual(expected);
    }
  });

  it("reports the boolean type of a logical operator result", () => {
    expect(differential(observed("true and true", "typeof f0(1)"))).toEqual("boolean");
    expect(differential(observed("false or true", "typeof f0(1)"))).toEqual("boolean");
  });

  it("keeps a logical operator result strictly equal to a boolean", () => {
    expect(differential(observed("true and true", "f0(1) === true"))).toEqual(true);
    expect(differential(observed("true and false", "f0(1) === false"))).toEqual(true);
  });

  it("keeps a boolean mixed with a non-boolean operand a boolean", () => {
    for (const body of ['"a" and true', "1 and true", "0 or true", '"" or true', "null or true"]) {
      expect(differential(concatenated(body))).toEqual("true");
    }
  });

  it("keeps a number flowing out of a logical operator away from the handle table", () => {
    for (const value of [1, 1023, 1024, 1025, 2048, 49151, 49152, 49153]) {
      expect(differential(concatenated(`${value} or "a"`))).toEqual(String(value));
      expect(differential(concatenated(`${value} or null`))).toEqual(String(value));
    }
  });

  it("keeps the non-boolean branch of a logical operator intact", () => {
    for (const [body, expected] of [
      ['true and "a"', "a"],
      ["true and 1", "1"],
      ['"a" or 1', "a"],
      ['"" or "b"', "b"],
      ["0 or 1.5", "1.5"],
    ] as const) {
      expect(differential(concatenated(body))).toEqual(expected);
    }
  });

  it("keeps a boolean merged across an if/else a boolean", () => {
    expect(
      differential(
        src(
          "fn f0(p0):",
          "  if p0 % 2 == 0:",
          "    w = true",
          "  else:",
          "    w = false",
          "  return w",
          "fn run(n):",
          "  last = 0",
          "  i = 0",
          "  while i < n:",
          "    i = i + 1",
          '    last = "" + f0(i)',
          "  return last",
          "run(1200)",
        ),
      ),
    ).toEqual("true");
  });
});

const warmThenProbe = (body: string[], warmArgs: string, probeArgs: string) =>
  src(
    ...body,
    "fn run(n):",
    "  i = 0",
    "  w = 0",
    "  while i < n:",
    `    w = step(${warmArgs})`,
    "    i = i + 1",
    `  return step(${probeArgs})`,
    "run(2000)",
  );

const forwarding = [
  "fn inner(a,i):",
  "  return a + 1",
  "fn step(a,i):",
  "  return inner(a, i)",
];

describe("arguments forwarded through optimized calls", () => {
  it("keeps a numeric argument numeric across a forwarded call", () => {
    for (const value of [1023, 1024, 1025, 1032, 2048, 49152]) {
      expect(differential(warmThenProbe(forwarding, "0, i", `${value}, 0`))).toEqual(
        value + 1,
      );
    }
  });

  it("does not turn a numeric argument into a callee handle", () => {
    expect(
      differential(
        warmThenProbe(
          ["fn inner(a,i):", "  return typeof a", "fn step(a,i):", "  return inner(a, i)"],
          "0, i",
          "1024, 0",
        ),
      ),
    ).toEqual("number");
  });

  it("accumulates through a forwarded call across the handle range", () => {
    expect(
      differential(
        src(
          ...forwarding,
          "fn run(n):",
          "  acc = 0",
          "  i = 0",
          "  while i < n:",
          "    acc = step(acc, i)",
          "    i = i + 1",
          "  return acc",
          "run(2000)",
        ),
      ),
    ).toEqual(2000);
  });

  it("keeps a guarded assignment correct through a forwarded call", () => {
    expect(
      differential(
        src(
          "fn inner(a,i):",
          "  if i == 40000:",
          "    return 0 - 5",
          "  return a + 1",
          "fn step(a,i):",
          "  return inner(a, i)",
          "fn run(n):",
          "  acc = 0",
          "  i = 0",
          "  while i < n:",
          "    v = step(acc, i)",
          "    if i != 40000:",
          "      acc = v",
          "    i = i + 1",
          "  return acc",
          "run(52000)",
        ),
      ),
    ).toEqual(51999);
  });

  it("forwards arguments correctly through a three-deep chain", () => {
    expect(
      differential(
        warmThenProbe(
          ["fn c(a):", "  return a + 1", "fn b(a):", "  return c(a)", "fn step(a,i):", "  return b(a)"],
          "0, i",
          "1024, 0",
        ),
      ),
    ).toEqual(1025);
  });

  it("keeps argument order when a forwarded call swaps them", () => {
    expect(
      differential(
        warmThenProbe(
          ["fn inner(a,b):", "  return b - a", "fn step(a,b):", "  return inner(b, a)"],
          "0, 1",
          "1024, 7",
        ),
      ),
    ).toEqual(1017);
  });

  it("reuses a forwarded argument numerically after the call", () => {
    expect(
      differential(
        warmThenProbe(
          ["fn inner(a,i):", "  return a + 1", "fn step(a,i):", "  t = inner(a, i)", "  return t + a"],
          "0, i",
          "1024, 0",
        ),
      ),
    ).toEqual(2049);
  });

  it("passes the same argument to two different callees", () => {
    expect(
      differential(
        warmThenProbe(
          ["fn f(a):", "  return a + 1", "fn g(a):", "  return a + 2", "fn step(a,i):", "  return f(a) + g(a)"],
          "0, i",
          "1024, 0",
        ),
      ),
    ).toEqual(2051);
  });

  it("keeps a float argument exact through a forwarded call", () => {
    expect(
      differential(
        warmThenProbe(
          ["fn inner(a,i):", "  return a + 0.5", "fn step(a,i):", "  return inner(a, i)"],
          "0, i",
          "1024, 0",
        ),
      ),
    ).toEqual(1024.5);
  });

  it("keeps an object argument alongside a numeric one", () => {
    expect(
      differential(
        src(
          "fn inner(o, a):",
          "  return o.k + a",
          "fn step(o, a):",
          "  return inner(o, a)",
          "fn run(n):",
          "  o = {k: 3}",
          "  i = 0",
          "  w = 0",
          "  while i < n:",
          "    w = step(o, 0)",
          "    i = i + 1",
          "  return step(o, 1024)",
          "run(2000)",
        ),
      ),
    ).toEqual(1027);
  });

  it("keeps a string argument alongside a numeric one", () => {
    expect(
      differential(
        warmThenProbe(
          ["fn inner(s, a):", "  return s + a", "fn step(s, a):", "  return inner(s, a)"],
          '"p", 0',
          '"p", 1024',
        ),
      ),
    ).toEqual("p1024");
  });

  it("keeps object mutation visible through a forwarded call", () => {
    expect(
      differential(
        src(
          "fn bump(o):",
          "  o.k = o.k + 1",
          "  return o.k",
          "fn step(o):",
          "  return bump(o)",
          "fn run(n):",
          "  o = {k: 0}",
          "  i = 0",
          "  w = 0",
          "  while i < n:",
          "    w = step(o)",
          "    i = i + 1",
          "  return o.k",
          "run(2000)",
        ),
      ),
    ).toEqual(2000);
  });
});
