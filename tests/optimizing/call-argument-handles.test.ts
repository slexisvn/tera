import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const src = (...lines: string[]) => lines.join("\n");

const withoutJit = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
  });

const withJit = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  });

const withOsr = () =>
  new Engine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  });

const differential = (source: string) => {
  const expected = withoutJit().runNative(source);
  expect(withJit().runNative(source)).toEqual(expected);
  expect(withOsr().runNative(source)).toEqual(expected);
  return expected;
};

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
          [
            "fn c(a):",
            "  return a + 1",
            "fn b(a):",
            "  return c(a)",
            "fn step(a,i):",
            "  return b(a)",
          ],
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
          [
            "fn inner(a,i):",
            "  return a + 1",
            "fn step(a,i):",
            "  t = inner(a, i)",
            "  return t + a",
          ],
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
          [
            "fn f(a):",
            "  return a + 1",
            "fn g(a):",
            "  return a + 2",
            "fn step(a,i):",
            "  return f(a) + g(a)",
          ],
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
          [
            "fn inner(a,i):",
            "  return a + 0.5",
            "fn step(a,i):",
            "  return inner(a, i)",
          ],
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
