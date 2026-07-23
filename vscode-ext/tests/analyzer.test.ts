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
});

describe("analyzeTokens", () => {
  it("classifies keywords, identifiers, numbers and strings", () => {
    const kinds = new Map(analyzeTokens('fn f():\n  x = "s"\n').map((t) => [t.value, t.type]));
    expect(kinds.get("fn")).toBe("keyword");
    expect(kinds.get("f")).toBe("identifier");
    expect(kinds.get("s")).toBe("string");
  });

  it("gives each token an end position", () => {
    const [first] = analyzeTokens("value = 1\n");
    expect(first).toMatchObject({ value: "value", column: 1, endColumn: 6 });
  });

  it("returns an empty list rather than throwing on bad input", () => {
    expect(analyzeTokens("###")).toEqual([]);
  });
});
