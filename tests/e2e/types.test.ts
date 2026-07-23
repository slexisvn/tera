import { describe, expect, it } from "vitest";
import { Engine, TypecheckError, checkSource } from "../../src/index.js";

describe("Tera type checker", () => {
  it("supports off, warn, and strict modes", () => {
    const source = "x: string = 1\nx";
    const warnEngine = new Engine({ typecheck: "warn" });
    expect(warnEngine.runValue(source).value).toBe(1);
    expect(warnEngine.diagnostics[0]?.message).toContain("not assignable");
    expect(new Engine({ typecheck: "off" }).runValue(source).value).toBe(1);
    expect(() => new Engine({ typecheck: "strict" }).run(source)).toThrow(TypecheckError);
  });

  it("checks aliases, interfaces, unions, arrays, and object fields", () => {
    const source = [
      "type Id = float | string",
      "interface Named:",
      "  readonly name: string",
      "  age?: float",
      "good: Named = { name: \"tera\" }",
      "bad: Named = { name: 3 }",
      "missing: Named = { age: 1 }",
      "ids: Id[] = [1, \"two\"]",
      "wrong: float = good.name",
    ].join("\n");
    const messages = checkSource(source, "strict").map((d) => d.message).join("\n");
    expect(messages).toContain("field 'name: string'");
    expect(messages).toContain("Missing required field 'name'");
    expect(messages).toContain("Type 'string' is not assignable to 'float'");
  });

  it("checks generic functions, tuples, function types, and generic parents", () => {
    const source = [
      "fn id<T>(value: T) -> T:",
      "  return value",
      "ok: float = id<float>(1)",
      "bad: float = id<string>(\"x\")",
      "pair: [float, string] = [1, \"ok\"]",
      "bad_pair: [float, string] = [\"x\", 1]",
      "fn apply(value: float, f: (float) -> float) -> float:",
      "  return f(value)",
      "bad_fn: (float) -> string = x => x + 1",
      "interface Box<T>:",
      "  value: T",
      "interface NamedBox extends Box<float>:",
      "  label: string",
      "bad_box: NamedBox = { value: \"x\", label: \"tera\" }",
    ].join("\n");
    const messages = checkSource(source, "strict").map((d) => d.message).join("\n");
    expect(messages).toContain("Type 'string' is not assignable to 'float'");
    expect(messages).toContain("Type '[string, int]' is not assignable to '[float, string]'");
    expect(messages).toContain("Type '(float) -> float' is not assignable to '(float) -> string'");
    expect(messages).toContain("field 'value: float'");
  });

  it("narrows union types inside control flow and erases types at runtime", () => {
    const source = [
      "fn safe_len(x: string | null) -> float:",
      "  if x != null:",
      "    y: string = x",
      "    return x.length",
      "  return 0",
      "safe_len(\"tera\")",
    ].join("\n");
    expect(checkSource(source, "strict")).toEqual([]);
    expect(new Engine({ typecheck: "strict" }).runNative(source)).toBe(4);
  });

  it("erases type aliases and interfaces without swallowing following declarations", () => {
    const source = [
      "type Id = float | string",
      "interface User:",
      "  id: Id",
      "  name: string",
      "fn safe_len(x: string | null) -> float:",
      "  if x != null:",
      "    y: string = x",
      "    return y.length",
      "  return 0",
      "user: User = { id: 1, name: \"Ada\" }",
      "safe_len(user.name)",
    ].join("\n");
    expect(checkSource(source, "strict")).toEqual([]);
    expect(new Engine({ typecheck: "strict" }).runNative(source)).toBe(3);
  });

  it("erases function type annotations on variable assignments", () => {
    const source = [
      "fn apply(x: float, f: (float) -> float) -> float:",
      "  return f(x)",
      "double: (float) -> float = x => x * 2",
      "apply(21, double)",
    ].join("\n");
    expect(checkSource(source, "strict")).toEqual([]);
    expect(new Engine({ typecheck: "strict" }).runNative(source)).toBe(42);
  });
});
