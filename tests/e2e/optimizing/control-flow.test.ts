import { describe, expect, it } from "vitest";
import { differential, src, jit as withJit, oracle as withoutJit } from "../../helpers/tiers.js";

const called = (...body: string[]) =>
  src(
    "fn f0(p0):",
    ...body,
    "  return 1",
    "fn run(n):",
    "  acc = 5",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    "    last = f0(acc)",
    "  return acc",
    "run(1200)",
  );

describe("control flow emission", () => {
  it("keeps a short circuit inside a never-taken branch out of the wasm body", () => {
    for (const guarded of ["([1])?.[0]", "({a: 1})?.a", "(p0)?.a", "([1])?.length"]) {
      expect(differential(called("  if false:", `    v1 = ${guarded}`))).toEqual(5);
    }
  });

  it("keeps a short circuit inside a taken branch correct", () => {
    for (const guarded of ["([1])?.[0]", "({a: 1})?.a", "(p0)?.a"]) {
      expect(differential(called("  if true:", `    v1 = ${guarded}`))).toEqual(5);
    }
  });

  it("keeps statements after a branch that contains a short circuit", () => {
    expect(
      differential(
        called("  if false:", "    v1 = ([1])?.[0]", '  v2 = "" + p0', "  v3 = p0 * 2"),
      ),
    ).toEqual(5);
  });

  it("keeps a short circuit in a branch that returns", () => {
    expect(
      differential(
        src(
          "fn f0(p0):",
          "  if p0 < 0:",
          "    v1 = ([1])?.[0]",
          "    return v1",
          "  return 1",
          "fn run(n):",
          "  acc = 0",
          "  i = 0",
          "  while i < n:",
          "    i = i + 1",
          "    acc = acc + f0(i)",
          "  return acc",
          "run(1200)",
        ),
      ),
    ).toEqual(1200);
  });

  it("keeps nested short circuits inside a never-taken branch", () => {
    expect(
      differential(
        called("  if false:", "    v1 = (({a: [1]})?.a)?.[0]", '  v2 = "" + p0'),
      ),
    ).toEqual(5);
  });

  it("emits nested branch merges inside loops", () => {
    const source = src(
      "fn run(n):",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    if i < 4:",
      "      if i < 2:",
      "        s = s + 3",
      "      else:",
      "        s = s + 5",
      "    else:",
      "      s = s + 7",
      "    i = i + 1",
      "  return s",
      "fn driver(m):",
      "  i = 0",
      "  last = 0",
      "  while i < m:",
      "    last = run(5)",
      "    i = i + 1",
      "  return last",
      "driver(300)",
    );
    const engine = withJit();
    expect(engine.runNative(source)).toEqual(withoutJit().runNative(source));
    const run = engine.collectFunctions().find((fn) => fn.name === "run");
    expect(run?.optimizedCode).toBeTruthy();
    expect(run?.lastCompileFailureReason ?? null).toBeNull();
  });
});
