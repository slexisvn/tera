import { describe, expect, it } from "vitest";
import { analyzeDiagnostics } from "../src/server/analyzer/diagnostics.ts";
import { analyzeTokens } from "../src/server/analyzer/tokens.ts";
import { DocumentAnalyzer } from "../src/server/analyzer/index.ts";
import { toDiagnostic } from "../src/server/providers/diagnostics.ts";

describe("analyzeDiagnostics", () => {
  it("reports checker type errors", () => {
    const errors = analyzeDiagnostics('x: int = "hello"\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ severity: "error", line: 1 });
    expect(errors[0].message).toContain("not assignable");
  });

  it("turns a thrown parse failure into a diagnostic instead of crashing", () => {
    const errors = analyzeDiagnostics("fn broken(\n");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });

  it("reports a lexer error with its real position", () => {
    const errors = analyzeDiagnostics('x = "unterminated\n');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ line: 1, severity: "error" });
    expect(errors[0].message).toMatch(/string/i);
  });

  it("returns nothing for valid source", () => {
    expect(analyzeDiagnostics("x = 1\n")).toEqual([]);
  });

  it("accepts reactive syntax and reports reactive member type errors", () => {
    const valid = [
      "signal count = 1",
      "computed doubled = count * 2",
      "resource remote = doubled + 1",
      "effect:",
      "  print(remote)",
    ].join("\n");

    expect(analyzeDiagnostics(valid)).toEqual([]);
    expect(analyzeDiagnostics([
      "signal count = 1",
      "count.set(\"bad\")",
    ].join("\n"))).toEqual([
      expect.objectContaining({
        line: 2,
        column: "count.set(".length + 1,
        message: "Type 'string' is not assignable to parameter 'value: int'",
      }),
    ]);
  });

  it("reports undefined identifiers through checker diagnostics", () => {
    const source = [
      "class Account:",
      "  public constructor(owner: string, balance: float = 0.0):",
      "    this.owner = owner",
      "    this.balance = balance",
      "acc = Account(ashdasr)",
    ].join("\n");
    const analyzer = new DocumentAnalyzer();
    const document = analyzer.update("file:///test.tera", source);
    const diagnostic = toDiagnostic(document.errors[0], document);

    expect(document.errors[0]).toMatchObject({
      line: 5,
      column: 15,
      message: "undefined name 'ashdasr'",
    });
    expect(diagnostic.range).toEqual({
      start: { line: 4, character: 14 },
      end: { line: 4, character: 21 },
    });
  });

  it("reports inaccessible private class members through checker diagnostics", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "acc = Account()",
      "acc.balance",
    ].join("\n");

    expect(analyzeDiagnostics(source).map((diagnostic) => diagnostic.message)).toEqual([
      "Cannot access private member 'balance' of 'Account'",
    ]);
  });

  it("accepts fn-prefixed returned function types", () => {
    const source = [
      "fn adder(base: int) -> fn(int) -> int:",
      "  fn add(x: int) -> int:",
      "    return base + x",
      "  return add",
    ].join("\n");

    expect(analyzeDiagnostics(source)).toEqual([]);
  });

  it("accepts tensor scalar arithmetic overloads", () => {
    const source = [
      "x = tensor([[1.0, 2.0]])",
      "grad = tensor([[0.5, 0.25]])",
      "next = x - 0.1 * grad",
      "scaled = next / 2 + 1",
    ].join("\n");

    expect(analyzeDiagnostics(source)).toEqual([]);
  });

  it("keeps checker diagnostics on the bad argument through LSP ranges", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  forward (q: Tensor) -> Tensor:",
      "    return q",
      "tok = Tokenizer()",
      "net = ChatBotLarge(tok.vocab_size, 8)",
    ].join("\n");
    const analyzer = new DocumentAnalyzer();
    const document = analyzer.update("file:///test.tera", source);
    const diagnostic = toDiagnostic(document.errors[0], document);

    expect(document.errors[0]).toMatchObject({
      line: 5,
      column: 20,
      message: "Type 'int' is not assignable to parameter 'vocab_size: string'",
    });
    expect(diagnostic.range).toEqual({
      start: { line: 4, character: 19 },
      end: { line: 4, character: 22 },
    });
  });

  it("keeps string argument diagnostics on the whole string literal", () => {
    const source = [
      "fn first_over(values: int[], threshold: int) -> int | null:",
      "  return null",
      "nums = [3, 1, 4, 1, 5, 9, 2, 6]",
      "print(\"first value > 4:\", first_over('nums', 4))",
    ].join("\n");
    const analyzer = new DocumentAnalyzer();
    const document = analyzer.update("file:///test.tera", source);
    const diagnostic = toDiagnostic(document.errors[0], document);
    const line = source.split("\n")[3];
    const start = line.indexOf("'nums'");

    expect(document.errors[0]).toMatchObject({
      line: 4,
      column: start + 1,
      message: "Type 'string' is not assignable to parameter 'values: int[]'",
    });
    expect(diagnostic.range).toEqual({
      start: { line: 3, character: start },
      end: { line: 3, character: start + "'nums'".length },
    });
  });

  it("keeps bad index diagnostics on the whole key literal", () => {
    const source = ["xs = [1, 2]", "v = xs[\"0\"]"].join("\n");
    const analyzer = new DocumentAnalyzer();
    const document = analyzer.update("file:///test.tera", source);
    const diagnostic = toDiagnostic(document.errors[0], document);

    expect(document.errors[0]).toMatchObject({
      line: 2,
      column: 8,
      message: "Type 'string' is not assignable to index type 'int'",
    });
    expect(diagnostic.range).toEqual({
      start: { line: 1, character: 7 },
      end: { line: 1, character: 10 },
    });
  });

  it("keeps reassignment diagnostics on the whole assigned literal", () => {
    const source = ["x: int = 1", "x = \"bad\""].join("\n");
    const analyzer = new DocumentAnalyzer();
    const document = analyzer.update("file:///test.tera", source);
    const diagnostic = toDiagnostic(document.errors[0], document);

    expect(document.errors[0]).toMatchObject({
      line: 2,
      column: 5,
      message: "Type 'string' is not assignable to 'int'",
    });
    expect(diagnostic.range).toEqual({
      start: { line: 1, character: 4 },
      end: { line: 1, character: 9 },
    });
  });

  it("keeps declared initializer diagnostics on the whole assigned literal", () => {
    const source = "x: int = \"bad\"";
    const analyzer = new DocumentAnalyzer();
    const document = analyzer.update("file:///test.tera", source);
    const diagnostic = toDiagnostic(document.errors[0], document);

    expect(document.errors[0]).toMatchObject({
      line: 1,
      column: 10,
      message: "Type 'string' is not assignable to 'int'",
    });
    expect(diagnostic.range).toEqual({
      start: { line: 0, character: 9 },
      end: { line: 0, character: 14 },
    });
  });

  it("keeps missing member-call argument diagnostics on the method name", () => {
    const source = [
      "interface Notifier:",
      "  send(message: string) -> string",
      "class PlainNotifier implements Notifier:",
      "  public send(message: string) -> string:",
      "    return message",
      "class SmsDecorator implements Notifier:",
      "  private next: Notifier = PlainNotifier()",
      "  public constructor(next: Notifier):",
      "    this.next = next",
      "  public send(message: string) -> string:",
      "    return this.next.send()",
    ].join("\n");
    const analyzer = new DocumentAnalyzer();
    const document = analyzer.update("file:///test.tera", source);
    const diagnostic = toDiagnostic(document.errors[0], document);

    expect(document.errors[0]).toMatchObject({
      line: 11,
      column: "    return this.next.".length + 1,
      message: "Missing required argument 'arg0' for send()",
    });
    expect(diagnostic.range).toEqual({
      start: { line: 10, character: "    return this.next.".length },
      end: { line: 10, character: "    return this.next.send".length },
    });
  });
});

describe("analyzeTokens", () => {
  it("classifies keywords, identifiers, numbers and strings", () => {
    const kinds = new Map(analyzeTokens('fn f():\n  x = "s"\n').map((t) => [t.value, t.type]));
    expect(kinds.get("fn")).toBe("keyword");
    expect(kinds.get("f")).toBe("identifier");
    expect(kinds.get("s")).toBe("string");
  });

  it("keeps void as an identifier so semantic tokens can classify it as a type", () => {
    const kinds = new Map(analyzeTokens("fn f() -> void:\n").map((t) => [t.value, t.type]));
    expect(kinds.get("void")).toBe("identifier");
  });

  it("gives each token an end position", () => {
    const [first] = analyzeTokens("value = 1\n");
    expect(first).toMatchObject({ value: "value", column: 1, endColumn: 6 });
  });

  it("uses lexical string spans while keeping semantic string values", () => {
    const token = analyzeTokens('x = "s"\n').find((item) => item.value === "s");
    expect(token).toMatchObject({
      value: "s",
      type: "string",
      column: 5,
      endColumn: 8,
    });
  });

  it("returns an empty list rather than throwing on bad input", () => {
    expect(analyzeTokens("###")).toEqual([]);
  });
});
