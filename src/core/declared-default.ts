import { splitTopLevel, UNTYPED_NAMES } from "./type-text.js";

export type DeclaredDefaultLiteral = {
  readonly value: string | number | boolean | null;
  readonly kind: string;
};

const NUMBER_KIND = "number";
const STRING_KIND = "string";
const BOOLEAN_KIND = "boolean";
const NULL_KIND = "null";

const PRIMITIVE_DEFAULTS: ReadonlyMap<string, DeclaredDefaultLiteral> = new Map([
  ["int", { value: 0, kind: NUMBER_KIND }],
  ["float", { value: 0, kind: NUMBER_KIND }],
  ["number", { value: 0, kind: NUMBER_KIND }],
  ["string", { value: "", kind: STRING_KIND }],
  ["bool", { value: false, kind: BOOLEAN_KIND }],
  ["boolean", { value: false, kind: BOOLEAN_KIND }],
]);

const NULL_DEFAULT: DeclaredDefaultLiteral = { value: null, kind: NULL_KIND };
const UNION_SEPARATOR = "|";

function normalized(declaredType: string): string {
  return declaredType.trim();
}

function unionMembers(declaredType: string): readonly string[] {
  return splitTopLevel(declaredType, UNION_SEPARATOR)
    .map(normalized)
    .filter((part) => part.length > 0);
}

export function declaredTypeDefault(declaredType: string | undefined): DeclaredDefaultLiteral | null {
  if (declaredType === undefined) return null;
  const source = normalized(declaredType);
  if (source.length === 0) return null;
  const members = unionMembers(source);
  if (members.some((member) => UNTYPED_NAMES.has(member))) return null;
  if (members.length > 1) return members.includes("null") ? NULL_DEFAULT : null;
  return PRIMITIVE_DEFAULTS.get(members[0]!) ?? NULL_DEFAULT;
}
