export const CLASS_MEMBER_KINDS = ["constructor", "method", "getter", "setter"] as const;

export type ClassMemberKind = (typeof CLASS_MEMBER_KINDS)[number];

export const CLASS_MEMBER_KIND_KEYWORDS = new Set<string>(CLASS_MEMBER_KINDS);

export const CLASS_SHAPE_MEMBER_KINDS = ["field", "method", "getter", "setter"] as const;

export type ClassShapeMemberKind = (typeof CLASS_SHAPE_MEMBER_KINDS)[number];

export const CLASS_DATA_MEMBER: Extract<ClassShapeMemberKind, "field"> = "field";

export type ClassCallableKind = Exclude<ClassShapeMemberKind, typeof CLASS_DATA_MEMBER>;

export const CLASS_CALLABLE_KINDS: readonly ClassCallableKind[] =
  CLASS_SHAPE_MEMBER_KINDS.filter(
    (kind): kind is ClassCallableKind => kind !== CLASS_DATA_MEMBER,
  );

export const CLASS_PROTOTYPE_PROPERTY = "prototype";

const SUPER_BINDING_PREFIX = "_superClass$";

export function superClassBinding(className: string): string {
  return `${SUPER_BINDING_PREFIX}${className}`;
}

export function superClassBindingOwner(binding: string | undefined): string | null {
  if (binding === undefined || !binding.startsWith(SUPER_BINDING_PREFIX)) return null;
  return binding.slice(SUPER_BINDING_PREFIX.length);
}

const KIND_BY_ACCESSOR: ReadonlyMap<string, ClassMemberKind> = new Map<string, ClassMemberKind>([
  ["get", "getter"],
  ["set", "setter"],
]);

export function isClassMemberKind(value: unknown): value is ClassMemberKind {
  return typeof value === "string" && CLASS_MEMBER_KIND_KEYWORDS.has(value);
}

export function classMemberKindOfAccessor(accessor: unknown): ClassMemberKind {
  if (typeof accessor !== "string") return "method";
  return KIND_BY_ACCESSOR.get(accessor) ?? "method";
}
