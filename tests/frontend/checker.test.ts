import { describe, expect, it } from "vitest";
import { checkSource, inferSymbolTypes } from "../../src/index.js";

const messages = (source: string) => checkSource(source, "strict").map((d) => d.message);

describe("checker pipeline", () => {
  it("reports assignment type errors with strict severity", () => {
    const diagnostics = checkSource("count: float = \"nope\"", "strict");

    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 1,
        column: 1,
        severity: "error",
        message: "Type 'string' is not assignable to 'float'",
      }),
    ]);
  });

  it("binds aliases and validates object interface shapes", () => {
    const source = [
      "type UserId = float | string",
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
      "interface NamedFloatBox extends Box<float>:",
      "  label: string",
      "valid: NamedFloatBox = { value: 1, label: \"score\" }",
      "invalid: NamedFloatBox = { value: \"wrong\", label: \"score\" }",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'string' is not assignable to field 'value: float'",
    ]);
  });

  it("checks generic function calls and return statements from bound signatures", () => {
    const source = [
      "fn id<T>(value: T) -> T:",
      "  return value",
      "fn bad_return(x: float) -> string:",
      "  return x",
      "ok: float = id<float>(1)",
      "bad: float = id<string>(\"x\")",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'float' is not assignable to return type 'string'",
      "Type 'string' is not assignable to 'float'",
    ]);
  });

  it("checks argument types for fn declarations", () => {
    const source = [
      "fn abc(a: string):",
      "  return a",
      "a = 1",
      "abc(a)",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'int' is not assignable to parameter 'a: string'",
    ]);
    expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "a", line: 3, column: 1, type: "int" }),
    ]));
  });

  it("places argument type diagnostics on the offending argument", () => {
    const diagnostics = checkSource([
      "fn abc(a: string, b: int):",
      "  return a",
      "value = 1",
      "abc(value, \"bad\")",
    ].join("\n"), "strict");

    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 4,
        column: 5,
        message: "Type 'int' is not assignable to parameter 'a: string'",
      }),
      expect.objectContaining({
        line: 4,
        column: 12,
        message: "Type 'string' is not assignable to parameter 'b: int'",
      }),
    ]);
  });

  it("checks argument types for builtin constructors", () => {
    expect(messages('net = Linear("bad", 8)')).toEqual([
      "Type 'string' is not assignable to parameter 'in: int'",
    ]);
    expect(messages('tok = Tokenizer(vocab_size="bad")')).toEqual([
      "Type 'string' is not assignable to parameter 'vocab_size: int'",
    ]);
  });

  it("checks named arguments for unknown, duplicate, missing, and mismatched values", () => {
    const source = [
      "fn mix(a: float, b: string, flag: bool) -> string:",
      "  return b",
      "mix(a=1, b=\"x\", flag=true)",
      "mix(a=\"bad\", b=\"x\", flag=true)",
      "mix(a=1, b=\"x\", extra=2, flag=true)",
      "mix(a=1, a=2, b=\"x\", flag=true)",
      "mix(a=1, b=\"x\")",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'string' is not assignable to parameter 'a: float'",
      "Unknown named argument 'extra' for mix()",
      "Argument 'a' was passed more than once",
      "Missing required argument 'flag' for mix()",
    ]);
  });

  it("places named argument type diagnostics on the offending value", () => {
    const diagnostics = checkSource([
      "fn configure(width: int, title: string):",
      "  return title",
      "configure(width=\"wide\", title=42)",
    ].join("\n"), "strict");

    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 3,
        column: 17,
        message: "Type 'string' is not assignable to parameter 'width: int'",
      }),
      expect.objectContaining({
        line: 3,
        column: 31,
        message: "Type 'int' is not assignable to parameter 'title: string'",
      }),
    ]);
  });

  it("narrows nullish unions inside block scopes without leaking the narrowed type", () => {
    const source = [
      "fn length_or_zero(value: string | null) -> float:",
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
      "  recovered: float = \"bad\"",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'string' is not assignable to 'float'",
    ]);
  });

  describe("numeric types", () => {
    it("accepts int and float numeric compatibility", () => {
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

  describe("loop binding inference", () => {
    it("infers for-of variables from iterable element types", () => {
      const symbols = inferSymbolTypes([
        "for step of range(200):",
        "  pred = step",
        "for item of [1.5, 2.5]:",
        "  value = item",
        "for char of \"abc\":",
        "  text = char",
      ].join("\n"));

      expect(symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "step", line: 1, column: 5, type: "int" }),
        expect.objectContaining({ name: "item", line: 3, column: 5, type: "float" }),
        expect.objectContaining({ name: "char", line: 5, column: 5, type: "string" }),
      ]));
    });

    it("infers for-in variables from indexable containers", () => {
      const symbols = inferSymbolTypes([
        "for index in [1, 2]:",
        "  value = index",
        "for key in { a: 1 }:",
        "  name = key",
      ].join("\n"));

      expect(symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "index", line: 1, column: 5, type: "int" }),
        expect.objectContaining({ name: "key", line: 3, column: 5, type: "string" }),
      ]));
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

    it("reports model body and constructor call failures at the offending arguments", () => {
      const source = [
        "model ChatBotLarge(vocab_size: string, embed_size: int, hidden_size: int):",
        "  embed = Embedding(vocab_size, embed_size)",
        "  head = Linear(2 * hidden_size, vocab_size)",
        "  forward (q: Tensor) -> Tensor:",
        "    return q",
        "tok = Tokenizer()",
        "net = ChatBotLarge(tok.vocab_size, 8, 16)",
      ].join("\n");

      expect(checkSource(source, "strict")).toEqual([
        expect.objectContaining({
          line: 2,
          column: 21,
          message: "Type 'string' is not assignable to parameter 'num: int'",
        }),
        expect.objectContaining({
          line: 3,
          column: 34,
          message: "Type 'string' is not assignable to parameter 'out: int'",
        }),
        expect.objectContaining({
          line: 7,
          column: 20,
          message: "Type 'int' is not assignable to parameter 'vocab_size: string'",
        }),
      ]);
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
      expect(messages('x: string | float = "a"')).toEqual([]);
      expect(messages("x: string | float = 1")).toEqual([]);
    });

    it("rejects a value outside the union", () => {
      expect(messages("x: string | float = true")).toEqual([
        "Type 'bool' is not assignable to 'string | float'",
      ]);
    });

    it("accepts an array member of a union whose last arm is an array", () => {
      expect(messages('x: string | string[] = ["a", "b"]')).toEqual([]);
      expect(messages('x: string | string[] = "a"')).toEqual([]);
    });

    it("binds a trailing [] to its own arm, not to the whole union", () => {
      expect(messages("x: string | float[] = [1, 2]")).toEqual([]);
      expect(messages('x: string | float[] = "a"')).toEqual([]);
      expect(messages("x: string | float[] = 1")).toEqual([
        "Type 'int' is not assignable to 'string | float[]'",
      ]);
      expect(messages('x: string | float[] = ["a", "b"]')).toEqual([
        "Type '[string, string]' is not assignable to 'string | float[]'",
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

    it("accepts an array of column names for y", () => {
      expect(messages(`${frame}c = chart.line(df, x="day", y=["value", "day"])`)).toEqual([]);
    });

    it("accepts an array of column indexes for y", () => {
      expect(messages(`${frame}c = chart.bar(df, x=0, y=[0, 1])`)).toEqual([]);
    });

    it("still rejects a value that is not a column selector", () => {
      expect(messages(`${frame}c = chart.line(df, x=true)`)).toEqual([
        "Type 'bool' is not assignable to parameter 'x: string | int | float'",
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
