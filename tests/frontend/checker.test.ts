import { describe, expect, it } from "vitest";
import { checkSource } from "../../src/index.js";

const messages = (source: string) => checkSource(source, "strict").map((d) => d.message);

describe("checker pipeline", () => {
  it("reports assignment type errors with strict severity", () => {
    const diagnostics = checkSource("count: number = \"nope\"", "strict");

    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 1,
        column: 1,
        severity: "error",
        message: "Type 'string' is not assignable to 'number'",
      }),
    ]);
  });

  it("binds aliases and validates object interface shapes", () => {
    const source = [
      "type UserId = number | string",
      "interface User:",
      "  id: UserId",
      "  name: string",
      "  active?: bool",
      "ok: User = { id: 1, name: \"Ada\" }",
      "bad_name: User = { id: 2, name: 99 }",
      "missing_name: User = { id: \"u-1\" }",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'int' is not assignable to field 'name: string'",
      "Missing required field 'name' for 'User'",
    ]);
  });

  it("instantiates generic interfaces through inherited parents", () => {
    const source = [
      "interface Box<T>:",
      "  value: T",
      "interface NamedNumberBox extends Box<number>:",
      "  label: string",
      "valid: NamedNumberBox = { value: 1, label: \"score\" }",
      "invalid: NamedNumberBox = { value: \"wrong\", label: \"score\" }",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'string' is not assignable to field 'value: number'",
    ]);
  });

  it("checks generic function calls and return statements from bound signatures", () => {
    const source = [
      "fn id<T>(value: T) -> T:",
      "  return value",
      "fn bad_return(x: number) -> string:",
      "  return x",
      "ok: number = id<number>(1)",
      "bad: number = id<string>(\"x\")",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'number' is not assignable to return type 'string'",
      "Type 'string' is not assignable to 'number'",
    ]);
  });

  it("checks named arguments for unknown, duplicate, missing, and mismatched values", () => {
    const source = [
      "fn mix(a: number, b: string, flag: bool) -> string:",
      "  return b",
      "mix(a=1, b=\"x\", flag=true)",
      "mix(a=\"bad\", b=\"x\", flag=true)",
      "mix(a=1, b=\"x\", extra=2, flag=true)",
      "mix(a=1, a=2, b=\"x\", flag=true)",
      "mix(a=1, b=\"x\")",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'string' is not assignable to parameter 'a: number'",
      "Unknown named argument 'extra' for mix()",
      "Argument 'a' was passed more than once",
      "Missing required argument 'flag' for mix()",
    ]);
  });

  it("narrows nullish unions inside block scopes without leaking the narrowed type", () => {
    const source = [
      "fn length_or_zero(value: string | null) -> number:",
      "  if value != null:",
      "    ok: string = value",
      "    return value.length",
      "  still_nullable: string = value",
      "  return 0",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'string | null' is not assignable to 'string'",
    ]);
  });

  it("keeps checker tolerant of runtime-only statements while still checking typed surface", () => {
    const source = [
      "var legacy = 1",
      "[a, b] = [1, 2]",
      "try:",
      "  throw \"boom\"",
      "catch e:",
      "  recovered: number = \"bad\"",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'string' is not assignable to 'number'",
    ]);
  });
});
