import { CHART_METADATA, DOMAIN_BUILTIN_METADATA } from "../../runtime/domain/metadata.js";
import { TYPE_METHODS } from "../../runtime/domain/type-methods.js";
import type { RuntimeFunctionMetadata } from "../../core/value/index.js";

export type TypeName = string;

export type Binding = {
  type: TypeName;
  optional: boolean;
};

export type ObjectShape = {
  typeParams?: string[];
  fields: Map<string, Binding>;
};

export type TypeAlias = {
  typeParams: string[];
  type: TypeName;
};

export type Signature = {
  name: string;
  typeParams: string[];
  params: Map<string, Binding>;
  required: Set<string>;
  positional: string[];
  returns: TypeName;
  allowUnknownNamed?: boolean;
};

export type TypeEnv = {
  aliases: Map<string, TypeAlias>;
  interfaces: Map<string, ObjectShape>;
};

export const BUILTIN_SIGNATURES = new Map<string, Signature>();

export function cleanType(type: string | undefined): TypeName {
  if (!type) return "any";
  const trimmed = type.trim();
  if (!trimmed) return "any";
  if (trimmed === "boolean") return "bool";
  return trimmed
    .replace(/\bboolean\b/g, "bool")
    .replace(/\bArray\s*<\s*([^>]+)\s*>/g, "$1[]")
    .replace(/^\((.*)\)\s*->\s*(.+)$/g, "($1) -> $2")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ");
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
    paramMap.set(paramName, { type, optional: !!optional });
    positional.push(paramName);
    if (!optional) required.add(paramName);
  }
  return { name, typeParams: [], params: paramMap, required, positional, returns };
}

function signatureFromMetadata(metadata: RuntimeFunctionMetadata): Signature {
  const paramMap = new Map<string, Binding>();
  const required = new Set<string>();
  const positional: string[] = [];
  let allowUnknownNamed = false;
  for (const param of metadata.params ?? []) {
    if (param.rest && param.named) {
      allowUnknownNamed = true;
      continue;
    }
    paramMap.set(param.name, { type: cleanType(param.type), optional: !!param.optional || param.defaultValue !== undefined });
    if (!param.named) positional.push(param.name);
    if (!param.optional && param.defaultValue === undefined) required.add(param.name);
  }
  return { name: metadata.name, typeParams: [], params: paramMap, required, positional, returns: cleanType(metadata.returns), allowUnknownNamed };
}

for (const sig of [
  signature("Map", [], "Map"),
  signature("Set", [], "Set"),
  signature("print", [["value", "any", true]], "undefined"),
]) {
  BUILTIN_SIGNATURES.set(sig.name, sig);
}
for (const metadata of Object.values(DOMAIN_BUILTIN_METADATA)) {
  BUILTIN_SIGNATURES.set(metadata.name, signatureFromMetadata(metadata));
}
for (const metadata of Object.values(CHART_METADATA)) {
  BUILTIN_SIGNATURES.set(`chart.${metadata.name}`, signatureFromMetadata({ ...metadata, name: `chart.${metadata.name}` }));
}

export function createTypeEnv(): TypeEnv {
  return { aliases: new Map(), interfaces: new Map() };
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
  return { ...sig, params, returns: substituteType(sig.returns, substitutions) };
}

export function resolveType(type: TypeName, env: TypeEnv, seen = new Set<string>()): TypeName {
  const name = String(type).trim();
  if (seen.has(name)) return name;
  const generic = name.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
  if (generic) {
    const alias = env.aliases.get(generic[1]);
    if (alias) {
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
  const source = String(type).trim();
  const match = source.match(/^\((.*)\)\s*->\s*(.+)$/);
  if (!match) return null;
  const params = new Map<string, Binding>();
  const positional: string[] = [];
  const required = new Set<string>();
  const rawParams = splitTopLevel(match[1], ",").map((part) => part.trim()).filter(Boolean);
  for (let i = 0; i < rawParams.length; i++) {
    const name = `arg${i}`;
    params.set(name, { type: cleanType(rawParams[i]), optional: false });
    positional.push(name);
    required.add(name);
  }
  return { name: "<function>", typeParams: [], params, positional, required, returns: cleanType(match[2]) };
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
  for (const part of parts) {
    const key = String(part);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(part);
    }
  }
  return out.length === 0 ? "never" : out.length === 1 ? out[0] : out.join(" | ");
}

export function removeNullish(type: TypeName, env: TypeEnv): TypeName {
  return unionType(unionParts(type, env).filter((part) => part !== "null" && part !== "undefined"));
}

function isTupleType(type: TypeName): boolean {
  const source = String(type).trim();
  return source.startsWith("[") && source.endsWith("]");
}

function tupleTypes(type: TypeName): TypeName[] {
  const source = String(type).trim();
  if (!isTupleType(source)) return [];
  return splitTopLevel(source.slice(1, -1), ",").map((part) => cleanType(part));
}

function arrayElementType(type: TypeName): TypeName | null {
  const source = String(type).trim();
  if (!source.endsWith("[]")) return null;
  return cleanType(source.slice(0, -2));
}

export function baseTypeName(type: TypeName): string {
  const generic = String(type).match(/^([A-Za-z_$][\w$]*)\s*</);
  return generic ? generic[1] : String(type);
}

export type MemberType = {
  returns: TypeName;
  getter: boolean;
};

export function builtinMethod(type: TypeName, name: string): MemberType | null {
  const method = TYPE_METHODS[baseTypeName(type)]?.[name];
  return method ? { returns: cleanType(method.returns), getter: !!method.getter } : null;
}

export function typeLiteralShape(type: TypeName): ObjectShape | null {
  const source = String(type).trim();
  if (!source.startsWith("{") || !source.endsWith("}")) return null;
  const fields = new Map<string, Binding>();
  const body = source.slice(1, -1);
  for (const part of splitTopLevel(body, ",")) {
    const item = part.trim();
    if (!item) continue;
    const match = item.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+)$/);
    if (match) fields.set(match[1], { type: cleanType(match[3]), optional: !!match[2] });
  }
  return { fields };
}

export function instantiateShapeForType(type: TypeName, env: TypeEnv): ObjectShape | null {
  const resolved = resolveType(type, env);
  const literal = typeLiteralShape(resolved);
  if (literal) return literal;
  const source = String(type).trim();
  const generic = source.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
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
  return { fields };
}

const NUMERIC_TYPES = new Set<TypeName>(["number", "int", "float"]);

export function compatible(actual: TypeName, expected: TypeName, env: TypeEnv): boolean {
  actual = resolveType(actual, env);
  expected = resolveType(expected, env);
  if (expected === "any" || actual === "any" || actual === "unknown" || expected === "unknown") return true;
  if (expected === actual) return true;
  const expectedFn = parseFunctionType(expected);
  if (expectedFn) {
    const actualFn = parseFunctionType(actual);
    if (!actualFn) return actual === "Function";
    if (actualFn.positional.length !== expectedFn.positional.length) return false;
    for (let i = 0; i < expectedFn.positional.length; i++) {
      const expectedParam = expectedFn.params.get(expectedFn.positional[i])!;
      const actualParam = actualFn.params.get(actualFn.positional[i])!;
      if (!compatible(expectedParam.type, actualParam.type, env)) return false;
    }
    return compatible(actualFn.returns, expectedFn.returns, env);
  }
  const expectedUnion = splitTopLevel(expected, "|");
  if (expectedUnion.length > 1) return expectedUnion.some((part) => compatible(actual, part.trim(), env));
  const actualUnion = splitTopLevel(actual, "|");
  if (actualUnion.length > 1) return actualUnion.every((part) => compatible(part.trim(), expected, env));

  if (expected.startsWith("[") && expected.endsWith("]")) {
    const expectedItems = tupleTypes(expected);
    const actualItems = tupleTypes(actual);
    if (actualItems.length !== expectedItems.length) return false;
    return expectedItems.every((item, index) => compatible(actualItems[index], item, env));
  }
  const expectedElement = arrayElementType(expected);
  if (expectedElement) {
    const actualElement = arrayElementType(actual);
    if (actualElement) return compatible(actualElement, expectedElement, env);
    if (actual.startsWith("[") && actual.endsWith("]")) return tupleTypes(actual).every((item) => compatible(item, expectedElement, env));
  }
  if (NUMERIC_TYPES.has(expected) && NUMERIC_TYPES.has(actual)) return true;
  if ((expected === "bool" || expected === "boolean") && (actual === "bool" || actual === "boolean")) return true;
  if (expected.includes("&")) return splitTopLevel(expected, "&").every((part) => compatible(actual, part.trim(), env));
  if ((actual.endsWith("[]") || actual.startsWith("[")) && (expected === "Array" || expected === "unknown[]")) return true;
  if (actual === "Array" && expected.endsWith("[]")) return true;
  if (typeLiteralShape(expected) && actual === "Object") return true;
  if (env.interfaces.has(baseTypeName(expected)) && (actual === "Object" || env.interfaces.has(baseTypeName(actual)))) return true;
  return false;
}
