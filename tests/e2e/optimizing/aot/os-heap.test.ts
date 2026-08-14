import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { WINDOWS_IMPORTS } from "../../../../src/optimizing/backends/x64/windows.js";
import {
  TERA_CONTEXT,
  TERA_HEAP_RESERVE_BYTES,
} from "../../../../src/optimizing/target/runtime-layout.js";
import { heapData, heapImageOf } from "../../../../src/optimizing/machine/heap-data.js";
import { machineDataBytes } from "../../../../src/optimizing/machine/data.js";

const src = (...lines: string[]) => lines.join("\n");

const COUNTING_BODY = src(
  "class Cell:",
  "  public constructor(v: int):",
  "    this.v = v",
  "  public get value() -> int:",
  "    return this.v",
  "fn total(n: int) -> int:",
  "  sum = 0",
  "  i = 0",
  "  while i < n:",
  "    sum = sum + Cell(i).value",
  "    i = i + 1",
  "  return sum",
);

const ROUNDS = 40000;
const COUNTING = src(COUNTING_BODY, `print(total(${ROUNDS}))`);

function image(source: string, heapBytes?: number): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
    ...(heapBytes === undefined ? {} : { heapBytes }),
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function reservedBytesOf(heapBytes?: number): bigint {
  const context = heapData(heapImageOf(null, heapBytes)).find(
    (datum) => datum.label === TERA_CONTEXT.symbol,
  )!;
  const field = TERA_CONTEXT.field("arenaReserved");
  const bytes = machineDataBytes(context.items).slice(
    field.offset,
    field.offset + field.bytes,
  );
  return bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

describe("AOT heap from the OS", () => {
  it("asks the OS for memory instead of reserving an arena in the image", () => {
    expect(heapData(heapImageOf(null, undefined)).map((datum) => datum.label)).not.toContain(
      "tera_arena",
    );
  });

  it("writes the requested reserve size into the context the program starts with", () => {
    expect(reservedBytesOf(undefined)).toBe(BigInt(TERA_HEAP_RESERVE_BYTES));
    expect(reservedBytesOf(1 << 26)).toBe(BigInt(1 << 26));
  });

  it("keeps a reserve far larger than the bytes the image carries", () => {
    const carried = image(COUNTING).byteLength;
    expect(TERA_HEAP_RESERVE_BYTES).toBeGreaterThan(carried);
  });

  it("reaches the operating system through kernel32 alone", () => {
    const [library, ...rest] = WINDOWS_IMPORTS;
    expect(rest).toEqual([]);
    expect(library!.dll).toBe("kernel32.dll");
    expect(library!.functions).toContain("VirtualAlloc");
  });

  itRunsPe("allocates the same way whatever reserve it was given", () => {
    const expected = nodeEngine({ typecheck: "off" }).runNative(
      `${COUNTING_BODY}\ntotal(${ROUNDS})\n`,
    );
    for (const heapBytes of [undefined, 1 << 17, 2 ** 31]) {
      const run = runPe(image(COUNTING, heapBytes));
      expect([heapBytes, run.status, run.stdout]).toEqual([heapBytes, 0, `${expected}\n`]);
    }
  });
});
