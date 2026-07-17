export type CellId = string;

export type PrimitiveCellValue = string | number | boolean | null;
export type CsvCellValue = PrimitiveCellValue;
export type CsvRow = CsvCellValue[];
export type DataFrameRow = Record<string, PrimitiveCellValue>;

export type KernelValue =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "tensor"; shape: number[]; data: unknown; summary: string }
  | { kind: "chart"; spec: ChartSpec }
  | { kind: "dataframe"; id: string; columns: string[]; total: number };

export type ChartPoint = {
  x?: number | string;
  y?: number;
  value?: number;
  label?: string;
  color?: string;
  series?: string;
};

export type ChartSpec = {
  kind?: string;
  type?: string;
  title?: string;
  subtitle?: string;
  data?: ChartPoint[];
  series?: Array<{ name?: string; data?: ChartPoint[]; color?: string }>;
  options?: Record<string, PrimitiveCellValue | PrimitiveCellValue[]>;
};

export type KernelRunResult = {
  prints?: string[];
  value?: KernelValue;
  completionNames?: string[];
};

export type CellOutput = {
  ok: boolean;
  prints: string[];
  value?: KernelValue;
  error?: string;
};

export type CellState = {
  id: CellId;
  source: string;
  executionCount?: number;
  running?: boolean;
  output?: CellOutput;
};

export type UploadedFileMeta = {
  kind: "csv" | "file";
  size: number;
  ext?: string;
  rowCount?: number;
};

export type AddCellOptions = {
  afterId?: CellId;
  focus?: boolean;
};
