import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/index.js";

const src = (...lines: string[]) => lines.join("\n");

const engine = new Engine({ typecheck: "off" });

function reasons(source: string): { x64: string; c: string } {
  const x64 = engine.compileAot(source, { backend: "x64" });
  const c = engine.compileAot(source);
  return {
    x64: x64.skipped.map((fn) => fn.reason).join("; "),
    c: c.skipped.map((fn) => fn.reason).join("; "),
  };
}

function bothDecline(source: string, expected: string): void {
  const { x64, c } = reasons(source);
  expect(x64).toContain(expected);
  expect(c).toContain(expected);
}

function bothAdmit(source: string): void {
  const { x64, c } = reasons(source);
  expect(x64).toBe("");
  expect(c).toBe("");
}

describe("the AOT string ceiling", () => {
  it("admits concatenation, rendering and indexing of strings", () => {
    bothAdmit(
      src(
        "fn render(n: int, s: string) -> string:",
        '  return n.to_string() + s.char_at(0) + "!"',
      ),
    );
  });

  it("declines adding a number to a string because coercion is not modelled", () => {
    bothDecline(
      src("fn f(s: string, n: int) -> string:", "  return s + n"),
      "unsupported opcode GenericAdd",
    );
    bothDecline(
      src("fn f(s: string, n: int) -> string:", "  return n + s"),
      "unsupported opcode GenericAdd",
    );
  });

  it("declines rendering a float because only int32 decimals are supported", () => {
    bothDecline(
      src("fn f(x: float) -> string:", "  return x.to_string()"),
      "unsupported builtin float.to_string",
    );
  });

  it("declines to_string with an explicit radix", () => {
    bothDecline(
      src("fn f(n: int) -> string:", "  return n.to_string(16)"),
      "int.to_string has an unsupported argument count",
    );
  });

  it("declines an array of strings because buffers hold one string each", () => {
    bothDecline(
      src("fn f(i: int) -> string:", '  names = ["H", "O"]', "  return names[i]"),
      "array has an unsupported element type",
    );
  });

  it("declines storing a string into a numeric array", () => {
    bothDecline(
      src("fn f(i: int) -> string:", "  cells = [0, 0]", '  cells[i] = "H"', "  return cells[i]"),
      "array has an unsupported element type",
    );
  });

  it("declines prepending an accumulator to itself", () => {
    bothDecline(
      src(
        "fn f(n: int) -> string:",
        '  out = ""',
        "  i = 0",
        "  while i < n:",
        '    out = "ab" + out',
        "    i = i + 1",
        "  return out",
      ),
      "string buffer is used as a trailing operand of its own producer",
    );
  });

  it("declines building a string in a function that calls another function", () => {
    bothDecline(
      src(
        "fn tag(n: int) -> int:",
        "  return n + 1",
        "fn f(n: int, s: string) -> string:",
        "  if tag(n) > 2:",
        '    return s + "!"',
        "  return s",
      ),
      "string building cannot cross a call to tag",
    );
  });

  it("keeps admitting a numeric function that calls another function", () => {
    bothAdmit(
      src("fn tag(n: int) -> int:", "  return n + 1", "fn f(n: int) -> int:", "  return tag(n) * 2"),
    );
  });

  it("declines returning a string without declaring a string return type", () => {
    bothDecline(
      src("fn f(a: string, b: string):", "  return a + b"),
      "function returns a string but its return type is not a string",
    );
  });

  it("declines returning a string constant without declaring a string return type", () => {
    bothDecline(
      src("fn f():", '  return "hi"'),
      "function returns a string but its return type is not a string",
    );
  });
});
