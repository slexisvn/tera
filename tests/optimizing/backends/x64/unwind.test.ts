import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const PROGRAM = src(
  "fn work(n: int) -> int:",
  "  if n < 0:",
  "    return 0",
  "  return n * 2 + 1",
  "print(work(3))",
);

function imageOf(): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(PROGRAM, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function read(image: Uint8Array, offset: number, bytes: number): number {
  let value = 0;
  for (let at = bytes - 1; at >= 0; at--) value = value * 256 + image[offset + at]!;
  return value;
}

describe("win64 unwind tables", () => {
  it("points the exception directory at a non-empty .pdata", () => {
    const image = imageOf();
    const peOffset = read(image, 0x3c, 4);
    const optional = peOffset + 4 + 20;
    const directories = optional + 112;
    const address = read(image, directories + 3 * 8, 4);
    const size = read(image, directories + 3 * 8 + 4, 4);

    expect(address).toBeGreaterThan(0);
    expect(size % 12).toBe(0);
    expect(size).toBeGreaterThanOrEqual(12);
  });

  it("describes each function with a version 1 unwind record", () => {
    const image = imageOf();
    const peOffset = read(image, 0x3c, 4);
    const sections = peOffset + 4 + 20 + 240;
    let xdata: { raw: number; size: number } | null = null;
    for (let index = 0; index < read(image, peOffset + 4 + 2, 2); index++) {
      const header = sections + index * 40;
      const name = String.fromCharCode(...image.slice(header, header + 8)).replace(/\0+$/, "");
      if (name === ".xdata") xdata = { raw: read(image, header + 20, 4), size: read(image, header + 16, 4) };
    }

    expect(xdata).not.toBeNull();
    expect(image[xdata!.raw]! & 0x07).toBe(1);
    expect(image[xdata!.raw]! >> 3).toBe(0);
    expect(image[xdata!.raw + 1]).toBeGreaterThan(0);
    expect(image[xdata!.raw + 2]).toBeGreaterThan(0);
    expect(image[xdata!.raw + 3]).toBe(0);
  });
});
