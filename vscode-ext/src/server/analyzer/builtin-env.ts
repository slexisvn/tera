import type { LanguageData } from "../../shared/language-data.ts";

const EXCLUDED_KINDS = new Set(["step"]);

const MODULE_KINDS = new Set(["module", "sequential"]);

export type BuiltinEnv = {
  builtinNames: Set<string>;
  builtinTypes: Map<string, string>;
  methodReturns: Map<string, Map<string, string | null>>;
  moduleCalls: Map<string, string>;
};

export function buildBuiltinEnv(languageData: Partial<LanguageData>): BuiltinEnv {
  const builtinNames = new Set<string>();
  const builtinTypes = new Map<string, string>();
  const moduleCalls = new Map<string, string>();

  for (const builtin of languageData.builtins ?? []) {
    if (EXCLUDED_KINDS.has(builtin.kind)) continue;
    builtinNames.add(builtin.name);
    builtinTypes.set(builtin.name, builtin.returns ?? builtin.name);
    if (MODULE_KINDS.has(builtin.kind)) moduleCalls.set(builtin.name, builtin.name);
  }

  for (const keyword of languageData.keywords ?? []) builtinNames.add(keyword);
  for (const type of languageData.types ?? []) builtinNames.add(type);
  for (const name of Object.keys(languageData.pseudoTypes ?? {})) builtinNames.add(name);

  return {
    builtinNames,
    builtinTypes,
    moduleCalls,
    methodReturns: buildMethodReturns(languageData),
  };
}

function buildMethodReturns(languageData: Partial<LanguageData>): Map<string, Map<string, string | null>> {
  const out = new Map<string, Map<string, string | null>>();
  for (const [typeName, methods] of Object.entries(languageData.pseudoTypes ?? {})) {
    const entries = new Map<string, string | null>();
    for (const method of methods) entries.set(method.name, method.returns ?? null);
    out.set(typeName, entries);
  }
  return out;
}
