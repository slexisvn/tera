export type DeclaredDefault = number | string | boolean | null;

export interface DeclaredSignature {
  readonly params: readonly (string | null)[];
  readonly names?: readonly string[];
  readonly defaults?: readonly (DeclaredDefault | undefined)[];
  readonly variadic?: boolean;
  readonly returns: string | null;
}
