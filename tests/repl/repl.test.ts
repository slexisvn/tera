import { describe, expect, it } from "vitest";
import { assess, lineContinuation, stripLineContinuation } from "../../src/cli/repl/multiline.js";
import { createLanguage } from "../../src/cli/repl/language.js";
import { createAnalyzer } from "../../src/cli/repl/analysis.js";
import { createCompleter } from "../../src/cli/repl/completion.js";
import { createTokenHook, TERA_TOKEN_REGEXP } from "../../src/cli/repl/highlight.js";
import { defaultTheme } from "../../src/cli/repl/theme.js";
import { suggestNames } from "../../src/cli/repl/suggest.js";
import type { Terminal } from "../../src/cli/repl/types.js";

function labelsOf(result: string | string[]): string[] {
  return Array.isArray(result) ? [...result] : [result];
}

function fakeTerminal(): Terminal {
  const style: unknown = new Proxy(() => {}, { get: () => style });
  return new Proxy(() => {}, { get: () => style }) as unknown as Terminal;
}

describe("multiline.assess", () => {
  it("treats a balanced single statement as complete", () => {
    expect(assess("x = 1").complete).toBe(true);
    expect(assess('print("hi")').complete).toBe(true);
  });

  it("waits for a block body after a colon header", () => {
    const status = assess("fn f():");
    expect(status.complete).toBe(false);
    expect(status.indent).toBe("  ");
  });

  it("keeps reading an open block until a blank line", () => {
    expect(assess("fn f():\n  return 1").complete).toBe(false);
    expect(assess("fn f():\n  return 1\n").complete).toBe(true);
  });

  it("keeps reading while brackets are open", () => {
    expect(assess("xs = [1,").complete).toBe(false);
    expect(assess("xs = [1,\n2]").complete).toBe(true);
  });

  it("keeps reading after a trailing operator", () => {
    expect(assess("x = 1 +").complete).toBe(false);
    expect(assess("x = 1 + 2").complete).toBe(true);
  });

  it("handles nested control flow blocks", () => {
    expect(assess("for i of range(3):\n  if i > 0:\n    print(i)\n").complete).toBe(true);
    expect(assess("for i of range(3):\n  if i > 0:").complete).toBe(false);
  });
});

describe("line continuation", () => {
  it("treats a single trailing backslash as a continuation", () => {
    expect(lineContinuation("x = 1 \\")).toBe(true);
    expect(lineContinuation("x = 1")).toBe(false);
  });

  it("ignores an escaped (even) trailing backslash", () => {
    expect(lineContinuation("x = 1 \\\\")).toBe(false);
  });

  it("strips only the final backslash", () => {
    expect(stripLineContinuation("x = 1 \\")).toBe("x = 1 ");
  });
});

describe("language data", () => {
  const language = createLanguage();
  it("exposes tera builtins, keywords and types from the spec", () => {
    expect(language.builtins.has("print")).toBe(true);
    expect(language.builtins.has("range")).toBe(true);
    expect(language.keywords.has("fn")).toBe(true);
    expect(language.keywords.has("class")).toBe(true);
    expect(language.types.has("int")).toBe(true);
  });
  it("sources builtins from the language spec rather than a static javascript list", () => {
    expect(language.builtins.size).toBeGreaterThan(10);
    for (const builtin of language.builtins.values()) {
      expect(typeof builtin.name).toBe("string");
    }
  });
  it("provides signatures and docs", () => {
    expect(language.signatureOf("range")).toContain("range");
  });
});

describe("completion", () => {
  const language = createLanguage();
  const analyzer = createAnalyzer();

  const makeCompleter = (sessionSource: string) =>
    createCompleter({
      language,
      analyzer,
      sessionSource: () => sessionSource,
      engineGlobals: () => [],
      commandNames: () => ["exit", "reset", "help"],
    });

  it("completes tera builtins", () => {
    const labels = labelsOf(makeCompleter("")("prin"));
    expect(labels.some((label) => label.includes("print"))).toBe(true);
  });

  it("completes command names after a dot", () => {
    const labels = labelsOf(makeCompleter("")(".re"));
    expect(labels.some((label) => label.includes("reset"))).toBe(true);
  });

  it("completes members of an inferred string value", () => {
    const labels = labelsOf(makeCompleter('s = "hello"')("s."));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((label) => label.includes("to_upper_case"))).toBe(true);
  });
});

describe("highlight", () => {
  const language = createLanguage();
  const hook = createTokenHook(language, defaultTheme);
  const term = fakeTerminal();

  it("tokenizes tera source", () => {
    TERA_TOKEN_REGEXP.lastIndex = 0;
    const tokens = 'fn f(): # note'.match(TERA_TOKEN_REGEXP) ?? [];
    expect(tokens).toContain("fn");
    expect(tokens).toContain("# note");
  });

  it("styles keywords and builtins but not plain identifiers", () => {
    expect(hook("fn", true, [], term, {})).toBeTruthy();
    expect(hook("print", true, [], term, {})).toBeTruthy();
    expect(hook("myLocalName", true, [], term, {})).toBeUndefined();
  });
});

describe("suggest", () => {
  it("suggests near matches within the distance bound", () => {
    expect(suggestNames("prnt", ["print", "range", "len"])).toContain("print");
    expect(suggestNames("rang", ["print", "range", "len"])).toContain("range");
    expect(suggestNames("zzzzzz", ["print", "range"])).toHaveLength(0);
  });
});
