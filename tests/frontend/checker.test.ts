import { describe, expect, it } from "vitest";
import { checkSource, inferSymbolTypes } from "../../src/index.js";

const messages = (source: string) => checkSource(source, "strict").map((d) => d.message);

describe("checker pipeline", () => {
  it("reports assignment type errors with strict severity", () => {
    const diagnostics = checkSource("count: float = \"nope\"", "strict");

    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 1,
        column: 16,
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

  it("checks structural interface assignability by required fields", () => {
    const source = [
      "interface Named:",
      "  name: string",
      "interface Person:",
      "  name: string",
      "  age: int",
      "interface Point:",
      "  x: int",
      "person: Person = { name: \"Ada\", age: 36 }",
      "ok: Named = person",
      "point: Point = { x: 1 }",
      "bad: Named = point",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'Point' is not assignable to 'Named'",
    ]);
  });

  it("checks object literal fields in their lexical scope", () => {
    const source = [
      "interface User:",
      "  name: string",
      "fn make(name: int) -> User:",
      "  user: User = { name: name }",
      "  return user",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'int' is not assignable to field 'name: string'",
    ]);
  });

  it("supports interface index signatures with explicit fields", () => {
    const source = [
      "interface PricePanel:",
      "  _dates: string[]",
      "  [key: string]: float[]",
      "data: PricePanel = load_json<PricePanel>(\"prices.json\")",
      "dates = data[\"_dates\"]",
      "sym = \"FPT\"",
      "prices = data[sym]",
      "bad: string[] = data[sym]",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'float[]' is not assignable to 'string[]'",
    ]);
    expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "data", type: "PricePanel" }),
      expect.objectContaining({ name: "dates", type: "string[]" }),
      expect.objectContaining({ name: "prices", type: "float[]" }),
    ]));
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
      "bad_arg = id<string>(1)",
    ].join("\n");

    expect(messages(source)).toEqual([
      "Type 'float' is not assignable to return type 'string'",
      "Type 'string' is not assignable to 'float'",
      "Type 'int' is not assignable to parameter 'value: string'",
    ]);
  });

  it("normalizes fn-prefixed function return annotations", () => {
    const source = [
      "fn adder(base: int) -> fn(int) -> int:",
      "  fn add(x: int) -> int:",
      "    return base + x",
      "  return add",
      "inc = adder(1)",
      "value: int = inc(2)",
    ].join("\n");

    expect(messages(source)).toEqual([]);
    expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "inc", type: "(int) -> int" }),
      expect.objectContaining({ name: "value", type: "int" }),
    ]));
  });

  it("context-checks fn-prefixed function variable annotations", () => {
    expect(messages([
      "adder: fn(int) -> int = x => x + 1",
      "value: int = adder(2)",
    ].join("\n"))).toEqual([]);

    expect(messages("bad: fn(int) -> string = x => x + 1")).toEqual([
      "Type 'int' is not assignable to return type 'string'",
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

  it("normalizes array suffixes in parameter diagnostics", () => {
    const diagnostics = checkSource([
      "fn first_over(values: int[], threshold: int) -> int | null:",
      "  return null",
      "first_over('nums', 4)",
    ].join("\n"), "strict");

    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 3,
        column: 12,
        message: "Type 'string' is not assignable to parameter 'values: int[]'",
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

    it("keeps decimal zero literals as floats", () => {
      const source = [
        "xs = [0.0, 0.0]",
        "i = 0",
        "xs[i] += 1.5",
      ].join("\n");

      expect(messages(source)).toEqual([]);
      expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "xs", type: "float[]" }),
      ]));
    });

    it("accepts numeric widening but rejects narrowing", () => {
      expect(messages("fn widen(n: int) -> float:\n  return n")).toEqual([]);
      expect(messages("fn narrow(n: float) -> int:\n  return n")).toEqual([
        "Type 'float' is not assignable to return type 'int'",
      ]);
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
        "Type 'int[]' is not assignable to return type 'int'",
      ]);
    });
  });

  describe("array literal inference", () => {
    it("collapses homogeneous array literals to element arrays", () => {
      const symbols = inferSymbolTypes([
        "ints = [3, 1, 4, 1, 5]",
        "floats = [1, 2.5]",
        "names = [\"ada\", \"grace\"]",
      ].join("\n"));

      expect(symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "ints", type: "int[]" }),
        expect.objectContaining({ name: "floats", type: "float[]" }),
        expect.objectContaining({ name: "names", type: "string[]" }),
      ]));
    });

    it("keeps heterogeneous array literals as tuples and context-checks tuple targets", () => {
      const source = [
        "mixed = [1, \"ok\"]",
        "pair: [float, string] = [1, \"ok\"]",
        "bad: [float, string] = [\"x\", 1]",
      ].join("\n");

      expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "mixed", type: "[int, string]" }),
        expect.objectContaining({ name: "pair", type: "[float, string]" }),
      ]));
      expect(messages(source)).toEqual([
        "Type '[string, int]' is not assignable to '[float, string]'",
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

  describe("call arity", () => {
    it("rejects extra positional arguments unless a rest parameter exists", () => {
      const source = [
        "fn one(a: int) -> int:",
        "  return a",
        "one(1, 2)",
        "print(1, 2)",
      ].join("\n");

      expect(messages(source)).toEqual([
        "Too many positional arguments for one()",
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
        "Type 'string[]' is not assignable to 'string | float[]'",
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
      const source = [
        "x = tensor([[1.0], [2.0]])",
        "y = tensor([0.0, 1.0])",
        "parts = train_test_split(x, y, test_size=0.2, shuffle=false)",
      ].join("\n");
      expect(messages(source)).toEqual([]);
    });

    it("still rejects an option the runtime does not take", () => {
      const source = [
        "x = tensor([[1.0], [2.0]])",
        "y = tensor([0.0, 1.0])",
        "parts = train_test_split(x, y, stratified=true)",
      ].join("\n");
      expect(messages(source)).toEqual([
        "Unknown named argument 'stratified' for train_test_split()",
      ]);
    });
  });

  describe("mlfw builtin signatures", () => {
    it("checks tensor options and reports diagnostics at the bad value", () => {
      const source = 'x = zeros([2], requires_grad="yes")';
      const diagnostics = checkSource(source, "strict");
      expect(diagnostics).toEqual([
        expect.objectContaining({
          line: 1,
          column: source.indexOf('"yes"') + 1,
          message: "Type 'string' is not assignable to parameter 'requires_grad: bool'",
        }),
      ]);
    });

    it("accepts recursive numeric tensor data and rejects non-numeric leaves", () => {
      expect(messages("x = tensor([[[1, 2], [3, 4]]])")).toEqual([]);

      const source = 'x = tensor([[1], ["bad"]])';
      const diagnostics = checkSource(source, "strict");
      expect(diagnostics).toEqual([
        expect.objectContaining({
          line: 1,
          column: source.indexOf("[[1]") + 1,
          message: "Type '[int[], string[]]' is not assignable to parameter 'data: TensorDataInput'",
        }),
      ]);
    });

    it("checks numeric distribution inputs without falling back to any", () => {
      const source = 'p = normal_cdf("bad")';
      const diagnostics = checkSource(source, "strict");
      expect(diagnostics).toEqual([
        expect.objectContaining({
          line: 1,
          column: source.indexOf('"bad"') + 1,
          message: "Type 'string' is not assignable to parameter 'x: NumericElementInput'",
        }),
      ]);
    });

    it("types linalg object results structurally", () => {
      const source = [
        "a = tensor([[1.0, 0.0], [0.0, 1.0]])",
        "s = svd(a)",
        "u: Tensor = s.U",
        "bad: int = s.S",
      ].join("\n");
      expect(messages(source)).toEqual([
        "Type 'Tensor' is not assignable to 'int'",
      ]);
      expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "s", type: "SVDResult" }),
        expect.objectContaining({ name: "u", type: "Tensor" }),
      ]));
    });

    it("checks ml estimator options and methods with concrete types", () => {
      const ok = [
        "x = tensor([[1.0], [2.0]])",
        "y = tensor([0.0, 1.0])",
        "ridge = Ridge(alpha=1.0, fit_intercept=true)",
        "fit = ridge.fit(x, y)",
        "pred: Tensor = fit.predict(x)",
      ].join("\n");
      expect(messages(ok)).toEqual([]);
      expect(inferSymbolTypes(ok)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "ridge", type: "Ridge" }),
        expect.objectContaining({ name: "fit", type: "Ridge" }),
      ]));

      expect(messages('bad = Ridge(alpha="x")')).toEqual([
        "Type 'string' is not assignable to parameter 'alpha: float'",
      ]);
    });

    it("calls model fields using the field's concrete module type", () => {
      const source = [
        "model Bot(vocab: int, dim: int, hidden: int):",
        "  embed = Embedding(vocab, dim)",
        "  encoder = GRU(dim, hidden, 1, true)",
        "",
        "fn encode(m: Bot, ids: Tensor) -> Tensor:",
        "  emb = m.embed(ids)",
        "  enc, state = m.encoder(emb)",
        "  return enc",
      ].join("\n");
      expect(messages(source)).toEqual([]);
      expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "emb", type: "Tensor" }),
        expect.objectContaining({ name: "enc", type: "Tensor" }),
        expect.objectContaining({ name: "state", type: "Tensor" }),
      ]));
    });

    it("keeps index tensors as tensors while item returns int", () => {
      const source = [
        "logits = tensor([0.1, 0.9])",
        "idx = logits.argmax()",
        "shape: int[] = idx.shape",
        "last: int = idx.item()",
        "bad: float[] = idx.item()",
      ].join("\n");
      expect(messages(source)).toEqual([
        "Type 'int' is not assignable to 'float[]'",
      ]);
      expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx", type: "IndexTensor" }),
        expect.objectContaining({ name: "shape", type: "int[]" }),
        expect.objectContaining({ name: "last", type: "int" }),
      ]));
    });

    it("types estimator factories and tokenizer special tokens structurally", () => {
      const ok = [
        "x = tensor([[1.0], [2.0]])",
        "y = tensor([0.0, 1.0])",
        "scores = cross_val_score(params => Ridge(alpha=1.0), x, y, cv=2)",
        "search = GridSearchCV(params => Ridge(alpha=1.0), { alpha: [0.1, 1.0] })",
        "tok = Tokenizer(special_tokens={ pad: \"<pad>\", eos: \"</s>\" })",
      ].join("\n");
      expect(messages(ok)).toEqual([]);
      expect(inferSymbolTypes(ok)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "scores", type: "float[]" }),
        expect.objectContaining({ name: "search", type: "GridSearchCV" }),
        expect.objectContaining({ name: "tok", type: "Tokenizer" }),
      ]));

      expect(messages('tok = Tokenizer(special_tokens={ pad: 1 })')).toEqual([
        "Type 'int' is not assignable to field 'pad: string'",
      ]);
    });

    it("rejects stale constructor surface that is not in the package types", () => {
      expect(messages("Embedding(10, 4, padding_idx=0)")).toEqual([
        "Unknown named argument 'padding_idx' for Embedding()",
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
