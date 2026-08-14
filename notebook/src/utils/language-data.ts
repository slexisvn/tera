import { buildLanguageDataFromSpec } from "tera/frontend/language-data";
import {
  TERA_BUILTINS,
  TERA_CHART_METHODS,
  TERA_GLOBAL_NAMESPACES,
  TERA_KIND_METHODS,
  TERA_KEYWORD_GROUPS,
  TERA_OPERATORS,
  TERA_PRIMITIVE_TYPES,
  TERA_PSEUDO_TYPES,
} from "tera-data/tera-language-spec";

export const languageData = buildLanguageDataFromSpec({
  keywordGroups: TERA_KEYWORD_GROUPS,
  primitiveTypes: TERA_PRIMITIVE_TYPES,
  operators: TERA_OPERATORS,
  builtins: TERA_BUILTINS,
  chartMethods: TERA_CHART_METHODS,
  kindMethods: TERA_KIND_METHODS,
  pseudoTypes: TERA_PSEUDO_TYPES,
  globalNamespaces: TERA_GLOBAL_NAMESPACES,
});

export type { Builtin, LanguageData, Method } from "tera/frontend/language-data";
