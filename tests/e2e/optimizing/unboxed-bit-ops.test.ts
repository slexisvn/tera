import { describe, expect, it } from "vitest";
import { differential, src, type Tier } from "../../helpers/tiers.js";

const jitTiers: Tier[] = ["baseline", "jit", "osr"];

const hotLoop = (expression: string) =>
  src(
    "fn run(n: int) -> int:",
    "  acc = 0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    `    acc = ${expression}`,
    "  return acc",
    "x = run(1200)",
    "[x]",
  );

const hotFloatLoop = (expression: string) =>
  src(
    "fn run(n: int) -> float:",
    "  acc = 0.0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    `    acc = ${expression}`,
    "  return acc",
    "x = run(1200)",
    "[x]",
  );

describe("unboxed representation for bitwise and power operations", () => {
  it("agrees across tiers for bitwise or", () => {
    expect(differential(hotLoop("((acc | i) & 65535)"), { tiers: jitTiers })).toEqual([2047]);
  });

  it("agrees across tiers for bitwise xor", () => {
    expect(differential(hotLoop("((acc ^ i) & 1023)"), { tiers: jitTiers })).toEqual([176]);
  });

  it("agrees across tiers for bitwise not", () => {
    differential(hotLoop("(~i | 0)"), { tiers: jitTiers });
  });

  it("agrees across tiers for chained or, xor and not", () => {
    differential(hotLoop("(((acc | i) ^ (~i)) & 262143)"), { tiers: jitTiers });
  });

  it("keeps unsigned shift results outside the smi range correct", () => {
    expect(
      differential(
        src(
          "fn run(n: int) -> float:",
          "  acc = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    acc = ((0 - i) >>> 0)",
          "  return acc",
          "x = run(1200)",
          "[x]",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([4294966096]);
  });

  it("agrees across tiers for unsigned shift feeding a bitwise consumer", () => {
    differential(hotLoop("((((0 - i) >>> 8) | acc) & 1048575)"), { tiers: jitTiers });
  });

  it("agrees across tiers for float power", () => {
    expect(differential(hotFloatLoop("((i * 1.0) ** 2.0)"), { tiers: jitTiers })).toEqual([
      1200 ** 2,
    ]);
  });

  it("agrees across tiers for float power combined with float arithmetic", () => {
    differential(hotFloatLoop("(acc + ((i * 0.5) ** 2.0))"), { tiers: jitTiers });
  });
});
