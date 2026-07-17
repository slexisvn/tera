import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const run = (source: string) => new Engine().runValue(source).value;

describe("Tera control flow", () => {
  it("runs Python-style if, while, for-of, and for-in blocks", () => {
    const source = [
      "sum = 0",
      "for x of [1, 2, 3, 4]:",
      "  if x % 2 == 0:",
      "    sum = sum + x",
      "obj = { a: 1, b: 2 }",
      "keys = \"\"",
      "for k in obj:",
      "  keys = keys + k",
      "n = 0",
      "while n < 3:",
      "  sum = sum + n",
      "  n = n + 1",
      "sum * 10 + keys.length",
    ].join("\n");
    expect(run(source)).toBe(92);
  });

  it("runs destructuring assignment in blocks", () => {
    const source = [
      "[a, [b, c]] = [1, [2, 3]]",
      "{x, y} = { x: 4, y: 5 }",
      "a + b + c + x + y",
    ].join("\n");
    expect(run(source)).toBe(15);
  });

  it("catches thrown values and always runs finally", () => {
    const source = [
      "out = 0",
      "try:",
      "  throw \"x\"",
      "catch e:",
      "  out = 3",
      "finally:",
      "  out = out + 1",
      "out",
    ].join("\n");
    expect(run(source)).toBe(4);
  });

  it("runs labeled indentation blocks with labeled break", () => {
    const source = [
      "total = 0",
      "outer:",
      "  for x of [1, 2, 3, 4, 5]:",
      "    if x == 4:",
      "      break outer",
      "    if x == 2:",
      "      continue",
      "    total = total + x",
      "total",
    ].join("\n");
    expect(run(source)).toBe(4);
  });
});
