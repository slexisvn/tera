import { describe, expect, it } from "vitest";
import { computeHover } from "../src/server/providers/hover.ts";
import { contextFor } from "./provider-harness.ts";

function hoverText(source: string, line: number, character: number): string {
  const hover = computeHover(contextFor(source), {
    textDocument: { uri: "file:///test.tera" },
    position: { line, character },
  });
  const contents = hover?.contents;
  return typeof contents === "string" ? contents : String(contents?.value ?? "");
}

describe("hover", () => {
  it("shows getter return types as property types", () => {
    const text = hoverText("tok = Tokenizer()\ntok.vocab_size", 1, "tok.vocab_size".length);
    expect(text).toContain("_property of Tokenizer_");
    expect(text).toContain("type: `int`");
  });

  it("shows property types for other class-like builtin values", () => {
    const text = hoverText("x = tensor([1])\nx.shape", 1, "x.shape".length);
    expect(text).toContain("_property of Tensor_");
    expect(text).toContain("type: `int[]`");
  });

  it("shows homogeneous array literals as element arrays", () => {
    const text = hoverText("nums = [3, 1, 4, 1, 5]\nnums", 1, 2);
    expect(text).toContain("`nums` — *variable*");
    expect(text).toContain("type: `int[]`");
  });

  it("shows types inferred through nested indexes", () => {
    const text = hoverText("matrix = [[1, 2], [3, 4]]\ncell = matrix[0][1]\ncell", 2, 2);
    expect(text).toContain("`cell` — *variable*");
    expect(text).toContain("type: `int`");
  });

  it("shows fn-prefixed returned function types in canonical form", () => {
    const source = [
      "fn adder(base: int) -> fn(int) -> int:",
      "  fn add(x: int) -> int:",
      "    return base + x",
      "  return add",
      "inc = adder(1)",
      "inc",
    ].join("\n");

    const text = hoverText(source, 5, 2);
    expect(text).toContain("`inc` — *variable*");
    expect(text).toContain("type: `(int) -> int`");
  });

  it("shows types inferred through callable model fields", () => {
    const source = [
      "model Bot(vocab: int, dim: int, hidden: int):",
      "  embed = Embedding(vocab, dim)",
      "  encoder = GRU(dim, hidden, 1, true)",
      "",
      "fn encode(m: Bot, ids: Tensor) -> Tensor:",
      "  emb = m.embed(ids)",
      "  enc, state = m.encoder(emb)",
      "  enc",
    ].join("\n");

    const text = hoverText(source, 7, 2);
    expect(text).toContain("`enc` — *variable*");
    expect(text).toContain("type: `Tensor`");
  });

  it("does not expose model constructor parameters as model fields", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  embed = Embedding(vocab_size, embed_size)",
      "",
      "net = ChatBotLarge(\"abc\", 8)",
      "net.vocab_size",
    ].join("\n");

    expect(hoverText(source, 4, "net.vocab_size".length)).toBe("");
  });

  it("shows model body assignments as model fields", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  saved_vocab = vocab_size",
      "",
      "net = ChatBotLarge(\"abc\", 8)",
      "net.saved_vocab",
    ].join("\n");

    const text = hoverText(source, 4, "net.saved_vocab".length);
    expect(text).toContain("`ChatBotLarge.saved_vocab`");
    expect(text).toContain("type: `string`");
  });

  it("shows comprehension variable types from generic collection elements", () => {
    const source = [
      "interface ChatRow:",
      "  question: string",
      "  answer: string",
      "train_rows = load_csv(\"examples/chat_train.csv\").to_array<ChatRow>()",
      "train_q_text = [r.question for r of train_rows]",
    ].join("\n");

    const text = hoverText(source, 4, "train_q_text = [r".length);
    expect(text).toContain("`r` — *variable*");
    expect(text).toContain("type: `ChatRow`");
  });

  it("shows builtin interface field types for inferred builtin results", () => {
    const source = [
      "prices = DataFrame(",
      "  tech=[100, 102, 101, 105, 108, 107, 110, 113, 111, 115],",
      "  bank=[50, 49, 51, 50, 48, 49, 47, 48, 46, 45],",
      "  energy=[30, 31, 33, 32, 34, 36, 35, 37, 39, 38],",
      ")",
      "result = backtest(prices, signal=\"momentum\", portfolio=\"long_short\", lookback=3)",
      "result.metrics",
    ].join("\n");

    const text = hoverText(source, 6, "result.metrics".length);
    expect(text).toContain("`QuantBacktestResult.metrics`");
    expect(text).toContain("type: `QuantMetrics`");
  });

  it("shows contextual types for Promise arrow callback parameters", () => {
    const source = "Promise.resolve(10).then(v => v * 2).then(v => v + 1).then(v => print(\"chained ->\", v))";

    const text = hoverText(source, 0, source.indexOf("v =>"));

    expect(text).toContain("`v` — *parameter*");
    expect(text).toContain("type: `int`");
  });

  it("shows fluent class method types through chained receiver expressions", () => {
    const source = [
      "class Account:",
      "  constructor(owner: string, balance: float = 0.0):",
      "    this.owner = owner",
      "    this.balance = balance",
      "  deposit(amount: float):",
      "    this.balance += amount",
      "    return this",
      "  withdraw(amount: float):",
      "    this.balance -= amount",
      "    return this",
      "acc = Account(\"alice\")",
      "acc.deposit(100.0).withdraw(30.0).deposit(5.5)",
    ].join("\n");

    const text = hoverText(source, 11, "acc.deposit(100.0).withdraw".length);

    expect(text).toContain("`Account.withdraw`");
    expect(text).toContain("type: `(float) -> Account`");
  });

  it("shows inherited class methods through nominal array element inference", () => {
    const source = [
      "class Shape:",
      "  constructor(name: string):",
      "    this.name = name",
      "  area() -> float:",
      "    return 0.0",
      "  describe() -> string:",
      "    return `${this.name} with area ${this.area()}`",
      "class Circle extends Shape:",
      "  constructor(r: float):",
      "    super(name=\"circle\")",
      "    this.r = r",
      "  area() -> float:",
      "    return 3.14159 * this.r * this.r",
      "class Rectangle extends Shape:",
      "  constructor(w: float, h: float):",
      "    super(name=\"rectangle\")",
      "    this.w = w",
      "    this.h = h",
      "  area() -> float:",
      "    return this.w * this.h",
      "shapes = [Circle(2.0), Rectangle(3.0, 4.0), Circle(1.0)]",
      "for s of shapes:",
      "  print(s.describe())",
    ].join("\n");

    const text = hoverText(source, 22, "  print(s.describe".length);

    expect(text).toContain("`Shape.describe`");
    expect(text).toContain("type: `() -> string`");
  });

  it("shows super and inherited method types inside subclasses", () => {
    const source = [
      "interface RequestHandler:",
      "  handle(request: string) -> string",
      "class Handler implements RequestHandler:",
      "  constructor(next: RequestHandler | null = null):",
      "    this.next = next",
      "  handle(request: string) -> string:",
      "    return request",
      "class CacheHandler extends Handler:",
      "  constructor(next: RequestHandler | null = null):",
      "    super(next)",
      "  handle(request: string) -> string:",
      "    return super.handle(request)",
    ].join("\n");

    const superCtor = hoverText(source, 9, "    super".length);
    const methodDecl = hoverText(source, 10, "  handle".length);
    const superMethod = hoverText(source, 11, "    return super.handle".length);

    expect(superCtor).toContain("`super` — *variable*");
    expect(superCtor).toContain("type: `Handler`");
    expect(methodDecl).toContain("`handle` — *method*");
    expect(methodDecl).toContain("type: `(string) -> string`");
    expect(superMethod).toContain("`Handler.handle`");
    expect(superMethod).toContain("type: `(string) -> string`");
  });

  it("shows protected inherited method types through super inside subclasses", () => {
    const source = [
      "class Handler:",
      "  protected handle(request: string) -> string:",
      "    return request",
      "class CacheHandler extends Handler:",
      "  read(request: string) -> string:",
      "    return super.handle(request)",
    ].join("\n");

    const superMethod = hoverText(source, 5, "    return super.handle".length);

    expect(superMethod).toContain("`Handler.handle`");
    expect(superMethod).toContain("type: `(string) -> string`");
  });

  it("shows class instance fields on this", () => {
    const source = [
      "class Account:",
      "  constructor(owner: string, balance: float = 0.0):",
      "    this.owner = owner",
      "    this.balance = balance",
      "  get summary():",
      "    return `${this.owner}: ${this.balance}`",
    ].join("\n");

    const text = hoverText(source, 5, "    return `${this.owner".length);

    expect(text).toContain("`Account.owner`");
    expect(text).toContain("type: `string`");
  });

  it("does not show inaccessible private class fields outside the declaring class", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "acc = Account()",
      "acc.balance",
    ].join("\n");

    expect(hoverText(source, 3, "acc.balance".length)).toBe("");
  });

  it("shows primitive string method types", () => {
    const source = [
      "name: string = \"tera\"",
      "name.to_upper_case()",
    ].join("\n");

    const text = hoverText(source, 1, "name.to_upper_case".length);

    expect(text).toContain("to_upper_case");
    expect(text).toContain("type: `() -> string`");
  });

  it("shows primitive number and boolean method types", () => {
    const numberSource = [
      "score: float = 3.14",
      "score.to_fixed(2)",
    ].join("\n");
    const boolSource = [
      "ready: bool = true",
      "ready.to_string()",
    ].join("\n");

    expect(hoverText(numberSource, 1, "score.to_fixed".length)).toContain("type: `(int) -> string`");
    expect(hoverText(boolSource, 1, "ready.to_string".length)).toContain("type: `() -> string`");
  });

  it("shows reactive mutation method hovers and direct read types", () => {
    const source = [
      "signal tally = 1",
      "current = tally",
      "tally.set(2)",
    ].join("\n");

    const currentText = hoverText(source, 1, "current".length);
    const setText = hoverText(source, 2, "tally.set".length);

    expect(currentText).toContain("`current` — *variable*");
    expect(currentText).toContain("type: `int`");
    expect(setText).toContain("`ReactiveSignal<int>.set`");
    expect(setText).toContain("*method of ReactiveSignal<int>*");
    expect(setText).toContain("type: `(value: int) -> ReactiveSignal<int>`");
  });

  it("shows reactive resource direct read and state member hovers", () => {
    const source = [
      "resource profile = 42",
      "current = profile",
      "profile.loading",
    ].join("\n");

    const currentText = hoverText(source, 1, "current".length);
    const loadingText = hoverText(source, 2, "profile.loading".length);

    expect(currentText).toContain("`current` — *variable*");
    expect(currentText).toContain("type: `int | undefined`");
    expect(loadingText).toContain("`ReactiveResource<int>.loading`");
    expect(loadingText).toContain("type: `bool`");
  });

  it("does not resolve symbols inside quoted string literal text", () => {
    const source = [
      "a = tensor(0)",
      "print('a')",
    ].join("\n");

    const text = hoverText(source, 1, "print('a".length);

    expect(text).toBe("");
  });
});
