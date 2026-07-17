declare module "@slexisvn/mlfw" {
  export const memfs: {
    writeFile(name: string, data: string): void;
    writeBinary(name: string, data: Uint8Array): void;
    remove(name: string): void;
  };
  const exports: Record<string, unknown>;
  export = exports;
}
