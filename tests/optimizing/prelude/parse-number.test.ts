import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import {
  parseNumberPrelude,
  readsNumbers,
  NUMBER_OF_FUNCTION,
  NUMBER_TEXT_READERS,
  PARSE_FLOAT_FUNCTION,
  PARSE_INT_FUNCTION,
  PARSE_NUMBER_FUNCTIONS,
} from "../../../src/optimizing/prelude/parse-number.js";
import type { ASTNode } from "../../../src/frontend/ast/index.js";

const src = (...lines: string[]) => lines.join("\n");

const roots = (source: string): readonly ASTNode[] => [parse(`${source}\n`)];

const preludeFor = (source: string): string => parseNumberPrelude(roots(source), false);

describe("the prelude that reads a number out of text", () => {
  it("stays empty for a program that reads no numbers", () => {
    expect(preludeFor('print("hello")')).toBe("");
    expect(readsNumbers(roots("print(1.5)"))).toBe(false);
  });

  for (const spelling of [
    'print(parse_float("1.5"))',
    'print(parse_int("15"))',
    'print(Number("1.5"))',
    'print(Number.parse_float("1.5"))',
    'print(Number.parse_int("15"))',
  ]) {
    it(`carries the readers for ${spelling}`, () => {
      const prelude = preludeFor(spelling);

      expect(readsNumbers(roots(spelling))).toBe(true);
      expect(prelude).toContain(`fn ${PARSE_FLOAT_FUNCTION}(text: string) -> float:`);
      expect(prelude).toContain(`fn ${PARSE_INT_FUNCTION}(text: string) -> float:`);
    });
  }

  it("carries the readers for something else that needs them", () => {
    const prelude = parseNumberPrelude(roots('print("hello")'), true);

    expect(prelude).toContain(`fn ${PARSE_FLOAT_FUNCTION}(text: string) -> float:`);
  });

  it("names every reader it declares", () => {
    const prelude = preludeFor('print(parse_float("1.5"))');

    for (const reader of NUMBER_TEXT_READERS) {
      expect(prelude).toContain(`fn ${reader}(text: string`);
    }
    for (const name of PARSE_NUMBER_FUNCTIONS.values()) {
      expect(prelude).toContain(`fn ${name}(text: string) -> float:`);
    }
  });

  it("declares each function once when a program reads two numbers", () => {
    const prelude = preludeFor(src('print(parse_float("1.5"))', 'print(parse_int("15"))'));

    expect(prelude.split(`fn ${PARSE_FLOAT_FUNCTION}(`).length - 1).toBe(1);
    expect(prelude.split("fn _pn_read(").length - 1).toBe(1);
  });

  it("scales a mantissa by exact powers of two only", () => {
    const prelude = preludeFor('print(parse_float("1.5"))');
    const body = prelude.slice(prelude.indexOf("fn _pn_scale("));
    const scales = body
      .slice(0, body.indexOf("\n\nfn "))
      .split("\n")
      .filter((line) => line.includes("v = v * ") || line.includes("v = v / "))
      .map((line) => Number(line.slice(line.lastIndexOf(" ") + 1)));

    expect(scales.length).toBeGreaterThan(0);
    for (const scale of scales) {
      expect(Number.isFinite(scale)).toBe(true);
      expect(Math.log2(scale) % 1).toBe(0);
    }
  });

  it("builds a power of ten by exact single steps", () => {
    const prelude = preludeFor('print(parse_float("1.5"))');
    const body = prelude.slice(prelude.indexOf("fn _pn_exact_ten("));

    expect(body.slice(0, body.indexOf("\n\nfn "))).toContain("v = v * 10.0");
  });

  it("keeps every limb product inside a signed 32-bit word", () => {
    const prelude = preludeFor('print(parse_float("1.5"))');
    const mask = Number(/product & (\d+)/.exec(prelude)![1]);
    const factor = Number(/\(a, (\d+)\)/.exec(prelude)![1]);

    expect(mask * factor + factor).toBeLessThan(2 ** 31);
  });

  it("reads a whole text the way Number does, prefixes and all", () => {
    const prelude = preludeFor('print(Number("1.5"))');
    const body = prelude.slice(prelude.indexOf("fn _pn_read("));

    expect(prelude).toContain(`fn ${NUMBER_OF_FUNCTION}(text: string) -> float:`);
    expect(body).toContain("  if whole == 1:");
    expect(body).toContain("      return 0.0");
    for (const [marker, base] of [
      ["x", 16],
      ["X", 16],
      ["o", 8],
      ["O", 8],
      ["b", 2],
      ["B", 2],
    ] as const) {
      expect(body).toContain(`marker == ${marker.codePointAt(0)!}`);
      expect(body).toContain(`base = ${base}`);
    }
    expect(prelude).toContain("  if whole == 1 and at != stop:");
  });

  it("leaves a program that spells the readers itself alone", () => {
    const source = src(
      "fn read(t: string) -> float:",
      "  return 0.0",
      'print(read("1.5"))',
    );

    expect(readsNumbers(roots(source))).toBe(false);
    expect(preludeFor(source)).toBe("");
  });

  it("leaves a member of the same name on something that is not Number alone", () => {
    const source = src(
      "class Reader:",
      "  public parse_float(t: string) -> float:",
      "    return 0.0",
      'print(Reader().parse_float("1.5"))',
    );

    expect(readsNumbers(roots(source))).toBe(false);
  });
});
