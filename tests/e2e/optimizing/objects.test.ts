import { describe, expect, it } from "vitest";
import { IR_GENERIC_DELETE_PROP } from "../../../src/optimizing/ir/index.js";
import { differential, src, baseline as baselineEngine, oracle as withoutJit, jit as withJit } from "./_tiers.js";

const driver = src(
  "fn driver(m):",
  "  k = 0",
  "  t = 0",
  "  while k < m:",
  "    t = run(5)",
  "    k = k + 1",
  "  return t",
  "driver(300)",
);

const tierUp = (body: string, name = "run") => {
  const source = src(body, driver);
  const engine = withJit();
  expect(engine.runNative(source)).toEqual(withoutJit().runNative(source));
  return engine.collectFunctions().find((fn) => fn.name === name);
};

describe("object literal allocation in optimized code", () => {
  it("keeps a single-property literal optimized", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {c: 0}",
      "  i = 0",
      "  while i < n:",
      "    p.c = p.c + i",
      "    i = i + 1",
      "  return p.c",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });

  it("keeps a multi-property literal optimized", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {x: 1, y: 2}",
      "  i = 0",
      "  while i < n:",
      "    p.x = p.x + i",
      "    i = i + 1",
      "  return p.x + p.y",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });

  it("keeps a literal with computed initializers optimized", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {x: n, y: n * 2}",
      "  return p.x + p.y",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });

  it("keeps non-numeric literal fields intact", () => {
    expect(differential(src(
      "fn run(n):",
      '  p = {s: "hi", v: n}',
      "  return p.v + p.s",
      driver,
    ))).toBe("5hi");
  });

  it("stays correct when a literal field is later assigned a string", () => {
    expect(differential(src(
      "fn run(n):",
      "  p = {x: n, y: 2}",
      '  p.y = "s"',
      "  return p.x + p.y",
      driver,
    ))).toBe("5s");
  });

  it("stays correct when initialization deoptimizes between stores", () => {
    expect(differential(src(
      "fn run(n):",
      "  p = {a: n, b: n * n * n}",
      "  return p.a + p.b",
      driver,
      "run(2000000)",
    ))).toBe(8000000000002000000);
  });

  it("stays correct when a literal is reallocated after a deoptimization", () => {
    expect(differential(src(
      "fn run(n):",
      "  p = {a: n, b: n + 1}",
      "  return p.a + p.b",
      driver,
      "a = run(2000000000)",
      "b = run(7)",
      "a + b",
    ))).toBe(4000000016);
  });

  it("keeps separate literals in one function distinct", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {a: n}",
      "  q = {b: n + 1}",
      "  return p.a + q.b",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });
});

type OptimizedFunction = {
  name?: string | null;
  dependencyDeoptCount?: number;
  optimizedCode?: unknown;
  optimizedStubSummary?: Array<{ opcode?: string }>;
  lastCompileFailureReason?: string | null;
};

const runOptimized = (source: string, name: string) => {
  const engine = withJit();
  const value = engine.runNative(source);
  expect(value).toEqual(withoutJit().runNative(source));
  const fn = engine
    .collectFunctions()
    .find((f) => (f as OptimizedFunction).name === name) as OptimizedFunction | undefined;
  return { value, dependencyDeopts: fn?.dependencyDeoptCount ?? 0, fn };
};

const mutatingCallee = src(
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
);

describe("shape-preserving stores keep optimized code alive", () => {
  it("does not invalidate a callee that writes its own speculated field", () => {
    const { value, dependencyDeopts } = runOptimized(mutatingCallee, "bump");
    expect(value).toEqual(2000);
    expect(dependencyDeopts).toBe(0);
  });

  it("does not invalidate on a direct field write loop", () => {
    const { value, dependencyDeopts } = runOptimized(
      src(
        "fn bump(o):",
        "  o.k = o.k + 1",
        "  return o.k",
        "fn run(n):",
        "  o = {k: 0}",
        "  i = 0",
        "  w = 0",
        "  while i < n:",
        "    w = bump(o)",
        "    i = i + 1",
        "  return o.k",
        "run(2000)",
      ),
      "bump",
    );
    expect(value).toEqual(2000);
    expect(dependencyDeopts).toBe(0);
  });

  it("does not invalidate when writing an overflow property", () => {
    const { dependencyDeopts } = runOptimized(
      src(
        "fn bump(o):",
        "  o.h = o.h + 1",
        "  return o.h",
        "fn run(n):",
        "  o = {a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7}",
        "  i = 0",
        "  w = 0",
        "  while i < n:",
        "    w = bump(o)",
        "    i = i + 1",
        "  return o.h",
        "run(2000)",
      ),
      "bump",
    );
    expect(dependencyDeopts).toBe(0);
  });

  it("still deoptimizes when a property is added to the speculated shape", () => {
    expect(
      runOptimized(
        src(
          "fn peek(o):",
          "  return o.k",
          "fn run(n):",
          "  o = {k: 1}",
          "  i = 0",
          "  s = 0",
          "  while i < n:",
          "    s = s + peek(o)",
          "    if i == 1000:",
          "      o.zz = 5",
          "    i = i + 1",
          "  return s",
          "run(2000)",
        ),
        "peek",
      ).value,
    ).toEqual(2000);
  });

  it("still deoptimizes when a property is deleted from the speculated shape", () => {
    expect(
      runOptimized(
        src(
          "fn peek(o):",
          "  return o.k",
          "fn run(n):",
          "  o = {k: 1, j: 2}",
          "  i = 0",
          "  s = 0",
          "  while i < n:",
          "    s = s + peek(o)",
          "    if i == 1000:",
          "      delete o.j",
          "    i = i + 1",
          "  return s",
          "run(2000)",
        ),
        "peek",
      ).value,
    ).toEqual(2000);
  });

  it("keeps a mutated field visible to a separately optimized reader", () => {
    expect(
      runOptimized(
        src(
          "fn bump(o):",
          "  o.k = o.k + 1",
          "  return 0",
          "fn peek(o):",
          "  return o.k",
          "fn run(n):",
          "  o = {k: 0}",
          "  i = 0",
          "  s = 0",
          "  while i < n:",
          "    bump(o)",
          "    s = peek(o)",
          "    i = i + 1",
          "  return s",
          "run(2000)",
        ),
        "peek",
      ).value,
    ).toEqual(2000);
  });

  it("keeps loop phis valid when a numeric initial value joins a call result", () => {
    const { value, fn } = runOptimized(
      src(
        "fn bump(o):",
        "  o.x = o.x + 1",
        "  return o.x",
        "fn run(n):",
        "  o = {x: 0}",
        "  i = 0",
        "  last = 0",
        "  while i < n:",
        "    last = bump(o)",
        "    i = i + 1",
        "  return last",
        driver,
      ),
      "run",
    );
    expect(value).toEqual(5);
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.lastCompileFailureReason).toBeNull();
  });
});

const icIsolationSource = src(
  "class Counter:",
  "  constructor():",
  "    this.n = 0",
  "  inc(x):",
  "    this.n = this.n + x",
  "    return this.n",
  "fn run(n):",
  "  c = Counter()",
  "  i = 0",
  "  while i < n:",
  "    c.inc((i % 3) + 1)",
  "    i = i + 1",
  "  return c.n",
  "fn driver(m):",
  "  k = 0",
  "  t = 0",
  "  while k < m:",
  "    t = run(64)",
  "    k = k + 1",
  "  return t",
  "driver(100)",
);

describe("inline cache isolation across engine heaps", () => {
  it("does not reuse handlers across separate engines", () => {
    expect(baselineEngine().runNative(icIsolationSource)).toBe(127);
    expect(withJit().runNative(icIsolationSource)).toBe(127);
  });
});

describe("delete property lowering in optimized code", () => {
  it("lowers static delete property through a wasm runtime stub", () => {
    const { value, fn } = runOptimized(
      src(
        "fn run(o):",
        "  delete o.j",
        "  return o.k + 0",
        "fn driver(m):",
        "  o = {j: 1, k: 6}",
        "  k = 0",
        "  t = 0",
        "  while k < m:",
        "    t = run(o)",
        "    k = k + 1",
        "  return t",
        "driver(300)",
      ),
      "run",
    );
    expect(value).toEqual(6);
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.lastCompileFailureReason).toBeNull();
    expect(
      fn?.optimizedStubSummary?.some((stub) => stub.opcode === IR_GENERIC_DELETE_PROP),
    ).toBe(true);
  });

  it("uses the runtime key for computed delete property", () => {
    expect(
      differential(
        src(
          "fn run(n):",
          "  key = 1",
          "  o = {a: n, b: n + 1}",
          "  delete o[key]",
          "  return o.a",
          driver,
        ),
      ),
    ).toEqual(5);
  });
});

const resetting = (reset: string, result: string) =>
  src(
    "g0 = ([1, 2])?.[6]",
    "fn mk(p0):",
    "  fn touch(q0):",
    "    g0 = ((g0 ** g0) | g0)",
    "    return g0",
    "  return touch",
    "fn run(n):",
    "  touched = mk(3)",
    "  last = 0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    `    g0 = ((g0 === "zzz") ? 0 : (${reset}))`,
    "    last = touched(3)",
    `  return ${result}`,
    "run(3000)",
  );

describe("globals mirrored into optimized code", () => {
  it("does not read a non-numeric global as a number", () => {
    for (const reset of ['({z: 1}).missing', "null", '"a"', "true", "[1]", "{a: 1}"]) {
      differential(resetting(reset, "last"));
    }
  });

  it("agrees on the type a non-numeric global reaches the callee with", () => {
    for (const reset of ['({z: 1}).missing', "null", '"7"', "true"]) {
      differential(resetting(reset, "typeof last"));
    }
  });

  it("keeps a non-numeric global visible to a later read", () => {
    differential(
      src(
        "g0 = 0",
        "fn touch(p0):",
        "  g0 = g0 | 1",
        "  return g0",
        "fn run(n):",
        '  seen = ""',
        "  i = 0",
        "  while i < n:",
        "    i = i + 1",
        '    g0 = "s"',
        "    touch(i)",
        "    seen = typeof g0",
        "  return seen",
        "run(2000)",
      ),
    );
  });

  it("keeps a numeric global fast path exact", () => {
    expect(
      differential(
        src(
          "g0 = 0",
          "fn touch(p0):",
          "  g0 = g0 + p0",
          "  return g0",
          "fn run(n):",
          "  i = 0",
          "  while i < n:",
          "    i = i + 1",
          "    g0 = i",
          "    touch(i)",
          "  return g0",
          "run(2000)",
        ),
      ),
    ).toEqual(2000);
  });
});
