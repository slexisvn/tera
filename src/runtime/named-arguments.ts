export const NATIVE_NAMED_ARGUMENTS = Symbol.for("tera.nativeNamedArguments");

type NamedCarrier = {
  [NATIVE_NAMED_ARGUMENTS]?: true;
};

export function markNamedArguments<T extends object>(value: T): T {
  Object.defineProperty(value, NATIVE_NAMED_ARGUMENTS, { value: true });
  return value;
}

export function isNamedArguments(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as NamedCarrier)[NATIVE_NAMED_ARGUMENTS] === true;
}
