import {
  TERA_BUILTIN_ALIASES,
  TERA_BUILTIN_INTERFACES,
  TERA_BUILTINS,
  TERA_CHART_METHODS,
  TERA_GLOBAL_NAMESPACES,
  TERA_KIND_METHODS,
  TERA_PRIMITIVE_PSEUDO_TYPES,
  TERA_PRIMITIVE_TYPES,
  TERA_PSEUDO_TYPES,
  type TeraInterfaceSpec,
  type TeraBuiltinSpec,
  type TeraChartMethodSpec,
  type TeraMethodSpec,
  type TeraParam,
  type TeraPseudoTypeSpec,
  type TeraTypeAliasSpec,
} from "../../../data/tera-language-spec.js";
import type { ClassVisibility } from "../../core/class-visibility.js";

export type TypeName = string;

export type Binding = {
  type: TypeName;
  optional: boolean;
  declared?: boolean;
  visibility?: ClassVisibility;
  owner?: string;
  abstract?: boolean;
};

export type ObjectShape = {
  typeParams?: string[];
  fields: Map<string, Binding>;
  indexers?: IndexSignature[];
};

export type IndexSignature = {
  keyType: TypeName;
  valueType: TypeName;
};

export type TypeAlias = {
  typeParams: string[];
  type: TypeName;
};

export type RestParameter = Binding & {
  name: string;
  named: boolean;
};

export type Signature = {
  name: string;
  typeParams: string[];
  params: Map<string, Binding>;
  required: Set<string>;
  positional: string[];
  returns: TypeName;
  rest?: RestParameter;
  visibility?: ClassVisibility;
  owner?: string;
  abstract?: boolean;
};

export type TypeEnv = {
  aliases: Map<string, TypeAlias>;
  interfaces: Map<string, ObjectShape>;
  nominalFamilies: Map<string, TypeName>;
  modelForwards: Map<string, Signature>;
  abstractClasses: Set<string>;
};

export type MemberType = {
  returns: TypeName;
  getter: boolean;
  signature: Signature;
};

const BOOLEAN_ALIASES = new Map<TypeName, TypeName>([["boolean", "bool"]]);
const NUMERIC_RANK = new Map<TypeName, number>([["int", 0], ["float", 1]]);
const PSEUDO_TYPE_SPECS = TERA_PSEUDO_TYPES as Record<string, TeraPseudoTypeSpec | undefined>;
const BUILTIN_TYPE_SPECS = TERA_BUILTINS as Record<string, TeraBuiltinSpec | undefined>;
const KIND_METHOD_SPECS = TERA_KIND_METHODS as Record<string, TeraMethodSpec[] | undefined>;
const BUILTIN_ALIAS_SPECS = TERA_BUILTIN_ALIASES as Record<string, TeraTypeAliasSpec | undefined>;
const BUILTIN_INTERFACE_SPECS = TERA_BUILTIN_INTERFACES as Record<string, TeraInterfaceSpec | undefined>;
const METHOD_SPECS = new Map<string, Map<string, TeraMethodSpec>>();
const METHOD_OWNER_NAMES = new Map<string, string>();
const PRIMITIVE_METHOD_OWNER_NAMES = new Map<string, string>(Object.entries(TERA_PRIMITIVE_PSEUDO_TYPES));
const PSEUDO_TYPE_PARAMS = new Map<string, string[]>();
const CALL_SIGNATURES = new Map<string, Signature>();
const KIND_FAMILIES = new Map<string, TypeName>([
  ["module", "Module"],
  ["optimizer", "Optimizer"],
  ["scheduler", "LRScheduler"],
  ["metric", "Metric"],
  ["ml_model", "MLModel"],
  ["ml_transform", "MLTransform"],
  ["metric_collection", "MetricCollection"],
  ["callback", "Callback"],
  ["logger", "Logger"],
  ["trainer", "Trainer"],
]);
const BUILTIN_FAMILIES = new Map<string, TypeName>([
  ["IndexTensor", "Tensor"],
]);

export const BUILTIN_SIGNATURES = new Map<string, Signature>();

export const GLOBAL_NAMESPACE_BINDINGS = new Map<string, TypeName>(Object.entries(TERA_GLOBAL_NAMESPACES));
if (Object.keys(TERA_CHART_METHODS).length) GLOBAL_NAMESPACE_BINDINGS.set("chart", "chart");

function registerMethodOwner(name: string): void {
  METHOD_OWNER_NAMES.set(name, name);
  METHOD_OWNER_NAMES.set(name.toLowerCase(), name);
}

function registerMethods(owner: string, methods: TeraMethodSpec[] | undefined): void {
  if (!methods?.length) return;
  registerMethodOwner(owner);
  const entries = METHOD_SPECS.get(owner) ?? new Map<string, TeraMethodSpec>();
  for (const method of methods) entries.set(method.name, method);
  METHOD_SPECS.set(owner, entries);
}

for (const [owner, spec] of Object.entries(PSEUDO_TYPE_SPECS)) {
  if (spec?.typeParams?.length) PSEUDO_TYPE_PARAMS.set(owner, spec.typeParams);
  registerMethods(owner, spec?.methods);
}
for (const [kind, methods] of Object.entries(KIND_METHOD_SPECS)) {
  const family = KIND_FAMILIES.get(kind);
  if (family) registerMethods(family, methods);
}

export function cleanType(type: string | undefined | null): TypeName {
  if (!type) return "any";
  const trimmed = type.trim();
  if (!trimmed) return "any";
  const canonical = BOOLEAN_ALIASES.get(trimmed) ?? trimmed;
  const normalized = canonical
    .replace(/\bboolean\b/g, "bool")
    .replace(/\bArray\s*<\s*([^>]+)\s*>/g, "$1[]")
    .replace(/\s*\[\s*\]/g, "[]")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/\{\s+/g, "{")
    .replace(/\s+\}/g, "}")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ");
  const fn = parseFunctionTypeSource(normalized);
  if (!fn) return normalized;
  const params = splitTopLevel(fn.params, ",").map((param) => param.trim()).filter(Boolean).map((param) => cleanType(param)).join(", ");
  return `(${params}) -> ${cleanType(fn.returns)}`;
}

function parseFunctionTypeSource(source: string): { params: string; returns: string } | null {
  const text = source.trim();
  const fnPrefix = text.startsWith("fn") && (text.length === 2 || text[2] === "(" || /\s/.test(text[2]));
  const open = fnPrefix ? firstNonSpace(text, 2) : 0;
  if (fnPrefix && text[open] !== "(") return null;
  if (!fnPrefix && text[0] !== "(") return null;
  const close = matchingParen(text, open);
  if (close < 0) return null;
  const arrow = firstNonSpace(text, close + 1);
  if (text.slice(arrow, arrow + 2) !== "->") return null;
  const returns = text.slice(arrow + 2).trim();
  return returns ? { params: text.slice(open + 1, close), returns } : null;
}

function firstNonSpace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index++;
  return index;
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function splitTopLevel(source: string, separator: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === separator) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

export function parseTypeParams(source: string | undefined): string[] {
  if (!source) return [];
  return splitTopLevel(source, ",").map((part) => part.trim().replace(/\s+extends\s+.+$/, "")).filter(Boolean);
}

export function signature(name: string, params: Array<[string, TypeName, boolean?]>, returns: TypeName): Signature {
  const paramMap = new Map<string, Binding>();
  const required = new Set<string>();
  const positional: string[] = [];
  for (const [paramName, type, optional] of params) {
    paramMap.set(paramName, { type: cleanType(type), optional: !!optional });
    positional.push(paramName);
    if (!optional) required.add(paramName);
  }
  return { name, typeParams: [], params: paramMap, required, positional, returns: cleanType(returns) };
}

function paramBinding(param: TeraParam): Binding {
  return {
    type: cleanType(param.type ?? "any"),
    optional: !!param.optional || (param.defaultValue !== undefined && param.defaultValue !== null) || !!param.rest,
  };
}

function signatureFromSpec(
  name: string,
  params: TeraParam[] | null | undefined,
  returns: string | null | undefined,
  typeParams: string[] = [],
): Signature {
  const paramMap = new Map<string, Binding>();
  const required = new Set<string>();
  const positional: string[] = [];
  let rest: RestParameter | undefined;
  for (const param of params ?? []) {
    const binding = paramBinding(param);
    if (param.rest) {
      rest = { ...binding, name: param.name, named: !!param.named };
      continue;
    }
    paramMap.set(param.name, binding);
    if (!param.named) positional.push(param.name);
    if (!binding.optional) required.add(param.name);
  }
  const out: Signature = {
    name,
    typeParams,
    params: paramMap,
    required,
    positional,
    returns: cleanType(returns ?? "undefined"),
  };
  if (rest) out.rest = rest;
  return out;
}

function builtinReturnType(name: string, spec: TeraBuiltinSpec): TypeName {
  const kindMethods = spec.kind ? KIND_METHOD_SPECS[spec.kind] : undefined;
  return kindMethods?.length && cleanType(spec.returns ?? undefined) === "Object"
    ? name
    : cleanType(spec.returns ?? "undefined");
}

function signatureFromBuiltin(name: string, spec: TeraBuiltinSpec): Signature {
  return signatureFromSpec(name, spec.params, builtinReturnType(name, spec), spec.typeParams ?? []);
}

function signatureFromChart(name: string, spec: TeraChartMethodSpec): Signature {
  return signatureFromSpec(name, spec.params, spec.returns);
}

function signatureFromMethod(owner: string, method: TeraMethodSpec): Signature {
  return signatureFromSpec(`${owner}.${method.name}`, method.params, method.returns ?? "any", method.typeParams ?? []);
}

for (const [name, rawSpec] of Object.entries(TERA_BUILTINS)) {
  const spec = rawSpec as TeraBuiltinSpec;
  const family = spec.kind ? KIND_FAMILIES.get(spec.kind) : undefined;
  if (family) BUILTIN_FAMILIES.set(name, family);
  if (name === "Sequential") BUILTIN_FAMILIES.set(name, "Module");
  if (name !== "Dataset" && name.endsWith("Dataset")) BUILTIN_FAMILIES.set(name, "Dataset");
  if (spec.kind) registerMethods(name, KIND_METHOD_SPECS[spec.kind]);
  registerMethods(name, spec.methods);
  BUILTIN_SIGNATURES.set(name, signatureFromBuiltin(name, spec));
}
for (const [name, spec] of Object.entries(TERA_CHART_METHODS)) {
  BUILTIN_SIGNATURES.set(`chart.${name}`, signatureFromChart(`chart.${name}`, spec));
}
for (const type of TERA_PRIMITIVE_TYPES) {
  if (/^[A-Z]/.test(type) && !BUILTIN_SIGNATURES.has(type)) {
    BUILTIN_SIGNATURES.set(type, signature(type, [], type));
  }
}

export function createTypeEnv(): TypeEnv {
  const aliases = new Map<string, TypeAlias>();
  for (const [name, spec] of Object.entries(BUILTIN_ALIAS_SPECS)) {
    if (spec) aliases.set(name, { typeParams: spec.typeParams ?? [], type: cleanType(spec.type) });
  }
  const interfaces = new Map<string, ObjectShape>();
  for (const [name, spec] of Object.entries(BUILTIN_INTERFACE_SPECS)) {
    if (!spec) continue;
    const fields = new Map<string, Binding>();
    for (const [fieldName, field] of Object.entries(spec.fields)) {
      fields.set(fieldName, { type: cleanType(field.type), optional: !!field.optional });
    }
    const indexers = spec.indexers?.map((indexer) => ({
      keyType: cleanType(indexer.keyType),
      valueType: cleanType(indexer.valueType),
    }));
    interfaces.set(name, { typeParams: spec.typeParams, fields, indexers });
  }
  return { aliases, interfaces, nominalFamilies: new Map(), modelForwards: new Map(), abstractClasses: new Set() };
}

export function substituteType(type: TypeName, substitutions: Map<string, TypeName>): TypeName {
  let next = String(type);
  for (const [name, value] of substitutions) {
    next = next.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return cleanType(next);
}

export function instantiateSignature(sig: Signature, substitutions: Map<string, TypeName>): Signature {
  if (substitutions.size === 0) return sig;
  const params = new Map<string, Binding>();
  for (const [name, binding] of sig.params) {
    params.set(name, { ...binding, type: substituteType(binding.type, substitutions) });
  }
  const rest = sig.rest ? { ...sig.rest, type: substituteType(sig.rest.type, substitutions) } : undefined;
  return { ...sig, params, rest, returns: substituteType(sig.returns, substitutions) };
}

export function resolveType(type: TypeName, env: TypeEnv, seen = new Set<string>()): TypeName {
  const name = cleanType(type);
  if (seen.has(name)) return name;
  const generic = name.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
  if (generic) {
    const alias = env.aliases.get(generic[1]);
    if (alias) {
      seen.add(name);
      const args = splitTopLevel(generic[2], ",").map((arg) => cleanType(arg));
      const substitutions = new Map<string, TypeName>();
      for (let i = 0; i < args.length && i < alias.typeParams.length; i++) substitutions.set(alias.typeParams[i], args[i]);
      return resolveType(substituteType(alias.type, substitutions), env, seen);
    }
  }
  const alias = env.aliases.get(name);
  if (!alias) return name;
  seen.add(name);
  return resolveType(alias.type, env, seen);
}

export function parseFunctionType(type: TypeName): Signature | null {
  const source = cleanType(type);
  const fn = parseFunctionTypeSource(source);
  if (!fn) return null;
  const params = new Map<string, Binding>();
  const positional: string[] = [];
  const required = new Set<string>();
  const rawParams = splitTopLevel(fn.params, ",").map((part) => part.trim()).filter(Boolean);
  for (let i = 0; i < rawParams.length; i++) {
    const parsed = parseFunctionParam(rawParams[i], i);
    const name = parsed.name;
    params.set(name, { type: parsed.type, optional: false });
    positional.push(name);
    required.add(name);
  }
  return { name: "<function>", typeParams: [], params, positional, required, returns: cleanType(fn.returns) };
}

function parseFunctionParam(source: string, index: number): { name: string; type: TypeName } {
  const colon = topLevelColon(source);
  if (colon > 0) {
    const name = source.slice(0, colon).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      return { name, type: cleanType(source.slice(colon + 1)) };
    }
  }
  return { name: `arg${index}`, type: cleanType(source) };
}

function topLevelColon(source: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

export function signatureType(sig: Signature): TypeName {
  return `(${sig.positional.map((name) => sig.params.get(name)?.type ?? "any").join(", ")}) -> ${sig.returns}`;
}

export function unionParts(type: TypeName, env: TypeEnv): TypeName[] {
  const resolved = resolveType(type, env);
  return String(resolved).includes("|")
    ? splitTopLevel(String(resolved), "|").map((part) => cleanType(part))
    : [resolved];
}

export function unionType(parts: TypeName[]): TypeName {
  const out: TypeName[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    for (const part of splitTopLevel(String(raw), "|").map((item) => cleanType(item))) {
      if (!part) continue;
      const key = String(part);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(part);
      }
    }
  }
  return out.length === 0 ? "never" : out.length === 1 ? out[0] : out.join(" | ");
}

export function leastUpperBound(types: TypeName[], env: TypeEnv): TypeName | null {
  const items = types.map((type) => cleanType(type)).filter(Boolean);
  if (!items.length) return null;
  let current = items[0];
  for (let i = 1; i < items.length; i++) {
    const next = items[i];
    if (assignable(next, current, env, new Map())) continue;
    if (assignable(current, next, env, new Map())) {
      current = next;
      continue;
    }
    const nominal = commonNominalAncestor(current, next, env);
    if (nominal) {
      current = nominal;
      continue;
    }
    return null;
  }
  return current;
}

export function removeNullish(type: TypeName, env: TypeEnv): TypeName {
  return unionType(unionParts(type, env).filter((part) => part !== "null" && part !== "undefined"));
}

export function isTupleType(type: TypeName): boolean {
  const source = cleanType(type);
  return source.startsWith("[") && source.endsWith("]");
}

export function tupleTypes(type: TypeName): TypeName[] {
  const source = cleanType(type);
  if (!isTupleType(source)) return [];
  return splitTopLevel(source.slice(1, -1), ",").map((part) => cleanType(part));
}

export function arrayElementType(type: TypeName): TypeName | null {
  const source = cleanType(type);
  if (!source.endsWith("[]")) return null;
  return cleanType(source.slice(0, -2));
}

export function indexedAccessType(type: TypeName, keyType: TypeName | null, literal: string | number | null, slice: boolean, env: TypeEnv): TypeName {
  const parts = unionParts(type, env);
  if (parts.length > 1) return unionType(parts.map((part) => indexedAccessType(part, keyType, literal, slice, env)));
  const resolved = resolveType(type, env);
  if (resolved === "any" || resolved === "unknown") return resolved;
  if (resolved === "Array") return slice ? "Array" : "any";
  const element = arrayElementType(resolved);
  if (element) return slice ? `${element}[]` : element;
  if (isTupleType(resolved)) return tupleAccessType(tupleTypes(resolved), literal, slice, env);
  if (methodOwnerName(resolved) === "String") return "string";
  if (resolved === "Tensor") return "Tensor";
  const shape = instantiateShapeForType(resolved, env);
  if (shape) {
    if (typeof literal === "string") {
      const field = shape.fields.get(literal);
      if (field) return field.optional ? unionType([field.type, "undefined"]) : field.type;
    }
    const indexer = shapeIndexFor(shape, keyType, env);
    if (indexer) return indexer.valueType;
    if (keyType === "string") return unionType([...shape.fields.values()].map((field) => field.type));
  }
  return "unknown";
}

export function isIndexableType(type: TypeName, env: TypeEnv): boolean {
  return unionParts(type, env).every((part) => {
    const resolved = resolveType(part, env);
    return resolved === "any" ||
      resolved === "unknown" ||
      resolved === "Array" ||
      resolved === "Tensor" ||
      !!arrayElementType(resolved) ||
      isTupleType(resolved) ||
      methodOwnerName(resolved) === "String" ||
      instantiateShapeForType(resolved, env) !== null;
  });
}

export function indexKeyAssignable(container: TypeName, key: TypeName, env: TypeEnv): boolean {
  if (key === "any" || key === "unknown") return true;
  return unionParts(container, env).every((part) => {
    const resolved = resolveType(part, env);
    if (resolved === "any" || resolved === "unknown") return true;
    return compatible(key, indexKeyTypeForPart(part, env), env);
  });
}

export function indexKeyType(container: TypeName, env: TypeEnv): TypeName {
  return unionType(unionParts(container, env).map((part) => indexKeyTypeForPart(part, env)));
}

function indexKeyTypeForPart(type: TypeName, env: TypeEnv): TypeName {
  const resolved = resolveType(type, env);
  const shape = instantiateShapeForType(resolved, env);
  if (shape && !arrayElementType(resolved) && !isTupleType(resolved) && methodOwnerName(resolved) !== "String" && resolved !== "Array" && resolved !== "Tensor") {
    if (shape.indexers?.length) return unionType(shape.indexers.map((indexer) => indexer.keyType));
    return "string";
  }
  return "int";
}

function tupleAccessType(items: TypeName[], literal: string | number | null, slice: boolean, env: TypeEnv): TypeName {
  if (!items.length) return slice ? "unknown[]" : "unknown";
  if (!slice && typeof literal === "number" && Number.isInteger(literal)) {
    const index = literal < 0 ? items.length + literal : literal;
    return items[index] ?? unionType(items);
  }
  if (!slice) return unionType(items);
  const common = leastUpperBound(items, env);
  return common ? `${common}[]` : "Array";
}

export function iterableBindingType(type: TypeName, mode: "in" | "of", env: TypeEnv): TypeName {
  const parts = unionParts(type, env);
  if (parts.length > 1) return unionType(parts.map((part) => iterableBindingType(part, mode, env)));
  const resolved = resolveType(type, env);
  if (resolved === "any") return "any";
  if (resolved === "unknown") return "unknown";
  if (mode === "in") {
    if (resolved === "Object" || instantiateShapeForType(resolved, env)) return "string";
    if (resolved === "Array" || arrayElementType(resolved) || isTupleType(resolved) || methodOwnerName(resolved) === "String") return "int";
    return "unknown";
  }
  if (methodOwnerName(resolved) === "String") return "string";
  const element = arrayElementType(resolved);
  if (element) return element;
  if (isTupleType(resolved)) return unionType(tupleTypes(resolved));
  if (resolved === "Array") return "any";
  return iteratorElementType(resolved, env) ?? "unknown";
}

function iteratorElementType(type: TypeName, env: TypeEnv): TypeName | null {
  const shape = instantiateShapeForType(type, env);
  const next = shape?.fields.get("next");
  if (!next) return null;
  const sig = parseFunctionType(next.type);
  if (!sig) return null;
  const result = instantiateShapeForType(sig.returns, env);
  const value = result?.fields.get("value")?.type;
  return value ? removeNullish(value, env) : null;
}

export function baseTypeName(type: TypeName): string {
  const generic = cleanType(type).match(/^([A-Za-z_$][\w$]*)\s*</);
  return generic ? generic[1] : cleanType(type);
}

function methodOwnerName(type: TypeName, env?: TypeEnv): string {
  const resolved = cleanType(type);
  const owner = arrayElementType(resolved) || isTupleType(resolved)
    ? "Array"
    : baseTypeName(resolved);
  const lookupOwner = PRIMITIVE_METHOD_OWNER_NAMES.get(owner) ?? PRIMITIVE_METHOD_OWNER_NAMES.get(owner.toLowerCase()) ?? owner;
  const direct = METHOD_OWNER_NAMES.get(lookupOwner) ?? METHOD_OWNER_NAMES.get(lookupOwner.toLowerCase());
  if (direct) return direct;
  const family = env ? nominalFamily(lookupOwner, env) : BUILTIN_FAMILIES.get(lookupOwner);
  return family ? METHOD_OWNER_NAMES.get(family) ?? family : owner;
}

function lookupMethod(owner: string, name: string, env?: TypeEnv, seen = new Set<string>()): { owner: string; method: TeraMethodSpec } | null {
  const canonicalOwner = METHOD_OWNER_NAMES.get(owner) ?? METHOD_OWNER_NAMES.get(owner.toLowerCase()) ?? owner;
  if (seen.has(canonicalOwner)) return null;
  seen.add(canonicalOwner);
  const method = METHOD_SPECS.get(canonicalOwner)?.get(name);
  if (method) return { owner: canonicalOwner, method };
  const family = env ? nominalFamily(canonicalOwner, env) : BUILTIN_FAMILIES.get(canonicalOwner);
  if (!family) return null;
  const familyOwner = METHOD_OWNER_NAMES.get(family) ?? METHOD_OWNER_NAMES.get(family.toLowerCase()) ?? family;
  return lookupMethod(familyOwner, name, env, seen);
}

export function builtinMethod(type: TypeName, name: string, env?: TypeEnv): MemberType | null {
  const base = env ? baseTypeName(resolveType(type, env)) : baseTypeName(type);
  const forward = env?.modelForwards.get(base);
  if (name === "forward" && forward) return { returns: forward.returns, getter: false, signature: forward };
  const owner = methodOwnerName(type, env);
  const match = lookupMethod(owner, name, env);
  if (!match) return null;
  const sig = instantiateReceiverSignature(type, match.owner, signatureFromMethod(match.owner, match.method), env);
  const returns = sig.returns === "this" ? base : sig.returns;
  const signature = returns === sig.returns ? sig : { ...sig, returns };
  return { returns, getter: !!match.method.isGetter, signature };
}

function instantiateReceiverSignature(type: TypeName, owner: string, sig: Signature, env?: TypeEnv): Signature {
  const typeParams = PSEUDO_TYPE_PARAMS.get(owner);
  if (!typeParams?.length) return sig;
  const args = genericArgsForOwner(type, owner, env);
  const substitutions = new Map<string, TypeName>();
  for (let i = 0; i < typeParams.length; i++) substitutions.set(typeParams[i], args[i] ?? "any");
  return instantiateSignature(sig, substitutions);
}

function genericArgsForOwner(type: TypeName, owner: string, env?: TypeEnv): TypeName[] {
  const resolved = env ? resolveType(type, env) : cleanType(type);
  const resolvedGeneric = parseGenericType(resolved);
  if (resolvedGeneric?.name === owner) return resolvedGeneric.args;
  const directGeneric = parseGenericType(type);
  return directGeneric?.name === owner ? directGeneric.args : [];
}

function parseGenericType(type: TypeName): { name: string; args: TypeName[] } | null {
  const source = cleanType(type);
  const open = source.indexOf("<");
  if (open <= 0 || !source.endsWith(">")) return null;
  const name = source.slice(0, open).trim();
  if (!name) return null;
  return { name, args: splitTopLevel(source.slice(open + 1, -1), ",").map((arg) => cleanType(arg)) };
}

export function callSignatureForType(type: TypeName, env?: TypeEnv): Signature | null {
  const base = env ? baseTypeName(resolveType(type, env)) : baseTypeName(type);
  const modelForward = env?.modelForwards.get(base);
  if (modelForward) return modelForward;
  const owner = methodOwnerName(type, env);
  let sig = CALL_SIGNATURES.get(owner);
  if (sig) return sig;
  const match = lookupMethod(owner, "forward", env);
  if (!match || match.method.isGetter) return null;
  sig = signatureFromMethod(match.owner, match.method);
  CALL_SIGNATURES.set(owner, sig);
  return sig;
}

export function typeLiteralShape(type: TypeName): ObjectShape | null {
  const source = cleanType(type);
  if (!source.startsWith("{") || !source.endsWith("}")) return null;
  const fields = new Map<string, Binding>();
  const indexers: IndexSignature[] = [];
  const body = source.slice(1, -1);
  for (const part of splitTopLevel(body, ",")) {
    const item = part.trim();
    if (!item) continue;
    const indexer = item.match(/^\[\s*(?:[A-Za-z_$][\w$]*\s*:\s*)?(.+?)\s*\]\s*:\s*(.+)$/);
    if (indexer) {
      indexers.push({ keyType: cleanType(indexer[1]), valueType: cleanType(indexer[2]) });
      continue;
    }
    const match = item.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+)$/);
    if (match) fields.set(match[1], { type: cleanType(match[3]), optional: !!match[2] });
  }
  return { fields, indexers };
}

export function shapeType(shape: ObjectShape): TypeName {
  const fields = [...shape.fields].map(([name, binding]) => `${name}${binding.optional ? "?" : ""}: ${binding.type}`);
  const indexers = (shape.indexers ?? []).map((indexer) => `[key: ${indexer.keyType}]: ${indexer.valueType}`);
  return `{ ${[...fields, ...indexers].join(", ")} }`;
}

export function instantiateShapeForType(type: TypeName, env: TypeEnv): ObjectShape | null {
  const resolved = resolveType(type, env);
  const literal = typeLiteralShape(resolved);
  if (literal) return literal;
  const generic = resolved.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
  const base = generic ? generic[1] : baseTypeName(resolved);
  const shape = env.interfaces.get(base);
  if (!shape) return null;
  if (!generic || !shape.typeParams?.length) return shape;
  const args = splitTopLevel(generic[2], ",").map((arg) => cleanType(arg));
  const substitutions = new Map<string, TypeName>();
  for (let i = 0; i < args.length && i < shape.typeParams.length; i++) substitutions.set(shape.typeParams[i], args[i]);
  const fields = new Map<string, Binding>();
  for (const [name, binding] of shape.fields) {
    fields.set(name, { ...binding, type: substituteType(binding.type, substitutions) });
  }
  const indexers = shape.indexers?.map((indexer) => ({
    keyType: substituteType(indexer.keyType, substitutions),
    valueType: substituteType(indexer.valueType, substitutions),
  }));
  return { fields, indexers };
}

function shapeIndexFor(shape: ObjectShape, keyType: TypeName | null, env: TypeEnv): IndexSignature | null {
  for (const indexer of shape.indexers ?? []) {
    if (!keyType || compatible(keyType, indexer.keyType, env)) return indexer;
  }
  return null;
}

export function compatible(actual: TypeName, expected: TypeName, env: TypeEnv): boolean {
  return assignable(actual, expected, env, new Map());
}

function assignable(actualRaw: TypeName, expectedRaw: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  const actual = resolveType(actualRaw, env);
  const expected = resolveType(expectedRaw, env);
  const key = `${actual}\u0000${expected}`;
  const previous = memo.get(key);
  if (previous !== undefined) return previous;
  memo.set(key, true);
  const result = assignableUncached(actual, expected, env, memo);
  memo.set(key, result);
  return result;
}

function assignableUncached(actual: TypeName, expected: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  if (actual === "error" || expected === "any" || actual === "any") return true;
  if (actual === expected) return true;
  if (actual === "never") return true;
  if (expected === "unknown") return true;
  if (actual === "unknown") return false;
  if (expected === "Function") return actual === "Function" || parseFunctionType(actual) !== null;
  const expectedFn = parseFunctionType(expected);
  if (expectedFn) return functionAssignable(actual, expectedFn, env, memo);
  const expectedUnion = splitTopLevel(expected, "|");
  if (expectedUnion.length > 1) return expectedUnion.some((part) => assignable(actual, part.trim(), env, memo));
  const actualUnion = splitTopLevel(actual, "|");
  if (actualUnion.length > 1) return actualUnion.every((part) => assignable(part.trim(), expected, env, memo));
  const expectedIntersection = splitTopLevel(expected, "&");
  if (expectedIntersection.length > 1) return expectedIntersection.every((part) => assignable(actual, part.trim(), env, memo));
  if (tupleAssignable(actual, expected, env, memo)) return true;
  if (arrayAssignable(actual, expected, env, memo)) return true;
  if (numericAssignable(actual, expected)) return true;
  if (boolAssignable(actual, expected)) return true;
  if (nominalAssignable(actual, expected, env)) return true;
  if (objectAssignable(actual, expected, env, memo)) return true;
  return false;
}

function functionAssignable(actual: TypeName, expectedFn: Signature, env: TypeEnv, memo: Map<string, boolean>): boolean {
  const actualFn = parseFunctionType(actual);
  if (!actualFn) return actual === "Function";
  if (actualFn.positional.length > expectedFn.positional.length) return false;
  for (let i = 0; i < actualFn.positional.length; i++) {
    const expectedParam = expectedFn.params.get(expectedFn.positional[i])!;
    const actualParam = actualFn.params.get(actualFn.positional[i])!;
    if (!assignable(expectedParam.type, actualParam.type, env, memo)) return false;
  }
  return assignable(actualFn.returns, expectedFn.returns, env, memo);
}

function tupleAssignable(actual: TypeName, expected: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  if (!isTupleType(expected)) return false;
  const expectedItems = tupleTypes(expected);
  const actualItems = tupleTypes(actual);
  if (actualItems.length !== expectedItems.length) return false;
  for (let i = 0; i < expectedItems.length; i++) {
    if (!assignable(actualItems[i], expectedItems[i], env, memo)) return false;
  }
  return true;
}

function arrayAssignable(actual: TypeName, expected: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  if (expected === "Array") return actual === "Array" || !!arrayElementType(actual) || isTupleType(actual);
  const expectedElement = arrayElementType(expected);
  if (!expectedElement) return false;
  const actualElement = arrayElementType(actual);
  if (actualElement) return assignable(actualElement, expectedElement, env, memo);
  if (isTupleType(actual)) return tupleTypes(actual).every((item) => assignable(item, expectedElement, env, memo));
  return actual === "Array";
}

function numericAssignable(actual: TypeName, expected: TypeName): boolean {
  const actualRank = NUMERIC_RANK.get(actual);
  const expectedRank = NUMERIC_RANK.get(expected);
  return actualRank !== undefined && expectedRank !== undefined && actualRank <= expectedRank;
}

function boolAssignable(actual: TypeName, expected: TypeName): boolean {
  return (actual === "bool" || actual === "boolean") && (expected === "bool" || expected === "boolean");
}

function nominalFamily(type: TypeName, env: TypeEnv): TypeName | null {
  const base = baseTypeName(resolveType(type, env));
  return env.nominalFamilies.get(base) ?? BUILTIN_FAMILIES.get(base) ?? null;
}

function commonNominalAncestor(left: TypeName, right: TypeName, env: TypeEnv): TypeName | null {
  const leftLineage = nominalLineage(left, env);
  const rightLineage = new Set(nominalLineage(right, env));
  return leftLineage.find((item) => rightLineage.has(item)) ?? null;
}

function nominalLineage(type: TypeName, env: TypeEnv): TypeName[] {
  const out: TypeName[] = [];
  let current: TypeName | null = baseTypeName(type);
  const seen = new Set<TypeName>();
  while (current && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = nominalFamily(current, env);
  }
  return out;
}

function nominalAssignable(actual: TypeName, expected: TypeName, env: TypeEnv): boolean {
  const expectedBase = baseTypeName(expected);
  let current: TypeName | null = baseTypeName(actual);
  const seen = new Set<TypeName>();
  while (current && !seen.has(current)) {
    if (current === expectedBase) return true;
    seen.add(current);
    current = nominalFamily(current, env);
  }
  return false;
}

function objectAssignable(actual: TypeName, expected: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  const actualShape = instantiateShapeForType(actual, env);
  if (expected === "Object") return actual === "Object" || actualShape !== null;
  const expectedShape = instantiateShapeForType(expected, env);
  if (!expectedShape) return false;
  if (!actualShape) return false;
  for (const [name, expectedField] of expectedShape.fields) {
    const actualField = actualShape.fields.get(name);
    if (!actualField) {
      if (!expectedField.optional) return false;
      continue;
    }
    if (actualField.optional && !expectedField.optional) return false;
    if (!assignable(actualField.type, expectedField.type, env, memo)) return false;
  }
  for (const expectedIndex of expectedShape.indexers ?? []) {
    const actualIndex = actualShape.indexers?.find((indexer) => assignable(indexer.keyType, expectedIndex.keyType, env, memo));
    if (actualIndex && !assignable(actualIndex.valueType, expectedIndex.valueType, env, memo)) return false;
    for (const [name, actualField] of actualShape.fields) {
      if (expectedShape.fields.has(name)) continue;
      if (!assignable("string", expectedIndex.keyType, env, memo)) continue;
      if (!assignable(actualField.type, expectedIndex.valueType, env, memo)) return false;
    }
  }
  return true;
}
