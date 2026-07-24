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
