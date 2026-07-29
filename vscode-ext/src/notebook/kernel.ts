import { memfs } from '@slexisvn/mlfw';
import { Engine } from '@slexisvn/tera';
import { isChartSpec } from '../../../notebook/src/chart';
import type { DataFrameLike, FigureBuilderLike, RuntimeLike, VscodeKernel, VscodeKernelRunResult } from "../../../notebook/src/types/kernel";
import type { ChartSpec, DataFrameRow, KernelValue } from "../../../notebook/src/types/notebook";

const DF_PREVIEW_ROWS = 50;

function isDataFrame(value: unknown): value is DataFrameLike {
  return typeof value === "object" && value !== null
    && typeof (value as { limit?: unknown }).limit === "function"
    && typeof (value as { columns?: unknown }).columns === "function"
    && typeof (value as { count?: unknown }).count === "function";
}

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Map) return `Map(${value.size})`;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (hasCustomToString(value)) return value.toString();
  return JSON.stringify(value);
}

function hasCustomToString(value: unknown): value is { toString(): string } {
  return typeof value === "object" && value !== null && typeof value.toString === "function" && value.toString !== Object.prototype.toString;
}

type TensorLike = { shape: number[]; toArray(): unknown };

function isTensor(value: unknown): value is TensorLike {
  return typeof value === "object" && value !== null
    && Array.isArray((value as { shape?: unknown }).shape)
    && typeof (value as { toArray?: unknown }).toArray === "function";
}

function isFigureBuilder(value: unknown): value is FigureBuilderLike {
  return typeof value === "object" && value !== null
    && (value as { __isFigureBuilder?: unknown }).__isFigureBuilder === true
    && typeof (value as { build?: unknown }).build === "function";
}

type VscodeKernelValue = KernelValue | { kind: "dataframe"; columns: string[]; total: number; rows: DataFrameRow[] };

async function serializeValue(value: unknown): Promise<VscodeKernelValue> {
  if (value === undefined) return { kind: 'empty' };
  if (isFigureBuilder(value)) value = await value.build();
  if (isChartSpec(value)) return { kind: 'chart', spec: value as ChartSpec };
  if (isTensor(value)) {
    const { shape } = value;
    return {
      kind: 'tensor',
      shape,
      data: value.toArray(),
      summary: hasCustomToString(value) ? value.toString() : `Tensor(shape=${JSON.stringify(shape)})`,
    };
  }
  if (isDataFrame(value)) {
    const columns = await value.columns();
    const total = await value.count();
    const rows = await value.limit(DF_PREVIEW_ROWS, 0).collect();
    return { kind: 'dataframe', columns, total, rows };
  }
  return { kind: 'text', text: formatValue(value) };
}

export function createKernel(): VscodeKernel {
  let prints: string[] = [];
  let runtime: RuntimeLike | null = null;

  function make(): void {
    prints = [];
    runtime = new Engine({ output: (text: unknown) => prints.push(String(text)) }) as RuntimeLike;
  }

  make();

  return {
    async execute(source: string): Promise<VscodeKernelRunResult> {
      if (!runtime) throw new Error("Kernel runtime is not initialized");
      prints = [];
      const value = await Promise.resolve(runtime.runNative(source));
      return { prints: prints.slice(), value: await serializeValue(value) };
    },
    restart(): void {
      make();
    },
    writeFile(name: string, data: string | ArrayBuffer, binary: boolean): void {
      if (binary) {
        if (typeof data === "string") throw new Error("Binary file payload must be an ArrayBuffer");
        memfs.writeBinary(name, new Uint8Array(data));
      } else {
        if (typeof data !== "string") throw new Error("Text file payload must be a string");
        memfs.writeFile(name, data);
      }
    },
  };
}
