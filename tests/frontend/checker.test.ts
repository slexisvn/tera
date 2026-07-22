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

  describe("numeric types", () => {
    it("accepts number where int or float is declared", () => {
      expect(messages("fn square(n: int) -> int:\n  return n * n")).toEqual([]);
      expect(messages("fn half(n: float) -> float:\n  return n / 2")).toEqual([]);
    });

    it("accepts int and float interchangeably", () => {
      expect(messages("fn widen(n: int) -> float:\n  return n")).toEqual([]);
      expect(messages("fn narrow(n: float) -> int:\n  return n")).toEqual([]);
    });

    it("accepts a numeric accumulator declared as int", () => {
      const source = [
        "fn factorial(n: int) -> int:",
        "  acc = 1",
        "  for i of range(1, n + 1):",
        "    acc *= i",
        "  return acc",
      ].join("\n");
      expect(messages(source)).toEqual([]);
    });

    it("still rejects a non-numeric value for a numeric type", () => {
      expect(messages('fn f() -> int:\n  return "hi"')).toEqual([
        "Type 'string' is not assignable to return type 'int'",
      ]);
      expect(messages("fn f() -> float:\n  return true")).toEqual([
        "Type 'bool' is not assignable to return type 'float'",
      ]);
      expect(messages("fn f() -> int:\n  return [1, 2]")).toEqual([
        "Type '[int, int]' is not assignable to return type 'int'",
      ]);
    });
  });

  describe("model declarations", () => {
    const model = [
      "model Net(n: int):",
      "  layer = Linear(4, n)",
      "",
      "  forward (x: Tensor) -> Tensor:",
      "    return layer(x)",
      "",
      "  optimizer:",
      "    return optim_config(Adam(Net.parameters(), lr=0.01))",
      "",
    ].join("\n");

    it("does not check an untyped section return against the constructor type", () => {
      expect(messages(model)).toEqual([]);
    });

    it("gives the constructor the model's own nominal type", () => {
      expect(messages(`${model}fn use(net: Net) -> Net:\n  return net\nn = use(Net(3))`)).toEqual([]);
    });

    it("still checks a section that declares its own return type", () => {
      const source = [
        "model Net(n: int):",
        "  layer = Linear(4, n)",
        "",
        "  forward (x: Tensor) -> Tensor:",
        '    return "not a tensor"',
        "",
      ].join("\n");
      expect(messages(source)).toEqual([
        "Type 'string' is not assignable to return type 'Tensor'",
      ]);
    });
  });

  describe("union types", () => {
    it("accepts each member of a declared union", () => {
      expect(messages('x: string | number = "a"')).toEqual([]);
      expect(messages("x: string | number = 1")).toEqual([]);
    });

    it("rejects a value outside the union", () => {
      expect(messages("x: string | number = true")).toEqual([
        "Type 'bool' is not assignable to 'string | number'",
      ]);
    });

    it("accepts an array member of a union whose last arm is an array", () => {
      expect(messages('x: string | string[] = ["a", "b"]')).toEqual([]);
      expect(messages('x: string | string[] = "a"')).toEqual([]);
    });

    it("binds a trailing [] to its own arm, not to the whole union", () => {
      expect(messages("x: string | number[] = [1, 2]")).toEqual([]);
      expect(messages('x: string | number[] = "a"')).toEqual([]);
      expect(messages("x: string | number[] = 1")).toEqual([
        "Type 'int' is not assignable to 'string | number[]'",
      ]);
      expect(messages('x: string | number[] = ["a", "b"]')).toEqual([
        "Type '[string, string]' is not assignable to 'string | number[]'",
      ]);
    });
  });

  describe("chart column selectors", () => {
    const frame = 'df = DataFrame(day=[1], value=[2.0])\n';

    it("accepts a column name for x and y", () => {
      expect(messages(`${frame}c = chart.line(df, x="day", y="value")`)).toEqual([]);
    });

    it("accepts a column index for x and y", () => {
      expect(messages(`${frame}c = chart.line(df, x=0, y=1)`)).toEqual([]);
    });

    it("accepts a list of column names for y", () => {
      expect(messages(`${frame}c = chart.line(df, x="day", y=["value", "day"])`)).toEqual([]);
    });

    it("accepts a list of column indexes for y", () => {
      expect(messages(`${frame}c = chart.bar(df, x=0, y=[0, 1])`)).toEqual([]);
    });

    it("still rejects a value that is not a column selector", () => {
      expect(messages(`${frame}c = chart.line(df, x=true)`)).toEqual([
        "Type 'bool' is not assignable to parameter 'x: string | number'",
      ]);
    });
  });

  describe("train_test_split", () => {
    it("accepts the shuffle option the runtime forwards", () => {
      expect(messages("parts = train_test_split(x, y, test_size=0.2, shuffle=false)")).toEqual([]);
    });

    it("still rejects an option the runtime does not take", () => {
      expect(messages("parts = train_test_split(x, y, stratified=true)")).toEqual([
        "Unknown named argument 'stratified' for train_test_split()",
      ]);
    });
  });

  describe("tokenizer nominal type", () => {
    it("types load_tokenizer as Tokenizer", () => {
      const source = [
        "fn reply(tok: Tokenizer) -> string:",
        '  return "ok"',
        'print(reply(load_tokenizer("model.tok")))',
      ].join("\n");
      expect(messages(source)).toEqual([]);
    });

    it("types the Tokenizer constructor as Tokenizer", () => {
      const source = [
        "fn reply(tok: Tokenizer) -> string:",
        '  return "ok"',
        'print(reply(Tokenizer(mode="word")))',
      ].join("\n");
      expect(messages(source)).toEqual([]);
    });

    it("still rejects an unrelated value for a Tokenizer parameter", () => {
      const source = [
        "fn reply(tok: Tokenizer) -> string:",
        '  return "ok"',
        'print(reply("not a tokenizer"))',
      ].join("\n");
      expect(messages(source)).toEqual([
        "Type 'string' is not assignable to parameter 'tok: Tokenizer'",
      ]);
    });
  });
});
