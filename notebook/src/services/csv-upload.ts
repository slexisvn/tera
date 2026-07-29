import { CsvStreamParser } from "../../../src/csv-core";
import { CSV_BATCH_ROWS } from "../config/constants";
import type { CsvRow } from "../types/notebook";

export type CsvParseProgress = (read: number) => void;
export type CsvBatchHandler = (rows: CsvRow[]) => void;

export function parseCsvInWorker(file: File, onBatch: CsvBatchHandler, onProgress: CsvParseProgress) {
  return new Promise<{ rowCount: number }>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/csv-worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "batch") onBatch(message.rows);
      else if (message.type === "progress") onProgress(message.read);
      else if (message.type === "done") {
        worker.terminate();
        resolve({ rowCount: message.rowCount });
      } else if (message.type === "error") {
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message || "worker failed"));
    };
    worker.postMessage({ file, separator: "," });
  });
}

export async function parseCsvOnMainThread(file: File, onBatch: CsvBatchHandler, onProgress: CsvParseProgress) {
  const parser = new CsvStreamParser(",");
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    parser.feed(decoder.decode(value, { stream: true }));
    if (parser.pending.length >= CSV_BATCH_ROWS) onBatch(parser.drain());
    onProgress(read);
  }
  const { rowCount } = parser.finish();
  const last = parser.drain();
  if (last.length) onBatch(last);
  return { rowCount };
}
