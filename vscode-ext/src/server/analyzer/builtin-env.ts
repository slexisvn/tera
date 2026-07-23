import type { LanguageData } from "../../shared/language-data.ts";

export type BuiltinEnv = {
  keywords: Set<string>;
};

export function buildBuiltinEnv(languageData: Partial<LanguageData>): BuiltinEnv {
  return { keywords: new Set(languageData.keywords ?? []) };
}
