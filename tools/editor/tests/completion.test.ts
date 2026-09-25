import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { makeCompletionSource } from "../src/extensions/completion";
import { languageData } from "../src/language-data";
import { analyzeDocuments } from "../src/analysis/symbols";

const everyMemberName = new Set(
  Object.values(languageData.pseudoTypes)
    .flat()
    .map((method) => method.name),
).size;

function complete(doc: string, names: readonly string[] = [], explicit = true) {
  const source = makeCompletionSource(names);
  const state = EditorState.create({ doc });
  return source(new CompletionContext(state, doc.length, explicit));
}

function labels(doc: string, names: readonly string[] = []): string[] {
  return (complete(doc, names)?.options ?? []).map((option) => option.label);
}

function completeWithAnalysis(doc: string, pos = doc.length) {
  const analysis = analyzeDocuments([{ id: "cell", source: doc }]);
  const source = makeCompletionSource(["_make_any"], () => analysis, "cell");
  const state = EditorState.create({ doc });
  return source(new CompletionContext(state, pos, true));
}

describe("completing after a dot", () => {
  it("offers only what the type before the dot actually has", () => {
    const math = labels("y = Math.");

    expect(math).toEqual([...math].sort((a, b) => a.localeCompare(b)));
    expect(math).toContain("sqrt");
    expect(math.length).toBeLessThan(everyMemberName);
    expect(math).not.toContain("slice");
    expect(math).not.toContain("subscribe");
  });

  it("labels each of them with the type they came from", () => {
    const options = complete("y = Math.")?.options ?? [];

    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.detail === "Math")).toBe(true);
  });

  it("keeps chart on its own list", () => {
    const chart = labels("chart.");

    expect(chart).toContain("line");
    expect(chart).not.toContain("sqrt");
  });

  it("falls back to every known member only when nothing names the receiver", () => {
    const unknown = labels("xs.");

    expect(unknown.length).toBe(everyMemberName);
  });

  it("narrows the list by what has been typed so far", () => {
    const all = labels("y = Math.");
    const some = labels("y = Math.s");

    expect(some.length).toBeLessThan(all.length);
    expect(some.every((label) => label.startsWith("s"))).toBe(true);
  });
});

describe("completing a bare word", () => {
  it("offers builtins, keywords and the names the document knows", () => {
    const offered = labels("pr", ["printer_name"]);

    expect(offered).toContain("print");
    expect(offered).toContain("printer_name");
  });

  it("offers a keyword that matches the prefix", () => {
    const keyword = languageData.keywords.find((name) => name.length > 2)!;

    expect(labels(keyword.slice(0, 2))).toContain(keyword);
  });

  it("offers type names instead of runtime names in annotations", () => {
    const offered = labels("guard: Gu", ["GuardApi"]);

    expect(offered).toContain("GuardApi");
    expect(offered).not.toContain("print");
  });

  it("does not offer members of a type when there is no dot", () => {
    expect(labels("sq")).not.toContain("sqrt");
  });

  it("hides names that start with an underscore", () => {
    expect(labels("_", ["_private", "_hidden"])).toEqual([]);
  });

  it("never offers the same label twice", () => {
    const offered = labels("a", ["abs", "abs"]);

    expect(new Set(offered).size).toBe(offered.length);
  });
});

describe("completing where it would be wrong to", () => {
  it("says nothing inside the text of a string", () => {
    expect(complete('label = "pr')).toBeNull();
  });

  it("says nothing for an empty prefix unless the caller asked explicitly", () => {
    expect(complete("", [], false)).toBeNull();
  });

  it("says nothing inside a known zero-argument member call", () => {
    const doc = [
      "interface GuardApi:",
      "  boolean: () -> BooleanGuard",
      "guard: GuardApi = {}",
      "guard.boolean()",
    ].join("\n");

    expect(completeWithAnalysis(doc, doc.length - 1)).toBeNull();
  });

  it("says nothing inside a known member call whose arguments are optional", () => {
    const doc = [
      "interface GuardApi:",
      "  array: (item_schema?: GuardSchema | null) -> ArrayGuard",
      "guard: GuardApi = {}",
      "guard.array()",
    ].join("\n");

    expect(completeWithAnalysis(doc, doc.length - 1)).toBeNull();
  });

  it("answers null rather than an empty list when nothing matches", () => {
    expect(complete("zzzz_no_such_prefix")).toBeNull();
  });
});
