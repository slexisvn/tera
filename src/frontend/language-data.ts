export type KeywordGroup =
  | "declaration"
  | "control"
  | "operator"
  | "constant"
  | "variable";

export type Param = {
  name: string;
  type?: string | null;
  defaultValue?: string | null;
  optional?: boolean;
  rest?: boolean;
};

export type Signature = {
  params: Param[];
  display: string;
};

export type Method = {
  name: string;
  description: string | null;
  returns: string | null;
  effect: string;
  isGetter: boolean;
  signature: Signature;
};

export type Builtin = {
  name: string;
  kind: string;
  description: string | null;
  returns: string | null;
  effect: string;
  signature: Signature | null;
  methods: Method[];
};

export type Operators = {
  threeChar: string[];
  twoChar: string[];
  oneChar: string[];
};

export type LanguageData = {
  version: number;
  keywords: string[];
  keywordGroups: Record<KeywordGroup, string[]>;
  types: string[];
  operators: Operators;
  pseudoTypes: Record<string, Method[]>;
  globalNamespaces: Record<string, string>;
  builtins: Builtin[];
};

export type PseudoTypeSource = Record<
  string,
  {
    methods: Array<{
      name: string;
      description?: string;
      returns?: string;
      effect?: string;
      isGetter?: boolean;
      params: Param[];
    }>;
  }
>;

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

export type LanguageDataSource = {
  keywords: string[];
  keywordGroups: Record<KeywordGroup, string[]>;
  types: string[];
  operators: Operators;
  builtins: BuiltinSource[];
  pseudoTypes: PseudoTypeSource;
  globalNamespaces: Record<string, string>;
};

export type LanguageDataSpec = {
  keywordGroups: Record<string, string[]>;
  primitiveTypes: string[];
  operators: Operators;
  builtins: Record<string, BuiltinSpec | undefined>;
  chartMethods: Record<string, ChartMethodSpec | undefined>;
  kindMethods: Record<string, MethodSpec[] | undefined>;
  pseudoTypes: Record<string, { methods: MethodSpec[] }>;
  globalNamespaces: Record<string, string>;
};

type ParamSpec = {
  name: string;
  type?: string | null;
  defaultValue?: unknown;
  optional?: boolean;
  rest?: boolean;
};

type MethodSpec = {
  name: string;
  params: readonly ParamSpec[];
  returns?: string | null;
  effect?: string;
  isGetter?: boolean;
  description?: string | null;
};

type BuiltinSpec = {
  description?: string | null;
  kind?: string | null;
  returns?: string | null;
  effect?: string;
  params?: readonly ParamSpec[] | null;
  methods?: MethodSpec[];
};

type ChartMethodSpec = {
  display: string;
  description?: string | null;
  returns?: string | null;
  effect?: string;
  params?: readonly ParamSpec[];
};

const SCALAR_KINDS = new Set(["constant"]);
const CHART_NAMESPACE_DESCRIPTION =
  "Namespace of chart constructors for notebook visual outputs. Each call returns a "
  + "`ChartSpec` that the notebook renders; `data` accepts a `DataFrame`, a tensor, or plain arrays.";

export function collectLanguageDataSource(spec: LanguageDataSpec): LanguageDataSource {
  const keywordGroups = spec.keywordGroups as Record<KeywordGroup, string[]>;
  const pseudoTypes = toPseudoTypeSource(spec.pseudoTypes);
  return {
    keywords: collectKeywords(keywordGroups),
    keywordGroups,
    types: collectTypes(spec.primitiveTypes, pseudoTypes),
    operators: spec.operators,
    builtins: collectBuiltins(spec),
    pseudoTypes,
    globalNamespaces: spec.globalNamespaces,
  };
}

export function buildLanguageData(config: LanguageDataSource): LanguageData {
  return {
    version: 2,
    keywords: config.keywords,
    keywordGroups: config.keywordGroups,
    types: config.types,
    operators: config.operators,
    pseudoTypes: buildPseudoTypes(config.pseudoTypes),
    globalNamespaces: config.globalNamespaces,
    builtins: config.builtins.map(buildBuiltin),
  };
}

export function buildLanguageDataFromSpec(spec: LanguageDataSpec): LanguageData {
  return buildLanguageData(collectLanguageDataSource(spec));
}

function collectBuiltins(spec: LanguageDataSpec): BuiltinSource[] {
  const builtins = Object.entries(spec.builtins)
    .map(([name, builtin]) => toBuiltinSource(name, builtin!, spec.kindMethods));

  builtins.push({
    name: "chart",
    kind: "namespace",
    description: CHART_NAMESPACE_DESCRIPTION,
    returns: "chart",
    effect: "sync",
    signature: null,
    methods: Object.entries(spec.chartMethods).map(([name, doc]) => ({
      name,
      description: doc?.description ?? null,
      returns: doc?.returns ?? null,
      effect: doc?.effect ?? "sync",
      params: normalizeParams(doc?.params ?? parseParams(callArguments(doc?.display ?? ""))),
    })),
  });

  return builtins;
}

function toBuiltinSource(name: string, entry: BuiltinSpec, kindMethods: LanguageDataSpec["kindMethods"]): BuiltinSource {
  return {
    name,
    kind: entry.kind ?? "function",
    description: entry.description ?? null,
    returns: entry.returns ?? null,
    effect: entry.effect ?? "sync",
    signature: { params: normalizeParams(entry.params ?? []) },
    methods: mergeMethods(entry.kind ?? "function", entry.methods ?? [], kindMethods),
  };
}

function mergeMethods(kind: string, own: MethodSpec[], kindMethods: LanguageDataSpec["kindMethods"]): BuiltinSource["methods"] {
  const byName = new Map<string, BuiltinSource["methods"][number]>();

  for (const method of [...kindMethods[kind] ?? [], ...own]) {
    const documented = toMethodSource(method);
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

function toMethodSource(method: MethodSpec): BuiltinSource["methods"][number] {
  return {
    name: method.name,
    description: method.description,
    returns: method.returns,
    effect: method.effect ?? "sync",
    isGetter: method.isGetter,
    params: normalizeParams(method.params),
  };
}

function toPseudoTypeSource(pseudoTypes: LanguageDataSpec["pseudoTypes"]): PseudoTypeSource {
  const out: PseudoTypeSource = {};
  for (const [name, entry] of Object.entries(pseudoTypes)) {
    out[name] = {
      methods: entry.methods.map((method) => ({
        name: method.name,
        description: method.description ?? undefined,
        returns: method.returns ?? undefined,
        effect: method.effect,
        isGetter: method.isGetter,
        params: normalizeParams(method.params),
      })),
    };
  }
  return out;
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

function buildMethod(source: BuiltinSource["methods"][number], ownerKind: string): Method {
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

function collectTypes(primitiveTypes: string[], pseudoTypes: PseudoTypeSource): string[] {
  return [...new Set([...primitiveTypes, ...Object.keys(pseudoTypes)])].sort();
}

function collectKeywords(keywordGroups: Record<KeywordGroup, string[]>): string[] {
  return [...new Set(Object.values(keywordGroups).flat())].sort();
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

function callArguments(display: string): string {
  const open = display.indexOf("(");
  const close = display.lastIndexOf(")");
  return open < 0 || close < open ? "" : display.slice(open + 1, close);
}

function normalizeParams(params: readonly unknown[]): Param[] {
  return params.map((param) => {
    const item = param as Param;
    return {
      name: item.name,
      type: item.type ?? null,
      optional: !!item.optional,
      rest: !!item.rest,
      defaultValue: formatDefaultValue(item.defaultValue),
    };
  });
}

function formatDefaultValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return `[${value.map((item) => formatDefaultValue(item) ?? "null").join(", ")}]`;
  return String(value);
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
