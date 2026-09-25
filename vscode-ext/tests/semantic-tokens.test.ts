import { afterEach, describe, expect, it } from "vitest";
import { buildSemanticTokens, semanticTokenLegend } from "../src/server/providers/semantic-tokens.ts";
import { cleanupProjects, contextFor, projectFor } from "./provider-harness.ts";
import type { ProviderContext } from "../src/server/providers/types.ts";

const URI = "file:///test.tera";

type DecodedToken = {
  line: number;
  character: number;
  text: string;
  type: string;
};

function semanticTokensFor(source: string, context: ProviderContext = contextFor(source), uri = URI): DecodedToken[] {
  const document = context.analyzer.get(uri);
  if (!document) throw new Error("missing analyzed document");
  const lines = source.split(/\r\n|\r|\n/);
  const encoded = buildSemanticTokens(document, context, uri).data;
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
  afterEach(() => cleanupProjects());

  it("classifies names imported from another module by their exported kind", () => {
    const source = "from lib import helper, Widget, Shape";
    const project = projectFor({
      "main.tera": source,
      "lib/__init__.tera": "from .api import helper, Widget, Shape",
      "lib/api.tera": [
        "fn helper() -> int:",
        "  return 1",
        "class Widget:",
        "  public constructor():",
        "    this.ready = true",
        "interface Shape:",
        "  area: () -> float",
      ].join("\n"),
    }, ["main.tera"]);
    const importedNames = project.context.modules
      .importedNames(`${project.root}/main.tera`, source.split("\n"))
      .map(({ local, kind }) => [local, kind]);

    expect(importedNames).toEqual([
      ["helper", "function"],
      ["Widget", "class"],
      ["Shape", "interface"],
    ]);
    const tokens = semanticTokensFor(source, project.context, project.uri("main.tera"));

    expect(typeAt(source, tokens, source, "helper")).toBe("function");
    expect(typeAt(source, tokens, source, "Widget")).toBe("class");
    expect(typeAt(source, tokens, source, "Shape")).toBe("type");
  });

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
      "class NumberSchema:",
      "  constructor():",
      "    this.int = (message: string = \"\") => _number_int(this, message)",
      "fn _number_int(schema: NumberSchema, message: string) -> NumberGuard:",
      "  return schema",
      "type GuardResultOf<T> = {",
      "  value: T | null,",
      "}",
      "type GuardObjectValue = { [key: string]: unknown }",
      "type GuardRule = { kind: string, value?: any, message: string }",
    ].join("\n");
    const tokens = semanticTokensFor(source);

    expect(typeAt(source, tokens, "validate: (value", "validate")).toBe("method");
    expect(typeAt(source, tokens, "of: (schema", "of")).toBe("method");
    expect(typeAt(source, tokens, "length: (size", "length")).toBe("method");
    expect(typeAt(source, tokens, "boolean:", "boolean")).toBe("variable");
    expect(typeAt(source, tokens, "  validate: validate", "validate")).toBe("variable");
    expect(typeAt(source, tokens, "  validate: validate", "validate", true)).toBe("function");
    expect(typeAt(source, tokens, "maybe?:", "maybe")).toBe("variable");
    expect(typeAt(source, tokens, "this.int", "int")).toBe("variable");
    expect(typeAt(source, tokens, "this.int = (message", "message")).toBe("parameter");
    expect(typeAt(source, tokens, "this.int = (message", "string")).toBe("type");
    expect(typeAt(source, tokens, "_number_int(this", "_number_int")).toBe("function");
    expect(typeAt(source, tokens, "GuardResultOf<T>", "T")).toBe("type");
    expect(typeAt(source, tokens, "value: T", "T")).toBe("type");
    expect(typeAt(source, tokens, "[key:", "key")).toBe("parameter");
    expect(typeAt(source, tokens, "GuardRule", "kind")).toBe("variable");
    expect(typeAt(source, tokens, "GuardRule", "value")).toBe("variable");
    expect(typeAt(source, tokens, "GuardRule", "message")).toBe("variable");
  });
});
