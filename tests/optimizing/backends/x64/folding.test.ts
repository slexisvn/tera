import { describe, expect, it } from "vitest";
import { bodyOf } from "../../../helpers/x64-assembly.js";

const src = (...lines: string[]) => lines.join("\n");

const MASKS = src("fn mask(a: int) -> int:", "  return a & 7");

const WIDENS = src("fn widen(a: int) -> int:", "  return a | 70000");

const SUMS = src(
  "fn sum(xs: float[], n: int) -> float:",
  "  acc: float = 0.0",
  "  i: int = 0",
  "  while i < n:",
  "    acc = acc + xs[i]",
  "    i = i + 1",
  "  return acc",
);

const AREAS = src(
  "class Box:",
  "  public w: float",
  "  public h: float",
  "  public constructor(w: float, h: float):",
  "    this.w = w",
  "    this.h = h",
  "",
  "fn area(b: Box) -> float:",
  "  return b.w * b.h",
);

const KEEPS = src(
  "class Box:",
  "  public w: float",
  "  public h: float",
  "  public constructor(w: float, h: float):",
  "    this.w = w",
  "    this.h = h",
  "",
  "fn twice(b: Box, k: float) -> float:",
  "  x: float = b.h",
  "  b.w = k",
  "  return k * x",
);

function countOf(body: readonly string[], mnemonic: string): number {
  return body.filter((line) => line.startsWith(`${mnemonic} `)).length;
}

describe("x64 operand folding", () => {
  it("masks with the constant as an immediate rather than loading it", () => {
    const body = bodyOf(MASKS, "mask");

    expect(body.some((line) => /^andl \$7, /.test(line))).toBe(true);
    expect(body.some((line) => /^movl \$7, /.test(line))).toBe(false);
  });

  it("uses the wide immediate form when the constant does not fit a byte", () => {
    const body = bodyOf(WIDENS, "widen");

    expect(body.some((line) => /^orl \$70000, /.test(line))).toBe(true);
  });

  it("accumulates straight out of the array element", () => {
    const body = bodyOf(SUMS, "sum");
    const accumulate = body.find((line) => line.startsWith("addsd "))!;

    expect(accumulate).toMatch(/^addsd\s+-?\d*\(%\w+,%\w+,8\), %xmm/);
  });

  it("multiplies one field by the other without loading both", () => {
    const body = bodyOf(AREAS, "area");

    expect(body.some((line) => /^mulsd\s+\d+\(%\w+\), %xmm/.test(line))).toBe(true);
    expect(countOf(body, "movsd")).toBe(1);
  });

  it("refuses to fold a load that a store stands between", () => {
    const body = bodyOf(KEEPS, "twice");

    expect(body.some((line) => /^mulsd\s+\d+\(%\w+\), %xmm/.test(line))).toBe(false);
  });
});
