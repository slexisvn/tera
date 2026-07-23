import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LanguageData } from "../src/shared/language-data.ts";
import { DocumentAnalyzer } from "../src/server/analyzer/index.ts";
import { EventBus, type AnalyzerEvents } from "../src/server/bus.ts";
import { TypeResolver } from "../src/server/language/type-resolver.ts";
import { computeDefinition } from "../src/server/providers/definition.ts";
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

describe("definition", () => {
  it("does not jump from an unknown member to a same-named parameter", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  embed = Embedding(vocab_size, embed_size)",
      "",
      "tok = Tokenizer()",
      "net = ChatBotLarge(tok.vocab_size, 8)",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "net = ChatBotLarge(tok.vocab_size".length },
    });

    expect(location).toBeNull();
  });

  it("does not jump from a model parameter access that is not a runtime field", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  embed = Embedding(vocab_size, embed_size)",
      "",
      "net = ChatBotLarge(\"abc\", 8)",
      "net.vocab_size",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "net.vocab_size".length },
    });

    expect(location).toBeNull();
  });

  it("jumps from a model field access to the body assignment", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  saved_vocab = vocab_size",
      "",
      "net = ChatBotLarge(\"abc\", 8)",
      "net.saved_vocab",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "net.saved_vocab".length },
    });

    expect(location?.range.start).toEqual({ line: 1, character: 2 });
    expect(location?.range.end).toEqual({ line: 1, character: "  saved_vocab".length });
  });
});
