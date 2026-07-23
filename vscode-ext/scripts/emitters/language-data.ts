import type {
  Builtin, KeywordGroup, LanguageData, Method, Operators, Param, PseudoTypeSource,
} from "../../src/shared/language-data.ts";

const SCALAR_KINDS = new Set(["constant"]);

export type BuiltinSource = {
  name: string;
  kind: string;
  description?: string | null;
  returns?: string | null;
  effect?: string;
  signature: { params: Param[] } | null;
  methods: Array<{
    name: string;
    description?: string | null;
    returns?: string | null;
    effect?: string;
    isGetter?: boolean;
    params: Param[];
  }>;
};

export function buildLanguageData(config: {
  keywords: string[];
  keywordGroups: Record<KeywordGroup, string[]>;
  types: string[];
  operators: Operators;
  builtins: BuiltinSource[];
  pseudoTypes: PseudoTypeSource;
}): LanguageData {
  return {
    version: 2,
    keywords: config.keywords,
    keywordGroups: config.keywordGroups,
    types: config.types,
    operators: config.operators,
    pseudoTypes: buildPseudoTypes(config.pseudoTypes),
    builtins: config.builtins.map(buildBuiltin),
  };
}

function buildBuiltin(source: BuiltinSource): Builtin {
  return {
    name: source.name,
    kind: source.kind,
    description: source.description ?? null,
    returns: source.returns ?? null,
    effect: source.effect ?? "sync",
    signature: source.signature
      ? {
          params: source.signature.params,
          display: formatDisplay(source.name, source.signature.params, source.kind, source.returns ?? null),
        }
      : null,
    methods: source.methods.map((method) => buildMethod(method, source.kind)),
  };
}

function buildMethod(
  source: {
    name: string;
    description?: string | null;
    returns?: string | null;
    effect?: string;
    isGetter?: boolean;
    params: Param[];
  },
  ownerKind: string,
): Method {
  const isGetter = source.isGetter ?? false;
  return {
    name: source.name,
    description: source.description ?? null,
    returns: source.returns ?? null,
    effect: source.effect ?? "sync",
    isGetter,
    signature: {
      params: source.params,
      display: isGetter
        ? source.name
        : formatDisplay(source.name, source.params, ownerKind, source.returns ?? null),
    },
  };
}

function buildPseudoTypes(source: PseudoTypeSource): Record<string, Method[]> {
  const out: Record<string, Method[]> = {};
  for (const [name, entry] of Object.entries(source)) {
    out[name] = entry.methods.map((method) => buildMethod(method, "method"));
  }
  return out;
}

function formatDisplay(name: string, params: Param[], kind: string, returns: string | null): string {
  if (!params.length && SCALAR_KINDS.has(kind)) return name;
  const rendered = params.map(formatParam).join(", ");
  const arrow = returns ? ` -> ${returns}` : "";
  return `${name}(${rendered})${arrow}`;
}

function formatParam(param: Param): string {
  const prefix = param.rest ? "..." : "";
  const typed = param.type ? `${param.name}: ${param.type}` : param.name;
  if (param.defaultValue !== null && param.defaultValue !== undefined) {
    return `${prefix}${typed}${param.type ? " = " : "="}${param.defaultValue}`;
  }
  if (param.optional && !param.rest) {
    return `${prefix}${param.name}?${param.type ? `: ${param.type}` : ""}`;
  }
  return `${prefix}${typed}`;
}
