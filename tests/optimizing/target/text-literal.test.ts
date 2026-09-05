import { describe, expect, it } from "vitest";
import {
  byteEscapedLiteral,
  characterCapacity,
  codeUnitByteLength,
  codeUnitCapacity,
} from "../../../src/optimizing/target/text-literal.js";

const encoder = new TextEncoder();
const spelled = (value: string) => byteEscapedLiteral(value);

describe("byteEscapedLiteral", () => {
  it("leaves printable ASCII as it was spelled", () => {
    expect(spelled("hello world")).toBe('"hello world"');
  });

  it("escapes the two characters that would end or continue the literal", () => {
    expect(spelled('a"b')).toBe('"a\\"b"');
    expect(spelled("a\\b")).toBe('"a\\\\b"');
  });

  it("names a newline and a tab rather than breaking the line", () => {
    expect(spelled("a\nb\tc")).toBe('"a\\nb\\tc"');
  });

  it("writes text outside ASCII as the UTF-8 bytes it takes", () => {
    expect(spelled("é")).toBe('"\\303\\251"');
    expect(encoder.encode("é")).toEqual(new Uint8Array([0o303, 0o251]));
  });

  it("writes a character above the basic plane as all four of its bytes", () => {
    expect(spelled("😀")).toBe('"\\360\\237\\230\\200"');
  });

  it("escapes the delete byte, which prints as nothing at all", () => {
    expect(spelled(String.fromCharCode(0x7f))).toBe('"\\177"');
  });

  it("escapes a control byte the toolchain would otherwise swallow", () => {
    expect(spelled(String.fromCharCode(1))).toBe('"\\001"');
  });

  it("pads every escape to three digits so a following digit is not absorbed", () => {
    expect(spelled(String.fromCharCode(1) + "7")).toBe('"\\0017"');
  });

  it("never reaches for a hex escape, which an assembler reads as variable length", () => {
    const risky = spelled("é" + String.fromCharCode(1) + "f");

    expect(risky).not.toContain("\\x");
    expect(risky).toBe('"\\303\\251\\001f"');
  });

  it("keeps a bare empty string a bare empty literal", () => {
    expect(spelled("")).toBe('""');
  });
});

describe("characterCapacity", () => {
  it("fits one fewer character than the code units the bytes hold", () => {
    expect(codeUnitCapacity(1024)).toBe(512);
    expect(characterCapacity(1024)).toBe(511);
  });

  it("answers exactly the text that spells back into those bytes", () => {
    const bytes = 1024;

    expect(codeUnitByteLength("x".repeat(characterCapacity(bytes)))).toBe(bytes);
    expect(codeUnitByteLength("x".repeat(characterCapacity(bytes) + 1))).toBeGreaterThan(bytes);
  });

  it("holds nothing at all when the bytes cannot carry a terminator", () => {
    expect(characterCapacity(0)).toBe(-1);
    expect(characterCapacity(2)).toBe(0);
  });
});
