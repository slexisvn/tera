import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LanguageData } from "../src/shared/language-data.ts";
import { DocumentAnalyzer } from "../src/server/analyzer/index.ts";
import { EventBus, type AnalyzerEvents } from "../src/server/bus.ts";
import { TypeResolver } from "../src/server/language/type-resolver.ts";
import { computeHover } from "../src/server/providers/hover.ts";
import type { ProviderContext } from "../src/server/providers/types.ts";

const languageData = JSON.parse(readFileSync(join(import.meta.dirname, "..", "language-data.json"), "utf8")) as LanguageData;

function contextFor(source: string): ProviderContext {
  const analyzer = new DocumentAnalyzer(languageData);
  analyzer.update("file:///test.tera", source);
  return {
    analyzer,
    languageData,
    types: new TypeResolver(languageData),
    bus: new EventBus<AnalyzerEvents>(),
  };
}

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
});
