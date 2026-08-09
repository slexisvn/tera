export type BackendArtifact =
  | { readonly kind: "wasm"; readonly bytes: Uint8Array }
  | {
      readonly kind: "c";
      readonly symbol: string;
      readonly prototype: string;
      readonly source: string;
      readonly headerPreamble: string;
      readonly sourcePreamble: string;
      readonly translationUnitPreamble: string;
      readonly references: readonly string[];
    }
  | { readonly kind: "llvm"; readonly module: string };
