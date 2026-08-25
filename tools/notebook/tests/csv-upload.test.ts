import { describe, expect, it } from "vitest";
import { CSV_BATCH_ROWS } from "../src/config/constants";
import { parseCsvOnMainThread } from "../src/services/csv-upload";
import type { CsvRow } from "../src/types/notebook";

function fileOf(...chunks: readonly string[]): File {
  const encoder = new TextEncoder();
  const parts = chunks.map((chunk) => encoder.encode(chunk));
  return {
    stream: () => {
      let at = 0;
      return {
        getReader: () => ({
          read: async () =>
            at < parts.length ? { done: false, value: parts[at++]! } : { done: true, value: undefined },
        }),
      };
    },
  } as unknown as File;
}

async function upload(...chunks: readonly string[]) {
  const batches: CsvRow[][] = [];
  const progress: number[] = [];
  const { rowCount } = await parseCsvOnMainThread(
    fileOf(...chunks),
    (rows) => batches.push(rows),
    (read) => progress.push(read),
  );
  return { rowCount, batches, progress, rows: batches.flat() };
}

describe("reading an uploaded CSV into the notebook", () => {
  it("delivers the header as the first row and counts only the data rows", async () => {
    const { rows, rowCount } = await upload("name,score\nada,10\ngrace,20\n");

    expect(rows[0]).toEqual(["name", "score"]);
    expect(rows.slice(1)).toEqual([
      ["ada", 10],
      ["grace", 20],
    ]);
    expect(rowCount).toBe(2);
  });

  it("reads a numeric field as a number and leaves text alone", async () => {
    const { rows } = await upload("a,b\nada,10\n");

    expect(rows[1]).toEqual(["ada", 10]);
  });

  it("rejoins a row the chunk boundary cut in half", async () => {
    const { rows, rowCount } = await upload("name,score\nada,1", "0\ngrace,20\n");

    expect(rows[1]).toEqual(["ada", 10]);
    expect(rowCount).toBe(2);
  });

  it("keeps a separator that was inside quotes", async () => {
    const { rows } = await upload('a,b\n"x,y",2\n');

    expect(rows[1]).toEqual(["x,y", 2]);
  });

  it("reads Windows line endings without dragging the carriage return in", async () => {
    const { rows, rowCount } = await upload("a,b\r\n1,2\r\n");

    expect(rows[1]).toEqual([1, 2]);
    expect(rowCount).toBe(1);
  });

  it("still delivers a last row that has no newline after it", async () => {
    const { rows, rowCount } = await upload("a,b\n1,2");

    expect(rows[1]).toEqual([1, 2]);
    expect(rowCount).toBe(1);
  });

  it("delivers nothing at all for an empty file", async () => {
    const { batches, rowCount } = await upload("");

    expect(batches).toEqual([]);
    expect(rowCount).toBe(0);
  });

  it("reports progress as bytes read so far, ending at the whole file", async () => {
    const chunks = ["name,score\nada,10\n", "grace,20\n"];
    const sizes = chunks.map((chunk) => new TextEncoder().encode(chunk).byteLength);
    const { progress } = await upload(...chunks);

    expect(progress).toEqual([sizes[0], sizes[0]! + sizes[1]!]);
  });

  it("flushes mid-upload once enough rows are waiting, instead of holding the whole file", async () => {
    const header = "a,b\n";
    const body = Array.from({ length: CSV_BATCH_ROWS + 16 }, (_, at) => `r${at},${at}\n`).join("");
    const { batches, rowCount } = await upload(header + body, "z,99\n");

    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBeGreaterThan(CSV_BATCH_ROWS);
    expect(batches[1]).toEqual([["z", 99]]);
    expect(rowCount).toBe(CSV_BATCH_ROWS + 17);
  });

  it("hands every row to a batch exactly once", async () => {
    const { rows, rowCount } = await upload("a,b\n1,2\n", "3,4\n", "5,6\n");

    expect(rows.length).toBe(rowCount + 1);
    expect(rows.slice(1)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });
});
