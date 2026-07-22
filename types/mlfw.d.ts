declare module "@slexisvn/mlfw" {
  export const memfs: {
    writeFile(name: string, data: string): void;
    writeBinary(name: string, data: Uint8Array): void;
    remove(name: string): void;
  };
  export class Tensor {
    readonly shape: number[];
    readonly dtype: string;
    readonly device: unknown;
    readonly ndim: number;
    readonly numel: number;
    readonly data: unknown;
    item(): number;
    toArray(): unknown;
  }
  const exports: Record<string, unknown>;
  export = exports;
}
