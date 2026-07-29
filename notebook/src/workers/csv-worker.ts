import { CsvStreamParser } from '../../../src/csv-core';
import { errorMessage } from "../types/kernel";
import type { CsvRow } from "../types/notebook";

const BATCH_ROWS = 16384;

type CsvWorkerRequest = {
  file: File;
  separator?: string;
};

self.onmessage = async (e: MessageEvent<CsvWorkerRequest>) => {
  const { file, separator } = e.data;
  const parser = new CsvStreamParser(separator || ',');
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      parser.feed(decoder.decode(value, { stream: true }));
      if (parser.pending.length >= BATCH_ROWS) self.postMessage({ type: 'batch', rows: parser.drain() as CsvRow[] });
      self.postMessage({ type: 'progress', read });
    }
    const { rowCount, headers } = parser.finish();
    const last = parser.drain();
    if (last.length) self.postMessage({ type: 'batch', rows: last as CsvRow[] });
    self.postMessage({ type: 'done', rowCount, headers });
  } catch (err) {
    self.postMessage({ type: 'error', message: errorMessage(err) });
  }
};
