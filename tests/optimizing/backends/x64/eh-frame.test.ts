import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const PROGRAM = src(
  "fn leaf(a: int, b: int) -> int:",
  "  return a * b + a - b",
  "fn spread(a: int, b: int, c: int, d: int, e: int, f: int) -> int:",
  "  t = leaf(a, b) + leaf(c, d) + leaf(e, f)",
  "  u = leaf(t, a) + leaf(t, b) + leaf(t, c)",
  "  return t + u + a + b + c + d + e + f",
  "print(spread(1, 2, 3, 4, 5, 6))",
);

const PT_GNU_EH_FRAME = 0x6474e550;
const PROGRAM_HEADER_BYTES = 56;
const SECTION_HEADER_BYTES = 64;
const CIE_BYTES = 24;
const FDE_PREFIX_BYTES = 16;
const DW_EH_PE_PCREL_SDATA4 = 0x1b;

function imageOf(format: "object" | "executable"): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(PROGRAM, {
    backend: "x64-linux",
    format,
  });
  expect(program.skipped).toEqual([]);
  const extension = format === "object" ? ".o" : ".elf";
  const file = program.files.find((candidate) => candidate.name.endsWith(extension));
  return file!.contents as Uint8Array;
}

function read(image: Uint8Array, offset: number, bytes: number): number {
  let value = 0;
  for (let at = bytes - 1; at >= 0; at--) value = value * 256 + image[offset + at]!;
  return value;
}

function signed(image: Uint8Array, offset: number): number {
  return read(image, offset, 4) | 0;
}

interface Section {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly entrySize: number;
}

function sectionsOf(image: Uint8Array): Section[] {
  const headers = read(image, 0x28, 8);
  const count = read(image, 0x3c, 2);
  const names = headers + read(image, 0x3e, 2) * SECTION_HEADER_BYTES;
  const namesOffset = read(image, names + 0x18, 8);
  const found: Section[] = [];
  for (let index = 0; index < count; index++) {
    const header = headers + index * SECTION_HEADER_BYTES;
    const start = namesOffset + read(image, header, 4);
    let end = start;
    while (image[end] !== 0) end++;
    found.push({
      name: new TextDecoder().decode(image.slice(start, end)),
      offset: read(image, header + 0x18, 8),
      size: read(image, header + 0x20, 8),
      entrySize: read(image, header + 0x38, 8),
    });
  }
  return found;
}

function sectionNamed(image: Uint8Array, name: string): Section {
  const found = sectionsOf(image).find((section) => section.name === name);
  expect(found, `image has no ${name}`).toBeDefined();
  return found!;
}

interface Segment {
  readonly type: number;
  readonly offset: number;
  readonly address: number;
  readonly size: number;
}

function segmentsOf(image: Uint8Array): Segment[] {
  const headers = read(image, 0x20, 8);
  const count = read(image, 0x38, 2);
  return Array.from({ length: count }, (_unused, index) => {
    const header = headers + index * PROGRAM_HEADER_BYTES;
    return {
      type: read(image, header, 4),
      offset: read(image, header + 0x08, 8),
      address: read(image, header + 0x10, 8),
      size: read(image, header + 0x28, 8),
    };
  });
}

function entriesOf(image: Uint8Array, frame: Section): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (;;) {
    const length = read(image, frame.offset + cursor, 4);
    if (length === 0) break;
    starts.push(cursor);
    cursor += length + 4;
  }
  expect(cursor + 4).toBe(frame.size);
  return starts;
}

describe("the eh_frame an elf image carries", () => {
  it("opens with the canonical version 1 augmented cie", () => {
    const image = imageOf("object");
    const frame = sectionNamed(image, ".eh_frame");
    const bytes = image.slice(frame.offset, frame.offset + CIE_BYTES);

    expect(read(bytes, 0, 4)).toBe(CIE_BYTES - 4);
    expect(read(bytes, 4, 4)).toBe(0);
    expect(bytes[8]).toBe(1);
    expect(new TextDecoder().decode(bytes.slice(9, 11))).toBe("zR");
    expect([...bytes.slice(12, 16)]).toEqual([1, 0x78, 16, 1]);
    expect(bytes[16]).toBe(DW_EH_PE_PCREL_SDATA4);
    expect([...bytes.slice(17, 22)]).toEqual([0x0c, 7, 8, 0x90, 1]);
  });

  it("describes every compiled function with an fde that points back at the cie", () => {
    const image = imageOf("object");
    const frame = sectionNamed(image, ".eh_frame");
    const entries = entriesOf(image, frame);

    expect(entries[0]).toBe(0);
    expect(entries.length).toBeGreaterThan(1);
    for (const start of entries.slice(1)) {
      expect(read(image, frame.offset + start + 4, 4)).toBe(start + 4);
      expect(read(image, frame.offset + start + 12, 4)).toBeGreaterThan(0);
      expect(image[frame.offset + start + FDE_PREFIX_BYTES]).toBe(0);
    }
  });

  it("relocates each fde onto the function it describes", () => {
    const image = imageOf("object");
    const frame = sectionNamed(image, ".eh_frame");
    const relocations = sectionNamed(image, ".rela.eh_frame");
    const count = relocations.size / relocations.entrySize;

    expect(count).toBe(entriesOf(image, frame).length - 1);
    for (let index = 0; index < count; index++) {
      const entry = relocations.offset + index * relocations.entrySize;
      expect(read(image, entry, 8) % 8).toBe(0);
      expect(read(image, entry + 8, 4)).toBe(2);
      expect(read(image, entry + 16, 8)).toBe(0);
    }
  });

  it("advances the frame address in step with the prologue it describes", () => {
    const image = imageOf("object");
    const frame = sectionNamed(image, ".eh_frame");
    const described = entriesOf(image, frame)
      .slice(1)
      .map((start) => image.slice(frame.offset + start + 17, frame.offset + start + 22));

    expect(described.length).toBeGreaterThan(0);
    for (const first of described) {
      expect(first[0]).toBe(0x04);
      expect(read(first, 1, 4)).toBeGreaterThan(0);
    }
  });

  it("hands the unwinder a searchable header segment", () => {
    const image = imageOf("executable");
    const segment = segmentsOf(image).find((item) => item.type === PT_GNU_EH_FRAME);

    expect(segment).toBeDefined();
    const header = segment!.offset;
    expect(image[header]).toBe(1);
    expect([...image.slice(header + 1, header + 4)]).toEqual([0x1b, 0x03, 0x3b]);
    const count = read(image, header + 8, 4);
    expect(count).toBeGreaterThan(0);
    expect(segment!.size).toBe(12 + count * 8);
  });

  it("sorts the search table and lands every row inside the frames it indexes", () => {
    const image = imageOf("executable");
    const segment = segmentsOf(image).find((item) => item.type === PT_GNU_EH_FRAME)!;
    const header = segment.offset;
    const frames = segment.address + 4 + signed(image, header + 4);
    const count = read(image, header + 8, 4);

    const rows = Array.from({ length: count }, (_unused, index) => ({
      pc: segment.address + signed(image, header + 12 + index * 8),
      fde: segment.address + signed(image, header + 16 + index * 8),
    }));
    expect(rows.map((row) => row.pc)).toEqual([...rows.map((row) => row.pc)].sort((a, b) => a - b));
    for (const row of rows) {
      expect(row.fde).toBeGreaterThanOrEqual(frames + CIE_BYTES);
      const at = row.fde + header - segment.address;
      expect(row.fde + 8 + signed(image, at + 8)).toBe(row.pc);
    }
  });
});
