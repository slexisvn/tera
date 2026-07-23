import { describe, expect, it } from "vitest";
import { Engine, TypecheckError, checkSource } from "../../src/index.js";

const run = (source: string) => new Engine().runValue(source).value;
const native = (source: string, typecheck: "off" | "warn" | "strict" = "off") =>
  new Engine({ typecheck }).runNative(source);

describe("Tera functions and calls", () => {
  it("runs indentation functions with erased parameter and return types", () => {
    expect(run("fn add(a: float, b: float = 2) -> float:\n  return a + b\nadd(a=3)")).toBe(5);
  });

  it("binds named arguments with Python-style rules", () => {
    expect(run("fn join(a, b, c = \"!\"):\n  return a + b + c\njoin(\"A\", c=\"?\", b=\"B\")")).toBe("AB?");
    expect(() => run("fn f(a):\n  return a\nf(1, a=2)")).toThrow(/passed more than once/);
  });

  it("mixes spread positional arguments with named arguments", () => {
    expect(run("fn f(a, b, c=0):\n  return a + b + c\nxs = [1, 2]\nf(...xs, c=3)")).toBe(6);
  });

  it("runs recursion, closures, and arrow functions", () => {
    const source = [
      "fn fact(n):",
      "  if n <= 1:",
      "    return 1",
      "  return n * fact(n - 1)",
      "fn adder(a):",
      "  return b => a + b",
      "square = x => x * x",
      "fact(6) + adder(10)(5) + square(3)",
    ].join("\n");
    expect(run(source)).toBe(744);
  });

  it("checks typed returns and named argument types", () => {
    const diagnostics = checkSource(
      "fn add(a: float, b: float) -> string:\n  return a + b\nadd(a=\"x\", b=2)",
      "strict",
    );
    const messages = diagnostics.map((d) => d.message).join("\n");
    expect(messages).toContain("return type 'string'");
    expect(messages).toContain("parameter 'a: float'");
    expect(() => native("x: string = 1\nx", "strict")).toThrow(TypecheckError);
  });
});
