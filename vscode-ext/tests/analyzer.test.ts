import { describe, expect, it } from "vitest";
import { analyzeDiagnostics } from "../src/server/analyzer/diagnostics.ts";
import { analyzeTokens } from "../src/server/analyzer/tokens.ts";

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
});

describe("analyzeTokens", () => {
  it("classifies keywords, identifiers, numbers and strings", () => {
    const kinds = new Map(analyzeTokens('fn f():\n  x = "s"\n').map((t) => [t.value, t.type]));
    expect(kinds.get("function")).toBe("keyword");
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
