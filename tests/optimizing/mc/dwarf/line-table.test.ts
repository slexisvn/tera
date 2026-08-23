import { describe, expect, it } from "vitest";
import { bytesFragment, type McBytesFragment } from "../../../../src/optimizing/mc/fragment.js";
import { McModule } from "../../../../src/optimizing/mc/module.js";
import { layoutModule } from "../../../../src/optimizing/mc/layout.js";
import { x64McTarget } from "../../../../src/optimizing/backends/x64/mc/target.js";
import { X64_ABSOLUTE_64 } from "../../../../src/optimizing/backends/x64/mc/fixups.js";
import {
  appendDebugLine,
  DEBUG_ABBREV_SECTION,
  DEBUG_INFO_SECTION,
  DEBUG_LINE_SECTION,
  type DebugLineTarget,
  type SourceUnit,
} from "../../../../src/optimizing/mc/dwarf/line-table.js";
import { TEXT_SECTION } from "../../../../src/optimizing/mc/assembler.js";

const TARGET: DebugLineTarget = { addressFixup: X64_ABSOLUTE_64, addressBytes: 8 };

const LENGTH_BYTES = 4;
const VERSION_BYTES = 2;
const DW_LNS_FIXED_ADVANCE_PC = 0x09;
const DW_LNE_END_SEQUENCE = 0x01;
const OPCODE_BASE = 13;
const STANDARD_OPCODE_LENGTHS = [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1];
const FILE = "loop.tera";

interface Built {
  readonly module: McModule;
  readonly bytes: number[];
  readonly units: readonly SourceUnit[];
}

function code(bytes: number): McBytesFragment {
  return bytesFragment(new Array<number>(bytes).fill(0x90));
}

function build(shapes: readonly (readonly [string, readonly (readonly [number, number])[]])[]): Built {
  const module = new McModule();
  const text = module.section(TEXT_SECTION, "text", 16);
  const units: SourceUnit[] = [];
  for (const [symbol, rows] of shapes) {
    const entry = text.add(bytesFragment([]));
    module.symbols.define(symbol, entry, "global", "function");
    const lines = rows.map(([line, bytes]) => ({
      fragment: text.add(code(bytes)),
      source: { file: FILE, line, column: 1 },
    }));
    units.push({ symbol, entry, end: text.add(bytesFragment([])), lines });
  }
  module.afterLayout.push(appendDebugLine(module, TARGET, units));
  layoutModule(module, x64McTarget, { mode: "object" });
  const section = module.sections.find((candidate) => candidate.name === DEBUG_LINE_SECTION)!;
  return { module, bytes: [...section.contents()], units };
}

function integerAt(bytes: readonly number[], at: number, width: number): number {
  let value = 0;
  for (let index = width - 1; index >= 0; index--) value = value * 0x100 + bytes[at + index]!;
  return value;
}

function programStart(bytes: readonly number[]): number {
  const headerLength = integerAt(bytes, LENGTH_BYTES + VERSION_BYTES, LENGTH_BYTES);
  return LENGTH_BYTES + VERSION_BYTES + LENGTH_BYTES + headerLength;
}

function skipLeb(bytes: readonly number[], at: number): number {
  let cursor = at;
  while ((bytes[cursor]! & 0x80) !== 0) cursor++;
  return cursor + 1;
}

function readLeb(bytes: readonly number[], at: number): number {
  let value = 0;
  let shift = 0;
  let cursor = at;
  for (;;) {
    const digit = bytes[cursor++]!;
    value |= (digit & 0x7f) << shift;
    if ((digit & 0x80) === 0) return value;
    shift += 7;
  }
}

type Step = { readonly kind: "advance"; readonly value: number } | { readonly kind: "end" };

function walk(bytes: readonly number[]): Step[] {
  const steps: Step[] = [];
  let at = programStart(bytes);
  while (at < bytes.length) {
    const opcode = bytes[at++]!;
    if (opcode === 0) {
      const length = readLeb(bytes, at);
      at = skipLeb(bytes, at);
      if (bytes[at] === DW_LNE_END_SEQUENCE) steps.push({ kind: "end" });
      at += length;
      continue;
    }
    if (opcode === DW_LNS_FIXED_ADVANCE_PC) {
      steps.push({ kind: "advance", value: integerAt(bytes, at, 2) });
      at += 2;
      continue;
    }
    if (opcode >= OPCODE_BASE) continue;
    for (let operand = 0; operand < STANDARD_OPCODE_LENGTHS[opcode - 1]!; operand++) {
      at = skipLeb(bytes, at);
    }
  }
  return steps;
}

function advancesIn(bytes: readonly number[]): number[] {
  return walk(bytes).flatMap((step) => (step.kind === "advance" ? [step.value] : []));
}

describe("dwarf line table", () => {
  it("writes no section when nothing carries a position", () => {
    const module = new McModule();
    module.section(TEXT_SECTION, "text", 16).add(code(4));
    appendDebugLine(module, TARGET, [
      { symbol: "bare", entry: code(0), end: code(0), lines: [] },
    ]);

    expect(module.sections.map((section) => section.name)).toEqual([TEXT_SECTION]);
  });

  it("agrees with its own unit and header length fields", () => {
    const { bytes } = build([["hot", [[4, 3], [5, 6]]]]);

    expect(integerAt(bytes, 0, LENGTH_BYTES)).toBe(bytes.length - LENGTH_BYTES);
    const headerLength = integerAt(bytes, LENGTH_BYTES + VERSION_BYTES, LENGTH_BYTES);
    const program = LENGTH_BYTES + VERSION_BYTES + LENGTH_BYTES + headerLength;
    expect(program).toBeLessThan(bytes.length);
    expect(bytes[program]).toBe(0x00);
  });

  it("ends every function with its own sequence", () => {
    const { bytes } = build([
      ["hot", [[4, 3]]],
      ["cold", [[9, 5]]],
    ]);

    expect(walk(bytes).filter((step) => step.kind === "end")).toHaveLength(2);
  });

  it("relocates the start of each sequence against the function it describes", () => {
    const { module } = build([
      ["hot", [[4, 3]]],
      ["cold", [[9, 5]]],
    ]);
    const entries = module.relocations.filter(
      (entry) => entry.section.name === DEBUG_LINE_SECTION,
    );

    expect(entries.map((entry) => entry.symbol)).toEqual(["hot", "cold"]);
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(new Set([X64_ABSOLUTE_64]));
  });

  it("advances by the distance the code actually took", () => {
    const { bytes, units } = build([["hot", [[4, 3], [5, 6], [6, 2]]]]);
    const unit = units[0]!;
    const reached = [...unit.lines.map((row) => row.fragment), unit.end];
    const expected = reached.map((fragment, at) =>
      at === 0 ? fragment.address - unit.entry.address : fragment.address - reached[at - 1]!.address,
    );

    expect(advancesIn(bytes)).toEqual(expected);
  });

  it("describes the whole program in one compile unit", () => {
    const { module } = build([
      ["hot", [[4, 3]]],
      ["cold", [[9, 5]]],
    ]);
    const named = module.sections.map((section) => section.name);

    expect(named).toContain(DEBUG_INFO_SECTION);
    expect(named).toContain(DEBUG_ABBREV_SECTION);
    expect(
      module.relocations.filter((entry) => entry.section.name === DEBUG_INFO_SECTION),
    ).toHaveLength(1);
  });

  it("keeps its sections out of anything the loader maps", () => {
    const { module } = build([["hot", [[4, 3]]]]);
    const debug = module.sections.filter((section) => section.name.startsWith(".debug"));

    expect(debug).toHaveLength(3);
    for (const section of debug) expect(section.kind).toBe("debug");
  });
});
