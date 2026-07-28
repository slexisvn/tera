import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLanguageData, collectLanguageDataSource } from "../../src/frontend/language-data.ts";
import {
  TERA_BUILTINS,
  TERA_CHART_METHODS,
  TERA_GLOBAL_NAMESPACES,
  TERA_KIND_METHODS,
  TERA_KEYWORD_GROUPS,
  TERA_OPERATORS,
  TERA_PRIMITIVE_TYPES,
  TERA_PSEUDO_TYPES,
} from "../../data/tera-language-spec.ts";
import { buildGrammar } from "./emitters/grammar.ts";
import { buildSnippets } from "./emitters/snippets.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");

const OUTPUTS = {
  grammar: join(EXT_ROOT, "syntaxes/tera.tmLanguage.json"),
  languageData: join(EXT_ROOT, "language-data.json"),
  snippets: join(EXT_ROOT, "snippets/tera.json"),
};

export async function generate(outputs = OUTPUTS) {
  const source = collectLanguageDataSource({
    keywordGroups: TERA_KEYWORD_GROUPS,
    primitiveTypes: TERA_PRIMITIVE_TYPES,
    operators: TERA_OPERATORS,
    builtins: TERA_BUILTINS,
    chartMethods: TERA_CHART_METHODS,
    kindMethods: TERA_KIND_METHODS,
    pseudoTypes: TERA_PSEUDO_TYPES,
    globalNamespaces: TERA_GLOBAL_NAMESPACES,
  });
  const languageData = buildLanguageData(source);

  const grammar = buildGrammar({ keywordGroups: source.keywordGroups, types: source.types, operators: source.operators, builtins: languageData.builtins });
  const snippets = buildSnippets({ builtins: source.builtins });

  writeJson(outputs.grammar, grammar);
  writeJson(outputs.languageData, languageData);
  writeJson(outputs.snippets, snippets);

  return {
    keywords: source.keywords,
    builtins: source.builtins,
    snippets: Object.keys(snippets),
    pseudoTypes: Object.keys(source.pseudoTypes),
    types: source.types,
    documented: source.builtins.filter((builtin) => builtin.description).length,
  };
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
