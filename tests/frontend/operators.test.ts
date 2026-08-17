import { describe, it, expect } from "vitest";
import {
  BINARY_OPERATORS,
  COMPOUND_ASSIGN_OPERATORS,
  MULTI_CHAR_PUNCTUATORS,
  SINGLE_CHAR_PUNCTUATORS,
} from "../../src/frontend/operators.js";
import { Lexer, TokenType } from "../../src/frontend/lexer/index.js";

function punctuators(source: string): string[] {
  return new Lexer(source)
    .tokenize()
    .filter((token) => token.type === TokenType.Punctuator)
    .map((token) => String(token.value));
}

describe("operator table", () => {
  it("orders multi-character punctuators longest first so maximal munch holds", () => {
    for (let i = 1; i < MULTI_CHAR_PUNCTUATORS.length; i++) {
      expect(MULTI_CHAR_PUNCTUATORS[i]!.length).toBeLessThanOrEqual(
        MULTI_CHAR_PUNCTUATORS[i - 1]!.length,
      );
    }
  });

  it("never lists a punctuator after one it is a prefix of", () => {
    MULTI_CHAR_PUNCTUATORS.forEach((spelling, at) => {
      const earlier = MULTI_CHAR_PUNCTUATORS.slice(0, at);
      for (const before of earlier) {
        expect(spelling.startsWith(before)).toBe(false);
      }
    });
  });

  it("carries every compound assignment operator through to the lexer", () => {
    for (const operator of COMPOUND_ASSIGN_OPERATORS) {
      expect(MULTI_CHAR_PUNCTUATORS).toContain(operator);
      expect(punctuators(`a ${operator} b`)).toEqual([operator]);
    }
  });

  it("carries every symbolic binary operator through to the lexer", () => {
    for (const operator of BINARY_OPERATORS) {
      if (/^\w/.test(operator)) continue;
      const scanned = punctuators(`a ${operator} b`);
      expect(scanned).toEqual([operator]);
    }
  });

  it("keeps word-shaped binary operators out of the punctuator table", () => {
    expect(MULTI_CHAR_PUNCTUATORS).not.toContain("instanceof");
    expect(MULTI_CHAR_PUNCTUATORS).not.toContain("in");
  });

  it("lists no duplicate spellings", () => {
    expect(new Set(MULTI_CHAR_PUNCTUATORS).size).toBe(MULTI_CHAR_PUNCTUATORS.length);
  });

  it("scans the longest operator when a shorter one is a prefix", () => {
    expect(punctuators("a >>>= b")).toEqual([">>>="]);
    expect(punctuators("a >>> b")).toEqual([">>>"]);
    expect(punctuators("a >> b")).toEqual([">>"]);
    expect(punctuators("a > b")).toEqual([">"]);
    expect(punctuators("a === b")).toEqual(["==="]);
    expect(punctuators("a == b")).toEqual(["=="]);
    expect(punctuators("a **= b")).toEqual(["**="]);
    expect(punctuators("a ** b")).toEqual(["**"]);
  });

  it("keeps single-character punctuators reachable when no longer match applies", () => {
    for (const spelling of SINGLE_CHAR_PUNCTUATORS) {
      if (spelling === "@") continue;
      expect(punctuators(`a ${spelling} b`)[0]).toBe(spelling);
    }
  });
});
