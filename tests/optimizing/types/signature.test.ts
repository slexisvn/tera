import { describe, expect, it } from "vitest";
import {
  functionSignatureOf,
  functionTypeTextOf,
} from "../../../src/optimizing/types/signature.js";

describe("reading a function type out of the text it was declared with", () => {
  it("reads the parameters and the answer of a bare arrow type", () => {
    expect(functionSignatureOf("(int, string) -> bool")).toEqual({
      params: ["int", "string"],
      returns: "bool",
    });
  });

  it("reads the same type when the language spelled the fn keyword in front", () => {
    expect(functionSignatureOf("fn(int) -> int")).toEqual({ params: ["int"], returns: "int" });
  });

  it("reads it with room between the keyword and the parameters", () => {
    expect(functionSignatureOf("fn (int, int) -> float")).toEqual({
      params: ["int", "int"],
      returns: "float",
    });
  });

  it("reads a keyword-spelled type and a bare one as the same signature", () => {
    expect(functionSignatureOf("fn(int) -> int")).toEqual(functionSignatureOf("(int) -> int"));
  });

  it("reads a type that takes nothing", () => {
    expect(functionSignatureOf("fn() -> void")).toEqual({ params: [], returns: "void" });
  });

  it("refuses a name that only starts the way the keyword does", () => {
    expect(functionSignatureOf("fnord")).toBeNull();
    expect(functionSignatureOf("fnord(int) -> int")).toBeNull();
  });

  it("refuses text that names no function at all", () => {
    expect(functionSignatureOf("int")).toBeNull();
    expect(functionSignatureOf("(int, int)")).toBeNull();
    expect(functionSignatureOf(null)).toBeNull();
  });

  it("reads back the text it writes for a signature", () => {
    const written = functionTypeTextOf({ params: ["int"], returns: "int" })!;

    expect(functionSignatureOf(written)).toEqual({ params: ["int"], returns: "int" });
  });

  it("reads a function-typed parameter as one parameter and the one beside it as another", () => {
    expect(functionSignatureOf("fn(fn(int) -> int, int) -> int")).toEqual({
      params: ["fn(int) -> int", "int"],
      returns: "int",
    });
  });

  it("reads the bare spelling of a function-typed parameter the same way", () => {
    expect(functionSignatureOf("((int) -> int, int) -> int")).toEqual({
      params: ["(int) -> int", "int"],
      returns: "int",
    });
  });

  it("keeps a comma inside a generic parameter out of the parameter split", () => {
    expect(functionSignatureOf("(Map<string, int>, int) -> bool")).toEqual({
      params: ["Map<string, int>", "int"],
      returns: "bool",
    });
  });

  it("reads an arrow nested inside a generic parameter", () => {
    expect(functionSignatureOf("(Array<(int) -> int>, int) -> void")).toEqual({
      params: ["Array<(int) -> int>", "int"],
      returns: "void",
    });
  });

  it("reads a function type as the answer", () => {
    expect(functionSignatureOf("(int) -> (int) -> int")).toEqual({
      params: ["int"],
      returns: "(int) -> int",
    });
  });

  it("reads back the text it writes for a signature that takes a function", () => {
    const signature = { params: ["(int) -> int", "int"], returns: "int" };
    const written = functionTypeTextOf(signature)!;

    expect(written).toBe("((int) -> int, int) -> int");
    expect(functionSignatureOf(written)).toEqual(signature);
  });

  it("reads back the text it writes for a signature that answers a function", () => {
    const signature = { params: ["int"], returns: "(int) -> int" };
    const written = functionTypeTextOf(signature)!;

    expect(functionSignatureOf(written)).toEqual(signature);
  });
});
