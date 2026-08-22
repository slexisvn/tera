import type { ClassMemberKind } from "../../core/class-member.js";
import type { CFGInstruction } from "../ir/index.js";
import type { DeclaredSignature } from "../types/signature.js";

const MEMBER_SEPARATOR = ".";
const STATIC_QUALIFIER = "static";

export const CLASS_VALUE_PROP = "classValue";

export function classValueNameOf(node: CFGInstruction | null | undefined): string | null {
  const name = node?.props[CLASS_VALUE_PROP];
  return typeof name === "string" ? name : null;
}

const QUALIFIER_BY_KIND: ReadonlyMap<ClassMemberKind, string> = new Map<ClassMemberKind, string>([
  ["getter", "get"],
  ["setter", "set"],
]);

export interface ClassMemberIdentity {
  readonly name?: string | null;
  readonly classOwnerName?: string | null;
  readonly classMemberKind?: ClassMemberKind | null;
  readonly classMemberStatic?: boolean;
}

function joinMemberSymbol(
  owner: string,
  isStatic: boolean,
  qualifier: string | undefined,
  name: string,
): string {
  const parts = [owner];
  if (isStatic) parts.push(STATIC_QUALIFIER);
  if (qualifier !== undefined) parts.push(qualifier);
  parts.push(name);
  return parts.join(MEMBER_SEPARATOR);
}

export function classMemberSymbol(member: ClassMemberIdentity): string | null {
  const owner = member.classOwnerName;
  const kind = member.classMemberKind;
  if (typeof owner !== "string" || typeof member.name !== "string") return null;
  if (kind === undefined || kind === null || kind === "constructor") return null;
  return joinMemberSymbol(
    owner,
    member.classMemberStatic === true,
    QUALIFIER_BY_KIND.get(kind),
    member.name,
  );
}

export function classStaticFieldSymbol(owner: string, name: string): string {
  return joinMemberSymbol(owner, true, undefined, name);
}

const GLOBAL_VARIABLE_OWNER = "tera_global";

export function globalVariableSymbol(name: string): string {
  return joinMemberSymbol(GLOBAL_VARIABLE_OWNER, true, undefined, name);
}

export function hasClassReceiver(member: ClassMemberIdentity): boolean {
  const kind = member.classMemberKind;
  if (kind === undefined || kind === null) return false;
  return member.classMemberStatic !== true;
}

export interface ClassMemberFunction extends ClassMemberIdentity {
  readonly declaredSignature?: DeclaredSignature | null;
}

export const CLASS_RECEIVER_PARAM = "this";

export function memberSignature(member: ClassMemberFunction): DeclaredSignature {
  const owner = member.classOwnerName ?? null;
  const declared = member.declaredSignature ?? null;
  return {
    params: [owner, ...(declared?.params ?? [])],
    names: [CLASS_RECEIVER_PARAM, ...(declared?.names ?? [])],
    defaults: [undefined, ...(declared?.defaults ?? [])],
    variadic: declared?.variadic === true,
    rest: declared?.rest ?? null,
    returns: member.classMemberKind === "constructor" ? owner : declared?.returns ?? null,
  };
}

export function classMemberRenames<T extends ClassMemberIdentity>(
  members: Iterable<T>,
): Map<T, string> {
  const renames = new Map<T, string>();
  for (const member of members) {
    const symbol = classMemberSymbol(member);
    if (symbol !== null) renames.set(member, symbol);
  }
  return renames;
}
