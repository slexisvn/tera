import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGrammar } from "./emitters/grammar.ts";
import { buildLanguageData, type BuiltinSource } from "./emitters/language-data.ts";
import { buildSnippets } from "./emitters/snippets.ts";
import { extractBuiltinDocs, parseParams, type BuiltinDocs, type DocMethod } from "./extractors/builtin-docs.ts";
import { CHART_METHOD_DOCS } from "../../notebook/src/chart/docs.ts";
import { KEYWORD_GROUPS, OPERATORS, PRIMITIVE_TYPES, assertKeywordsInSync } from "./language-spec.ts";
import type { Param, PseudoTypeSource } from "../src/shared/language-data.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const ROOT = resolve(EXT_ROOT, "..");

const RUNTIME_BUNDLE = resolve(ROOT, "dist/index.node.js");
const DOCS = join(EXT_ROOT, "data/builtin-docs.md");

const OUTPUTS = {
  grammar: join(EXT_ROOT, "syntaxes/tera.tmLanguage.json"),
  languageData: join(EXT_ROOT, "language-data.json"),
  snippets: join(EXT_ROOT, "snippets/tera.json"),
};

const DOC_ONLY_KINDS = new Set(["step", "global"]);

const CHART_NAMESPACE_DESCRIPTION =
  "Namespace of chart constructors for notebook visual outputs. Each call returns a "
  + "`ChartSpec` that the notebook renders; `data` accepts a `DataFrame`, a tensor, or plain arrays.";

const DOCUMENTED_ELSEWHERE = new Set(["chart"]);

type RuntimeMetadataEntry = {
  name: string;
  returns?: string | null;
  kind?: string;
  effect?: string;
  params?: Param[];
};

type RuntimeModule = {
  KEYWORDS: Set<string>;
  DOMAIN_BUILTIN_METADATA: Record<string, RuntimeMetadataEntry>;
  CHART_METADATA: Record<string, RuntimeMetadataEntry>;
};

export async function generate(outputs = OUTPUTS) {
  const runtime = await loadRuntime();
  const docs = extractBuiltinDocs(DOCS);

  const keywords = assertKeywordsInSync(runtime.KEYWORDS);
  const runtimeBuiltins = collectRuntimeBuiltins(runtime);
  assertDocsInSync(runtimeBuiltins, docs);

  const builtins = mergeBuiltins(runtimeBuiltins, docs);
  const pseudoTypes = toPseudoTypeSource(docs);
  const types = collectTypes(pseudoTypes);

  const grammar = buildGrammar({ keywordGroups: KEYWORD_GROUPS, types, operators: OPERATORS, builtins: toGrammarBuiltins(builtins) });
  const languageData = buildLanguageData({ keywords, keywordGroups: KEYWORD_GROUPS, types, operators: OPERATORS, builtins, pseudoTypes });
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

async function loadRuntime(): Promise<RuntimeModule> {
  if (!existsSync(RUNTIME_BUNDLE)) {
    throw new Error(`Missing ${RUNTIME_BUNDLE}. Run "npm run build" at the repo root first.`);
  }
  return (await import(pathToFileURL(RUNTIME_BUNDLE).href)) as RuntimeModule;
}

function collectRuntimeBuiltins(runtime: RuntimeModule): BuiltinSource[] {
  const entries = [...Object.values(runtime.DOMAIN_BUILTIN_METADATA)];
  const builtins = entries.map(toBuiltinSource);

  builtins.push({
    name: "chart",
    kind: "namespace",
    description: CHART_NAMESPACE_DESCRIPTION,
    returns: "chart",
    effect: "sync",
    signature: null,
    methods: Object.values(runtime.CHART_METADATA).map((entry) => {
      const doc = CHART_METHOD_DOCS.get(entry.name);
      return {
        name: entry.name,
        description: doc?.description ?? null,
        returns: entry.returns ?? null,
        effect: entry.effect ?? "sync",
        params: doc ? parseParams(callArguments(doc.display)) : entry.params ?? [],
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

function toBuiltinSource(entry: RuntimeMetadataEntry): BuiltinSource {
  return {
    name: entry.name,
    kind: entry.kind ?? "function",
    description: null,
    returns: entry.returns ?? null,
    effect: entry.effect ?? "sync",
    signature: { params: entry.params ?? [] },
    methods: [],
  };
}

function assertDocsInSync(runtimeBuiltins: BuiltinSource[], docs: BuiltinDocs): void {
  const runtimeNames = new Set(runtimeBuiltins.map((builtin) => builtin.name));

  const undocumented = [...runtimeNames]
    .filter((name) => !docs.builtins.has(name) && !DOCUMENTED_ELSEWHERE.has(name))
    .sort();
  const phantom: string[] = [];
  const wrongKind: string[] = [];

  for (const [name, doc] of docs.builtins) {
    if (!runtimeNames.has(name)) {
      if (!doc.kind || !DOC_ONLY_KINDS.has(doc.kind)) phantom.push(name);
      continue;
    }
    const runtimeKind = runtimeBuiltins.find((builtin) => builtin.name === name)!.kind;
    if (doc.kind && doc.kind !== runtimeKind) wrongKind.push(`${name} (docs say {${doc.kind}}, runtime says {${runtimeKind}})`);
  }

  const problems = [
    undocumented.length ? `undocumented builtins — add a "## ${undocumented[0]}(...)" section to data/builtin-docs.md:\n    ${undocumented.join(", ")}` : "",
    phantom.length ? `documented but not defined by the runtime (remove them, or mark {step} if scope-local):\n    ${phantom.join(", ")}` : "",
    wrongKind.length ? `kind annotation disagrees with the runtime:\n    ${wrongKind.join("\n    ")}` : "",
  ].filter(Boolean);

  if (problems.length) {
    throw new Error(`data/builtin-docs.md is out of sync with src/runtime/domain:\n  ${problems.join("\n  ")}`);
  }
}

function mergeBuiltins(runtimeBuiltins: BuiltinSource[], docs: BuiltinDocs): BuiltinSource[] {
  const merged = runtimeBuiltins.map((builtin) => {
    const doc = docs.builtins.get(builtin.name);
    if (!doc) return builtin;

    return {
      ...builtin,
      description: doc.description,
      signature: doc.params ? { params: doc.params } : builtin.signature,
      methods: mergeMethods(builtin, doc.methods, docs.kindTemplates.get(builtin.kind) ?? []),
    };
  });

  for (const [name, doc] of docs.builtins) {
    if (merged.some((builtin) => builtin.name === name)) continue;
    merged.push({
      name,
      kind: doc.kind!,
      description: doc.description,
      returns: null,
      effect: "sync",
      signature: doc.params ? { params: doc.params } : null,
      methods: toMethodSources(doc.methods),
    });
  }

  return merged;
}

function mergeMethods(builtin: BuiltinSource, own: DocMethod[], template: DocMethod[]): BuiltinSource["methods"] {
  const byName = new Map<string, BuiltinSource["methods"][number]>();
  for (const method of builtin.methods) byName.set(method.name, method);

  for (const method of [...template, ...own]) {
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

function toMethodSources(methods: DocMethod[]): BuiltinSource["methods"] {
  return methods.map((method) => ({
    name: method.name,
    description: method.description,
    returns: method.returns,
    effect: "sync",
    isGetter: method.isGetter,
    params: method.params,
  }));
}

function toPseudoTypeSource(docs: BuiltinDocs): PseudoTypeSource {
  const out: PseudoTypeSource = {};
  for (const [name, methods] of docs.pseudoTypes) {
    out[name] = {
      methods: methods.map((method) => ({
        name: method.name,
        description: method.description ?? undefined,
        returns: method.returns ?? undefined,
        isGetter: method.isGetter,
        params: method.params,
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
  return [...new Set([...PRIMITIVE_TYPES, ...Object.keys(pseudoTypes)])].sort();
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
