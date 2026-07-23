import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TERA_BUILTINS,
  TERA_CHART_METHODS,
  TERA_KIND_METHODS,
  TERA_KEYWORD_GROUPS,
  TERA_OPERATORS,
  TERA_PRIMITIVE_TYPES,
  TERA_PSEUDO_TYPES,
  type TeraBuiltinSpec,
  type TeraChartMethodSpec,
  type TeraKeywordGroup,
  type TeraMethodSpec,
} from "../../data/tera-language-spec.ts";
import { buildGrammar } from "./emitters/grammar.ts";
import { buildLanguageData, type BuiltinSource } from "./emitters/language-data.ts";
import { buildSnippets } from "./emitters/snippets.ts";
import type { Param, PseudoTypeSource } from "../src/shared/language-data.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");

const OUTPUTS = {
  grammar: join(EXT_ROOT, "syntaxes/tera.tmLanguage.json"),
  languageData: join(EXT_ROOT, "language-data.json"),
  snippets: join(EXT_ROOT, "snippets/tera.json"),
};

const BUILTIN_SPECS = TERA_BUILTINS as Record<string, TeraBuiltinSpec | undefined>;
const KIND_METHOD_SPECS = TERA_KIND_METHODS as Record<string, TeraMethodSpec[] | undefined>;
const CHART_METHOD_SPECS = TERA_CHART_METHODS as Record<string, TeraChartMethodSpec | undefined>;
const KEYWORD_GROUPS = TERA_KEYWORD_GROUPS as Record<TeraKeywordGroup, string[]>;

const CHART_NAMESPACE_DESCRIPTION =
  "Namespace of chart constructors for notebook visual outputs. Each call returns a "
  + "`ChartSpec` that the notebook renders; `data` accepts a `DataFrame`, a tensor, or plain arrays.";

export async function generate(outputs = OUTPUTS) {
  const keywords = collectKeywords();
  const builtins = collectBuiltins();
  const pseudoTypes = toPseudoTypeSource();
  const types = collectTypes(pseudoTypes);

  const grammar = buildGrammar({ keywordGroups: KEYWORD_GROUPS, types, operators: TERA_OPERATORS, builtins: toGrammarBuiltins(builtins) });
  const languageData = buildLanguageData({ keywords, keywordGroups: KEYWORD_GROUPS, types, operators: TERA_OPERATORS, builtins, pseudoTypes });
  const snippets = buildSnippets({ builtins });

  writeJson(outputs.grammar, grammar);
  writeJson(outputs.languageData, languageData);
  writeJson(outputs.snippets, snippets);

  return {
    keywords,
    builtins,
    snippets: Object.keys(snippets),
    pseudoTypes: Object.keys(pseudoTypes),
    types,
    documented: builtins.filter((builtin) => builtin.description).length,
  };
}

function collectBuiltins(): BuiltinSource[] {
  const builtins = Object.entries(BUILTIN_SPECS)
    .map(([name, builtin]) => toBuiltinSource(name, builtin!));

  builtins.push({
    name: "chart",
    kind: "namespace",
    description: CHART_NAMESPACE_DESCRIPTION,
    returns: "chart",
    effect: "sync",
    signature: null,
    methods: Object.entries(CHART_METHOD_SPECS).map(([name, doc]) => {
      return {
        name,
        description: doc?.description ?? null,
        returns: doc?.returns ?? null,
        effect: doc?.effect ?? "sync",
        params: normalizeParams(doc?.params ?? parseParams(callArguments(doc?.display ?? ""))),
      };
    }),
  });

  return builtins;
}

function callArguments(display: string): string {
  const open = display.indexOf("(");
  const close = display.lastIndexOf(")");
  return open < 0 || close < open ? "" : display.slice(open + 1, close);
}

function toBuiltinSource(name: string, entry: TeraBuiltinSpec): BuiltinSource {
  return {
    name,
    kind: entry.kind ?? "function",
    description: entry.description ?? null,
    returns: entry.returns ?? null,
    effect: entry.effect ?? "sync",
    signature: { params: normalizeParams(entry.params ?? []) },
    methods: mergeMethods(entry.kind ?? "function", entry.methods ?? []),
  };
}

function mergeMethods(
  kind: string,
  own: SpecMethodInput[],
): BuiltinSource["methods"] {
  const byName = new Map<string, BuiltinSource["methods"][number]>();

  for (const method of [...KIND_METHOD_SPECS[kind] ?? [], ...own]) {
    const [documented] = toMethodSources([method]);
    const existing = byName.get(method.name);
    byName.set(method.name, existing
      ? {
          ...existing,
          description: documented.description ?? existing.description,
          returns: documented.returns ?? existing.returns,
          isGetter: documented.isGetter,
          params: documented.params.length ? documented.params : existing.params,
        }
      : documented);
  }

  return [...byName.values()];
}

function toMethodSources(methods: SpecMethodInput[]): BuiltinSource["methods"] {
  return methods.map((method) => ({
    name: method.name,
    description: method.description,
    returns: method.returns,
    effect: method.effect ?? "sync",
    isGetter: method.isGetter,
    params: normalizeParams(method.params),
  }));
}

function toPseudoTypeSource(): PseudoTypeSource {
  const out: PseudoTypeSource = {};
  for (const [name, entry] of Object.entries(TERA_PSEUDO_TYPES)) {
    out[name] = {
      methods: entry.methods.map((method) => ({
        name: method.name,
        description: method.description ?? undefined,
        returns: method.returns ?? undefined,
        isGetter: method.isGetter,
        params: normalizeParams(method.params),
      })),
    };
  }
  return out;
}

function toGrammarBuiltins(builtins: BuiltinSource[]) {
  return builtins.map((builtin) => ({
    name: builtin.name,
    kind: builtin.kind,
    description: null,
    returns: builtin.returns ?? null,
    effect: builtin.effect ?? "sync",
    signature: null,
    methods: [],
  }));
}

function collectTypes(pseudoTypes: PseudoTypeSource): string[] {
  return [...new Set([...TERA_PRIMITIVE_TYPES, ...Object.keys(pseudoTypes)])].sort();
}

function collectKeywords(): string[] {
  return [...new Set(Object.values(KEYWORD_GROUPS).flat())].sort();
}

type SpecMethodInput = {
  name: string;
  params: readonly unknown[];
  returns?: string | null;
  effect?: string;
  isGetter?: boolean;
  description?: string | null;
};

function normalizeParams(params: readonly unknown[]): Param[] {
  return params.map((param) => {
    const item = param as Param;
    return {
      name: item.name,
      type: item.type ?? null,
      optional: !!item.optional,
      rest: !!item.rest,
      defaultValue: item.defaultValue === undefined || item.defaultValue === null ? null : String(item.defaultValue),
    };
  });
}

export function parseParams(text: string): Param[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return splitTopLevel(trimmed).map((part) => part.trim()).filter(Boolean).map(parseParam);
}

function parseParam(text: string): Param {
  if (text.startsWith("...")) {
    const { name, type } = splitType(text.slice(3));
    return { name, type, optional: true, rest: true, defaultValue: null };
  }

  const equals = findTopLevelEquals(text);
  if (equals < 0) {
    const { name, type } = splitType(text);
    const optional = name.endsWith("?");
    return { name: optional ? name.slice(0, -1).trim() : name, type, optional, rest: false, defaultValue: null };
  }

  const { name, type } = splitType(text.slice(0, equals));
  return { name, type, optional: true, rest: false, defaultValue: text.slice(equals + 1).trim() };
}

function splitType(text: string): { name: string; type: string | null } {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return { name: trimmed, type: null };
  return { name: trimmed.slice(0, colon).trim(), type: trimmed.slice(colon + 1).trim() };
}

function findTopLevelEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "[" || char === "{" || char === "(") depth++;
    else if (char === "]" || char === "}" || char === ")") depth--;
    else if (char === "=" && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buffer = "";

  for (const char of text) {
    if (char === "[" || char === "{" || char === "(") depth++;
    else if (char === "]" || char === "}" || char === ")") depth--;

    if (char === "," && depth === 0) {
      out.push(buffer);
      buffer = "";
    } else {
      buffer += char;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await generate();
  console.log(
    `Generated ${result.keywords.length} keywords, ${result.builtins.length} builtins ` +
    `(${result.documented} documented), ${result.snippets.length} snippets, ` +
    `${result.pseudoTypes.length} pseudo-types.`,
  );
}
