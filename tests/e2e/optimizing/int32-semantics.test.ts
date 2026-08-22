import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import { differential, src } from "../../helpers/tiers.js";
import { cSource, itNative, runCFunction } from "../../helpers/c-executor.js";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function declared(expression: string): string {
  return src("fn f(a: int, b: int) -> int:", `  return ${expression}`);
}

function hot(expression: string, a: number, b: number): string {
  return src(
    declared(expression),
    "fn run(n):",
    "  last = 0",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    `    last = f(${a}, ${b})`,
    "  return last",
    "run(1200)",
  );
}

function native(expression: string, a: number, b: number): number {
  const program = nodeEngine().compileAot(`${declared(expression)}\n`, {
    functionNames: ["f"],
  });
  expect(program.skipped).toEqual([]);
  return runCFunction(cSource(program), "f", [a, b]);
}

function everyTier(expression: string, a: number, b: number): unknown {
  const interpreted = differential(hot(expression, a, b));
  expect(native(expression, a, b)).toBe(interpreted);
  return interpreted;
}

describe("declared int semantics across tiers", () => {
  itNative("agrees on arithmetic that stays inside int32", () => {
    expect(everyTier("a + b", 3, 4)).toBe(7);
    expect(everyTier("a - b", 3, 4)).toBe(-1);
    expect(everyTier("a * b", 100000, 20000)).toBe(2000000000);
    expect(everyTier("a % b", 17, 5)).toBe(2);
  });

  itNative("agrees on bit operations at the 32-bit boundary", () => {
    expect(everyTier("a << b", 1, 31)).toBe(INT32_MIN);
    expect(everyTier("a >> b", INT32_MIN, 31)).toBe(-1);
    expect(everyTier("a | b", INT32_MIN, 0)).toBe(INT32_MIN);
    expect(everyTier("a & b", INT32_MAX, INT32_MIN)).toBe(0);
    expect(everyTier("a ^ b", INT32_MAX, INT32_MIN)).toBe(-1);
  });

  itNative("agrees on arithmetic that overflows int32", () => {
    everyTier("a + b", 1073741824, 1073741824);
    everyTier("a - b", INT32_MIN, 1);
    everyTier("a * b", 65536, 65536);
  });

  itNative("wraps overflowing declared int arithmetic in compiled code", () => {
    expect(native("a + b", 1073741824, 1073741824)).toBe(INT32_MIN);
    expect(native("a - b", INT32_MIN, 1)).toBe(INT32_MAX);
    expect(native("a * b", 65536, 65536)).toBe(0);
  });

  it("wraps a declared int return in every interpreted tier too", () => {
    expect(differential(hot("a + b", 1073741824, 1073741824))).toBe(INT32_MIN);
    expect(differential(hot("a - b", INT32_MIN, 1))).toBe(INT32_MAX);
    expect(differential(hot("a * b", 65536, 65536))).toBe(0);
  });

  it("leaves a value the declaration does not describe alone", () => {
    const engine = nodeEngine();
    expect(engine.runNative(src("fn f(a: int) -> int:", "  return a / 2", "f(5)"))).toBe(2.5);
  });
});
