import type { CsvRow, DataFrameRow, KernelRunResult, KernelValue } from "./notebook";

export type RuntimeLike = {
  runNative(source: string): unknown;
  interpreter: {
    globalCells: {
      cells: Map<string, unknown>;
    };
  };
};

export type DataFrameLike = {
  columns(): Promise<string[]>;
  count(): Promise<number>;
  limit(limit: number, offset: number): {
    collect(): Promise<DataFrameRow[]>;
  };
};

export type FigureBuilderLike = {
  __isFigureBuilder: true;
  build(): Promise<unknown>;
};

export type KernelRequest =
  | { id: number; type: "execute"; payload: { source: string } }
  | { id: number; type: "restart"; payload: object }
  | { id: number; type: "completionNames"; payload: object }
  | { id: number; type: "beginCsv"; payload: { name: string } }
  | { id: number; type: "appendCsvRows"; payload: { name: string; rows: CsvRow[] } }
  | { id: number; type: "finishCsv"; payload: { name: string } }
  | { id: number; type: "writeFile"; payload: { name: string; data: string | ArrayBuffer; binary: boolean } }
  | { id: number; type: "removeFile"; payload: { name: string; kind: string } }
  | { id: number; type: "dataframePage"; payload: { id: string; offset: number; limit: number } };

export type KernelResponse =
  | { id: number; ok: true; result: KernelRunResult | KernelValue | string[] | boolean | { rows: DataFrameRow[] } }
  | { id: number; ok: false; error: string };

export type VscodeKernel = {
  execute(source: string): Promise<VscodeKernelRunResult>;
  restart(): void;
  writeFile(name: string, data: string | ArrayBuffer, binary: boolean): void;
};

export type VscodeKernelRunResult = {
  prints: string[];
  value?: KernelValue | { kind: "dataframe"; columns: string[]; total: number; rows: DataFrameRow[] };
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
