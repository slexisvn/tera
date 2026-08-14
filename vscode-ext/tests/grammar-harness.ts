import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as oniguruma from "vscode-oniguruma";
import * as textmate from "vscode-textmate";

const require = createRequire(import.meta.url);
const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRAMMAR_PATH = resolve(EXT_ROOT, "syntaxes/tera.tmLanguage.json");

export type Scoped = { text: string; scopes: string[] };

let registry: textmate.Registry | null = null;

async function loadRegistry(): Promise<textmate.Registry> {
  if (registry) return registry;

  const wasm = await readFile(require.resolve("vscode-oniguruma/release/onig.wasm"));
  await oniguruma.loadWASM(wasm);

  registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (str) => new oniguruma.OnigString(str),
    }),
    loadGrammar: async (scopeName) => {
      if (scopeName !== "source.tera") return null;
      const raw = await readFile(GRAMMAR_PATH, "utf8");
      return textmate.parseRawGrammar(raw, GRAMMAR_PATH);
    },
  });
  return registry;
}

export async function tokenizeLine(line: string): Promise<Scoped[]> {
  const grammar = await (await loadRegistry()).loadGrammar("source.tera");
  if (!grammar) throw new Error("failed to load source.tera grammar");

  const result = grammar.tokenizeLine(line, textmate.INITIAL);
  return result.tokens
    .map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      scopes: token.scopes,
    }))
    .filter((token) => token.text.trim() !== "");
}

export async function scopesOf(line: string, text: string): Promise<string[]> {
  const tokens = await tokenizeLine(line);
  const found = tokens.find((token) => token.text === text);
  if (!found) {
    throw new Error(`token ${JSON.stringify(text)} not found in ${JSON.stringify(line)}; got ${tokens.map((t) => t.text).join("|")}`);
  }
  return found.scopes;
}

export async function scopeOf(line: string, text: string): Promise<string> {
  return (await scopesOf(line, text)).at(-1)!;
}
