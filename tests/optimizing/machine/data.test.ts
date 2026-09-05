import { describe, expect, it } from "vitest";
import {
  asciiData,
  dataItemBytes,
  dataItemSize,
  dataItemText,
  machineDataText,
  utf16Data,
  type MachineDataItem,
} from "../../../src/optimizing/machine/data.js";
import { TEXT_UNIT_BYTES } from "../../../src/optimizing/types/scalar.js";
import type { MachineDatum } from "../../../src/optimizing/machine/ir.js";

const DELETE_BYTE = 0x7f;
const NON_ASCII_TEXT = "Xin chào";
const DELETE_TEXT = `end${String.fromCharCode(DELETE_BYTE)}stop`;
const READ_ONLY_SECTION = "\t.section .rodata";
const WRITABLE_SECTION = "\t.data";

function literalOf(item: MachineDataItem): string {
  const text = dataItemText(item);
  return text.slice(text.indexOf('"') + 1, text.length - 1);
}

function spelledByteCount(literal: string): number {
  let bytes = 0;
  for (let at = 0; at < literal.length; at++) {
    if (literal[at] === "\\") at += /^[0-7]{3}$/.test(literal.slice(at + 1, at + 4)) ? 3 : 1;
    bytes++;
  }
  return bytes;
}

function datum(items: readonly MachineDataItem[]): MachineDatum {
  return { label: "greeting", alignment: 1, items, writable: false };
}

describe("dataItemText escaping", () => {
  it("spells a non-ASCII character as the octal escapes of its UTF-8 bytes", () => {
    expect(dataItemText(asciiData(NON_ASCII_TEXT))).toBe('\t.asciz "Xin ch\\303\\240o"');
  });

  it("escapes the delete byte that sits just above the printable range", () => {
    expect(dataItemText(asciiData(DELETE_TEXT))).toBe('\t.asciz "end\\177stop"');
  });

  it("leaves nothing outside printable ASCII in the literal it emits", () => {
    for (const text of [NON_ASCII_TEXT, DELETE_TEXT, "π≈3", "naïve"]) {
      expect(literalOf(asciiData(text))).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("spells one unit per byte the datum will occupy", () => {
    const item = asciiData(NON_ASCII_TEXT, false);

    expect(spelledByteCount(literalOf(item))).toBe(dataItemBytes(item).length);
    expect(spelledByteCount(literalOf(item))).toBe(dataItemSize(item));
  });

  it("escapes the bytes of an unterminated run without adding a terminator", () => {
    const item = asciiData("é", false);

    expect(dataItemText(item)).toBe('\t.ascii "\\303\\251"');
    expect(dataItemBytes(item)).toEqual([0xc3, 0xa9]);
  });

  it("keeps a quote and a backslash escaped alongside the octal bytes", () => {
    expect(dataItemText(asciiData('sa"y\\ô'))).toBe('\t.asciz "sa\\"y\\\\\\303\\264"');
  });
});

describe("machineDataText escaping", () => {
  it("carries the escaped literal into the section it lays the datum out in", () => {
    const text = machineDataText([datum([asciiData(NON_ASCII_TEXT)])], {
      readOnly: READ_ONLY_SECTION,
      writable: WRITABLE_SECTION,
    });

    expect(text).toContain('\t.asciz "Xin ch\\303\\240o"');
    expect(text).not.toContain(NON_ASCII_TEXT);
  });
});

const SUPPLEMENTARY_TEXT = "done ✅ 🚀";

function shortsOf(text: string): number[] {
  const spelled = text.slice(text.indexOf(" ") + 1);
  return spelled.split(", ").map((unit) => Number.parseInt(unit, 16));
}

describe("dataItemText for text held as code units", () => {
  it("keeps a character outside ASCII as one unit rather than its UTF-8 bytes", () => {
    expect(shortsOf(dataItemText(utf16Data("à")))).toEqual(["à".charCodeAt(0), 0]);
    expect(dataItemBytes(asciiData("à", false))).toEqual([0xc3, 0xa0]);
  });

  it("spells a supplementary character as the surrogate pair it is stored as", () => {
    const rocket = "🚀";

    expect(shortsOf(dataItemText(utf16Data(rocket)))).toEqual([0xd83d, 0xde80, 0]);
  });

  it("lays every unit out low byte first and terminates the run", () => {
    expect(dataItemBytes(utf16Data("hà"))).toEqual([0x68, 0x00, 0xe0, 0x00, 0x00, 0x00]);
  });

  it("sizes the datum by the units it holds and the terminator", () => {
    for (const text of ["", "abc", SUPPLEMENTARY_TEXT]) {
      const item = utf16Data(text);

      expect(dataItemSize(item)).toBe((text.length + 1) * TEXT_UNIT_BYTES);
      expect(dataItemBytes(item)).toHaveLength(dataItemSize(item));
      expect(shortsOf(dataItemText(item))).toHaveLength(text.length + 1);
    }
  });

  it("carries the units into the section it lays the datum out in", () => {
    const text = machineDataText([datum([utf16Data(NON_ASCII_TEXT)])], {
      readOnly: READ_ONLY_SECTION,
      writable: WRITABLE_SECTION,
    });

    expect(text).toContain("\t.short ");
    expect(text).not.toContain(NON_ASCII_TEXT);
  });
});
