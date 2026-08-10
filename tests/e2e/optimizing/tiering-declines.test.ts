import { describe, expect, it } from "vitest";
import { differential, src, tierUp } from "../../helpers/tiers.js";

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

const compiled = (body: string) => tierUp(src(body, driver), "run");

describe("heap-marshalling object code tiers up through runtime stubs", () => {
  it("optimizes a loop that mutates a global object and calls a heap-passing helper", () => {
    const fn = compiled(
      src(
        "g = {c: 0}",
        "fn make(x):",
        "  j = 0",
        "  a = [0, 0]",
        "  while j < 2:",
        "    a[j] = x + j",
        "    j = j + 1",
        "  return a",
        "fn run(n):",
        "  i = 0",
        "  while i < n:",
        "    g.c = g.c + i",
        "    v = make(i)",
        "    g.c = g.c + v[0]",
        "    i = i + 1",
        "  return g.c",
      ),
    );
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.lastCompileFailureReason ?? null).toBeNull();
  });

  it("optimizes a loopless leaf that allocates and returns a heap value", () => {
    const fn = tierUp(
      src("fn run(n):", "  a = [n, n + 1]", "  return [a[n % 2], a]", driver),
      "run",
    );
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.lastCompileFailureReason ?? null).toBeNull();
  });
});

describe("escaping global heap stores tier through runtime stubs", () => {
  it("optimizes a function that stores a fresh object into a global each iteration", () => {
    const fn = compiled(
      src(
        "g = {v: 0}",
        "fn run(n):",
        "  i = 0",
        "  while i < n:",
        "    g = {v: i}",
        "    i = i + 1",
        "  return g.v",
      ),
    );
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.lastCompileFailureReason ?? null).toBeNull();
  });
});

describe("self-recursive heap-returning functions tier through runtime stubs", () => {
  const program = src(
    "g0 = 0.5",
    "g2 = [1]",
    "fn f0(p0, p1):",
    "  if (p0 <= 0):",
    "    return {b: g0, z: (~ p0), d: (true ? g2 : g2)}",
    "  v1 = [(p1)?.d]",
    "  return (f0((p0 - 1), ((g0 & g0) >>> 14)) + p0)",
    "fn run(n):",
    "  acc = 0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    '    acc = (acc + (f0(5, "ab") + i))',
    "  return acc",
    "fn driver(m):",
    "  k = 0",
    "  t = 0",
    "  while (k < m):",
    "    k = (k + 1)",
    "    t = run(12)",
    "  return t",
    "r0 = run(1200)",
    "r1 = driver(800)",
    "[r0, r1]",
  );

  it("agrees with the oracle across every tier and optimizes f0", () => {
    differential(program);
    const f0 = tierUp(program, "f0");
    expect(f0?.optimizedCode).toBeTruthy();
    expect(f0?.lastCompileFailureReason ?? null).toBeNull();
  });
});

describe("self-recursive numeric functions tier up", () => {
  it("optimizes a recursive numeric result without changing its call representation", () => {
    const program = src(
      "fn fact(n):",
      "  if n <= 1:",
      "    return 1",
      "  return n * fact(n - 1)",
      "fn driver(m):",
      "  k = 0",
      "  t = 0",
      "  while k < m:",
      "    t = fact(5)",
      "    k = k + 1",
      "  return t",
      "driver(300)",
    );
    differential(program);
    const fact = tierUp(program, "fact");
    expect(fact?.optimizedCode).toBeTruthy();
    expect(fact?.lastCompileFailureReason ?? null).toBeNull();
  });
});

describe("closure allocation tiers through context cells", () => {
  it("optimizes a function that returns a closure capturing a local", () => {
    const program = src(
      "fn make(n):",
      "  x = n + 1",
      "  fn inner():",
      "    return x + 2",
      "  return inner",
      "fn run(n):",
      "  f = make(n)",
      "  return f()",
      "fn driver(m):",
      "  k = 0",
      "  t = 0",
      "  while k < m:",
      "    t = run(5)",
      "    k = k + 1",
      "  return t",
      "driver(300)",
    );
    differential(program);
    const make = tierUp(program, "make");
    expect(make?.optimizedCode).toBeTruthy();
    expect(make?.lastCompileFailureReason ?? null).toBeNull();
  });

  it("keeps captured local stores aliased after closure creation", () => {
    const program = src(
      "fn run(n):",
      "  x = n",
      "  fn inner():",
      "    return x",
      "  x = x + 1",
      "  return inner()",
      "fn driver(m):",
      "  k = 0",
      "  t = 0",
      "  while k < m:",
      "    t = run(5)",
      "    k = k + 1",
      "  return t",
      "driver(300)",
    );
    differential(program);
    const run = tierUp(program, "run");
    expect(run?.optimizedCode).toBeTruthy();
    expect(run?.lastCompileFailureReason ?? null).toBeNull();
  });

  it("optimizes closure bodies that read and write captured locals", () => {
    const program = src(
      "fn make(base):",
      "  x = base",
      "  fn add(y):",
      "    x = x + y",
      "    return x",
      "  return add",
      "fn run(n):",
      "  f = make(3)",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    s = s + f((i % 5) + 1)",
      "    i = i + 1",
      "  return s",
      "fn driver(m):",
      "  k = 0",
      "  t = 0",
      "  while k < m:",
      "    t = run(40 + (k % 3))",
      "    k = k + 1",
      "  return t",
      "driver(300)",
    );
    differential(program);
    const add = tierUp(program, "add");
    expect(add?.optimizedCode).toBeTruthy();
    expect(add?.lastCompileFailureReason ?? null).toBeNull();
  });

  it("resumes deoptimized closure bodies with their captured environment", () => {
    const program = src(
      "fn make():",
      "  x = 0",
      "  fn add(y):",
      "    x = x + y",
      "    return x",
      "  return add",
      "f = make()",
      "fn warm(n):",
      "  i = 0",
      "  r = 0",
      "  while i < n:",
      "    r = f(1)",
      "    i = i + 1",
      "  return r",
      "r0 = warm(300)",
      'r1 = f("x")',
      "r2 = f(2)",
      "[r0, r1, r2]",
    );
    differential(program);
  });

  it("optimizes nested closure creation that captures an outer upvalue", () => {
    const program = src(
      "fn make(seed):",
      "  x = seed",
      "  fn middle(n):",
      "    y = n",
      "    fn inner(z):",
      "      x = x + z",
      "      return x + y",
      "    return inner",
      "  return middle",
      "fn run(n):",
      "  m = make(5)",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    f = m(i % 7)",
      "    s = s + f(2)",
      "    i = i + 1",
      "  return s",
      "fn driver(m):",
      "  k = 0",
      "  t = 0",
      "  while k < m:",
      "    t = run(38 + (k % 4))",
      "    k = k + 1",
      "  return t",
      "driver(300)",
    );
    differential(program);
    const middle = tierUp(program, "middle");
    expect(middle?.optimizedCode).toBeTruthy();
    expect(middle?.lastCompileFailureReason ?? null).toBeNull();
  });
});

describe("functions that should still tier up are not over-declined", () => {
  it("JITs a global-object mutation loop with no calls (LICM keeps it fast)", () => {
    const fn = compiled(
      src(
        "q = {c: 0}",
        "fn run(n):",
        "  i = 0",
        "  while i < n:",
        "    q.c = q.c + i",
        "    i = i + 1",
        "  return q.c",
      ),
    );
    expect(fn?.optimizedCode).toBeTruthy();
  });

  it("JITs a local object mutation loop (no global, no call)", () => {
    const fn = compiled(
      src(
        "fn run(n):",
        "  p = {c: 0}",
        "  i = 0",
        "  while i < n:",
        "    p.c = p.c + i",
        "    i = i + 1",
        "  return p.c",
      ),
    );
    expect(fn?.optimizedCode).toBeTruthy();
  });

  it("JITs a loopless function that only returns strings (no alloc, no dynamic access)", () => {
    const fn = compiled(
      src("fn run(n):", "  if n % 2 == 0:", '    return "even"', '  return "odd"'),
    );
    expect(fn?.optimizedCode).toBeTruthy();
  });
});
