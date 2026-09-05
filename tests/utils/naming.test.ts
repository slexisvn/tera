import { describe, expect, it } from "vitest";
import { camelToSnake, snakeToCamel, spellings } from "../../src/utils/naming.js";

describe("the spellings a member name answers to", () => {
  it("answers a camel-spelled name under both spellings", () => {
    expect(spellings("fromCharCode")).toEqual(["fromCharCode", "from_char_code"]);
  });

  it("answers a name already written in the language's spelling only once", () => {
    expect(spellings("char_code_at")).toEqual(["char_code_at"]);
  });

  it("answers a one-word name only once", () => {
    expect(spellings("keys")).toEqual(["keys"]);
  });

  it("leaves a constant written in capitals alone rather than lowering it", () => {
    expect(spellings("MAX_SAFE_INTEGER")).toEqual(["MAX_SAFE_INTEGER"]);
    expect(spellings("NaN")).toEqual(["NaN"]);
  });

  it("counts a digit before a capital as a word boundary", () => {
    expect(spellings("utf8Decode")).toEqual(["utf8Decode", "utf8_decode"]);
  });

  it("answers spellings that read back to the name they came from", () => {
    for (const name of ["fromCharCode", "getOwnPropertyDescriptor"]) {
      expect(snakeToCamel(camelToSnake(name))).toBe(name);
    }
  });
});
