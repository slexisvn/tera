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
});
