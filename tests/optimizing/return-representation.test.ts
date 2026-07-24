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
          [
            "fn step(a,i):",
            "  if i == 40000:",
            "    return \"x\"",
            "  return a + 1",
          ],
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
          [
            "fn step(a,i):",
            "  if i == 99999999:",
            "    return \"x\"",
            "  return a + 1",
          ],
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
          [
            "fn step(a,i):",
            "  if i == 40000:",
            "    return typeof a",
            "  return a + 1",
          ],
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
      "    return \"even\"",
      "  return \"odd\"",
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

  it("stops retrying a function the wasm backend cannot compile", () => {
    const engine = withJit();
    engine.runNative(
      stepping(
        ["fn step(a,i):", "  if i == 40000:", "    return \"x\"", "  return a + 1"],
        guarded,
        60000,
      ),
    );
    const step = engine.collectFunctions().find((fn) => fn.name === "step");
    expect(step?.optimizedCode).toBeFalsy();
    expect(step?.compileFailureCount ?? 0).toBeLessThan(10);
  });
});
