import { describe, expect, it } from "vitest";
import { buildSemanticTokens, semanticTokenLegend } from "../src/server/providers/semantic-tokens.ts";
import { contextFor } from "./provider-harness.ts";

const URI = "file:///test.tera";

type DecodedToken = {
  line: number;
  character: number;
  text: string;
  type: string;
};

function semanticTokensFor(source: string): DecodedToken[] {
  const context = contextFor(source);
  const document = context.analyzer.get(URI);
  if (!document) throw new Error("missing analyzed document");
  const lines = source.split(/\r\n|\r|\n/);
  const encoded = buildSemanticTokens(document, context, URI).data;
  const decoded: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < encoded.length; index += 5) {
    line += encoded[index];
    character = encoded[index] === 0 ? character + encoded[index + 1] : encoded[index + 1];
    const length = encoded[index + 2];
    decoded.push({
      line,
      character,
      text: lines[line].slice(character, character + length),
      type: semanticTokenLegend.tokenTypes[encoded[index + 3]]!,
    });
  }
  return decoded;
}

function typeAt(source: string, tokens: readonly DecodedToken[], lineNeedle: string, token: string, fromEnd = false): string {
  const lines = source.split(/\r\n|\r|\n/);
  const line = lines.findIndex((candidate) => candidate.includes(lineNeedle));
  if (line < 0) throw new Error(`line ${JSON.stringify(lineNeedle)} not found`);
  const character = fromEnd ? lines[line].lastIndexOf(token) : lines[line].indexOf(token);
  return tokens.find((entry) => entry.line === line && entry.character === character)?.type ?? "missing";
}

describe("semantic tokens", () => {
  it("uses syntax context before same-named symbols or builtins", () => {
    const source = [
      "fn validate(value: unknown) -> bool:",
      "  return true",
      "",
      "fn _make_boolean() -> BooleanGuard:",
      "  return validate(true)",
      "",
      "interface ArrayGuard extends GuardSchema:",
      "  validate: (value: unknown, path?: string) -> GuardResultOf<unknown[]>",
      "  of: (schema: GuardSchema) -> ArrayGuard",
      "  length: (size: int, message?: string) -> ArrayGuard",
      "",
      "guard: GuardApi = {",
      "  boolean: _make_boolean,",
      "  validate: validate,",
      "}",
      "type Row = { maybe?: int }",
    ].join("\n");
    const tokens = semanticTokensFor(source);

    expect(typeAt(source, tokens, "validate: (value", "validate")).toBe("method");
    expect(typeAt(source, tokens, "of: (schema", "of")).toBe("method");
    expect(typeAt(source, tokens, "length: (size", "length")).toBe("method");
    expect(typeAt(source, tokens, "boolean:", "boolean")).toBe("variable");
    expect(typeAt(source, tokens, "  validate: validate", "validate")).toBe("variable");
    expect(typeAt(source, tokens, "  validate: validate", "validate", true)).toBe("function");
    expect(typeAt(source, tokens, "maybe?:", "maybe")).toBe("variable");
  });
});
