import {
  buildLanguageDataFromSpec,
  type Builtin,
  type KeywordGroup,
  type LanguageData,
  type Method,
} from "../../frontend/index.js";
import {
  TERA_BUILTINS,
  TERA_CHART_METHODS,
  TERA_GLOBAL_NAMESPACES,
  TERA_KEYWORD_GROUPS,
  TERA_KIND_METHODS,
  TERA_OPERATORS,
  TERA_PRIMITIVE_TYPES,
  TERA_PSEUDO_TYPES,
} from "../../../data/tera-language-spec.js";

export type Language = {
  data: LanguageData;
  keywords: ReadonlySet<string>;
  keywordGroup: ReadonlyMap<string, KeywordGroup>;
  types: ReadonlySet<string>;
  builtins: ReadonlyMap<string, Builtin>;
  pseudoMethods: readonly Method[];
  chartMethods: readonly Method[];
  globalNamespaces: Record<string, string>;
  describe(name: string): string | null;
  signatureOf(name: string): string | null;
};

function indexBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

function groupOfKeyword(data: LanguageData): Map<string, KeywordGroup> {
  const map = new Map<string, KeywordGroup>();
  for (const [group, names] of Object.entries(data.keywordGroups)) {
    for (const name of names) map.set(name, group as KeywordGroup);
  }
  return map;
}

function dedupeMethods(methods: readonly Method[]): Method[] {
  return [...indexBy(methods, (method) => method.name).values()];
}

export function createLanguage(): Language {
  const data = buildLanguageDataFromSpec({
    keywordGroups: TERA_KEYWORD_GROUPS,
    primitiveTypes: TERA_PRIMITIVE_TYPES,
    operators: TERA_OPERATORS,
    builtins: TERA_BUILTINS,
    chartMethods: TERA_CHART_METHODS,
    kindMethods: TERA_KIND_METHODS,
    pseudoTypes: TERA_PSEUDO_TYPES,
    globalNamespaces: TERA_GLOBAL_NAMESPACES,
  });

  const builtins = indexBy(data.builtins, (builtin) => builtin.name);
  const pseudoMethods = dedupeMethods(Object.values(data.pseudoTypes).flat());
  const chartMethods = builtins.get("chart")?.methods ?? [];
  const methodByName = indexBy(
    [...pseudoMethods, ...chartMethods],
    (method) => method.name,
  );

  return {
    data,
    keywords: new Set(data.keywords),
    keywordGroup: groupOfKeyword(data),
    types: new Set(data.types),
    builtins,
    pseudoMethods,
    chartMethods,
    globalNamespaces: data.globalNamespaces,
    describe(name) {
      return builtins.get(name)?.description ?? methodByName.get(name)?.description ?? null;
    },
    signatureOf(name) {
      const builtin = builtins.get(name);
      if (builtin?.signature) return builtin.signature.display;
      const method = methodByName.get(name);
      return method?.signature.display ?? null;
    },
  };
}
