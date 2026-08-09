export interface DeclaredSignature {
  readonly params: readonly (string | null)[];
  readonly returns: string | null;
}
