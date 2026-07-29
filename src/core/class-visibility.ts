export const CLASS_VISIBILITIES = ["public", "private", "protected"] as const;

export type ClassVisibility = (typeof CLASS_VISIBILITIES)[number];

export const DEFAULT_CLASS_VISIBILITY: ClassVisibility = "public";
export const CLASS_STATIC_MODIFIER = "static";
export const CLASS_ABSTRACT_MODIFIER = "abstract";
export const CLASS_MEMBER_MODIFIERS = [CLASS_STATIC_MODIFIER, CLASS_ABSTRACT_MODIFIER] as const;

export const CLASS_VISIBILITY_KEYWORDS = new Set<string>(CLASS_VISIBILITIES);
export const CLASS_MEMBER_MODIFIER_KEYWORDS = new Set<string>(CLASS_MEMBER_MODIFIERS);

export function isClassVisibility(value: unknown): value is ClassVisibility {
  return typeof value === "string" && CLASS_VISIBILITY_KEYWORDS.has(value);
}

export function classVisibilityOrDefault(value: unknown): ClassVisibility {
  return isClassVisibility(value) ? value : DEFAULT_CLASS_VISIBILITY;
}
