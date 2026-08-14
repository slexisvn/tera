import { describe, expect, it } from "vitest";
import {
  MachineFunction,
  imm,
  instruction,
  mem,
  use,
  def,
  sym,
} from "../../../../src/optimizing/machine/ir.js";
import { assembleFunction } from "../../../../src/optimizing/mc/assembler.js";
import { McModule } from "../../../../src/optimizing/mc/module.js";
import {
  definePeImports,
  importAddressSymbol,
  layoutPeExecutable,
  writeCoffObject,
  writePeExecutable,
  PE_MACHINE_AMD64,
  type PeExecutableOptions,
  type PeImportLibrary,
} from "../../../../src/optimizing/mc/formats/pe.js";
import { layoutModule } from "../../../../src/optimizing/mc/layout.js";
import { x64McTarget } from "../../../../src/optimizing/backends/x64/mc/target.js";
import { x64Target } from "../../../../src/optimizing/backends/x64/target.js";
import { inspectPe, itDumpsObjects } from "../../../helpers/gnu-assembler.js";

const target = x64Target({ abi: "win64", format: "coff" });
const reg = (name: string) => target.registers.register(name);

const ENTRY = "_start";
const EXIT = "ExitProcess";
const IMAGE_BASE = 0x400000;
const PAGE = 0x1000;
const NEW_HEADER_FIELD = 0x3c;
const CHARACTERISTICS_FIELD = 18;
const OPTIONAL_HEADER_FIELD = 20;
const ENTRY_POINT_FIELD = OPTIONAL_HEADER_FIELD + 16;
const RELOCS_STRIPPED = 0x0001;
const INDIRECT_CALL = [0xff, 0x15];

const LIBRARIES: readonly PeImportLibrary[] = [
  { dll: "kernel32.dll", functions: [EXIT, "GetStdHandle"] },
];

const COFF_HEADER_BYTES = 20;
const SECTION_HEADER_BYTES = 40;
const SYMBOL_ENTRY_BYTES = 18;
const SYMBOL_TABLE_FIELD = 8;
const SYMBOL_COUNT_FIELD = 12;
const SECTION_NUMBER_FIELD = 12;
const STORAGE_CLASS_FIELD = 16;
const RAW_SIZE_FIELD = 16;
const RAW_POINTER_FIELD = 20;
const EXTERNAL_CLASS = 2;
const STATIC_CLASS = 3;
const UNDEFINED_SECTION = 0;
const TEXT_SECTION_NUMBER = 1;
const LONG_NAME_MARKER = 0;
const CALLER = "ask_for_it";
const UNDEFINED_SYMBOL = "external_answer";

function exiting(name: string, status: number): MachineFunction {
  const fn = new MachineFunction(name, name);
  const entry = fn.createBlock(`.L${name}_entry`);
  entry.instructions.push(instruction("movl", [def(reg("rcx"), 4), imm(status)]));
  entry.instructions.push(
    instruction("call", [mem(8, { symbol: importAddressSymbol(EXIT) })], {
      call: true,
      implicitFrom: 1,
    }),
  );
  return fn;
}

function calling(name: string, callee: string): MachineFunction {
  const fn = new MachineFunction(name, name);
  const entry = fn.createBlock(`.L${name}_entry`);
  entry.instructions.push(
    instruction("call", [sym(callee)], { call: true, implicitFrom: 1 }),
  );
  entry.instructions.push(
    instruction("ret", [use(reg("rax"), 4)], { returns: true, implicitFrom: 0 }),
  );
  return fn;
}

function prepared(...functions: readonly MachineFunction[]): {
  readonly module: McModule;
  readonly options: PeExecutableOptions;
} {
  const module = new McModule();
  for (const fn of functions) assembleFunction(module, x64McTarget, fn);
  const options: PeExecutableOptions = {
    machine: PE_MACHINE_AMD64,
    entrySymbol: ENTRY,
    imports: definePeImports(module, LIBRARIES),
  };
  layoutPeExecutable(module, x64McTarget, options);
  return { module, options };
}

function executableImage(): Uint8Array {
  const { module, options } = prepared(exiting(ENTRY, 0));
  return writePeExecutable(module, options);
}

function read32(image: Uint8Array, offset: number): number {
  return new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(
    offset,
    true,
  );
}

function read16(image: Uint8Array, offset: number): number {
  return new DataView(image.buffer, image.byteOffset, image.byteLength).getUint16(
    offset,
    true,
  );
}

function coffHeaderAt(image: Uint8Array): number {
  return read32(image, NEW_HEADER_FIELD) + 4;
}

describe("pe container", () => {
  it("opens with a dos header that points at the pe signature", () => {
    const image = executableImage();
    const signature = read32(image, NEW_HEADER_FIELD);

    expect([...image.subarray(0, 2)]).toEqual([...new TextEncoder().encode("MZ")]);
    expect([...image.subarray(signature, signature + 4)]).toEqual([0x50, 0x45, 0, 0]);
  });

  it("keeps a dos stub that refuses to run under dos", () => {
    const image = executableImage();
    const stub = new TextDecoder().decode(image.subarray(0, read32(image, NEW_HEADER_FIELD)));

    expect(stub).toContain("This program cannot be run in DOS mode.");
  });

  it("pins the image base by stripping relocations", () => {
    const image = executableImage();
    const characteristics = read16(image, coffHeaderAt(image) + CHARACTERISTICS_FIELD);

    expect(characteristics & RELOCS_STRIPPED).toBe(RELOCS_STRIPPED);
  });

  it("records the entry point rva of an entry that is not first in the text", () => {
    const { module, options } = prepared(exiting("ahead", 1), exiting(ENTRY, 0));
    const image = writePeExecutable(module, options);
    const entry = module.symbols.addressOf(ENTRY)! - IMAGE_BASE;

    expect(entry).toBeGreaterThan(PAGE);
    expect(read32(image, coffHeaderAt(image) + ENTRY_POINT_FIELD)).toBe(entry);
  });

  it("places the first section one page after the image base", () => {
    const { module } = prepared(exiting(ENTRY, 0));

    expect(module.symbols.addressOf(ENTRY)).toBe(IMAGE_BASE + PAGE);
  });

  it("refuses to write an executable that still has unresolved symbols", () => {
    const { module, options } = prepared(calling(ENTRY, "external_answer"));

    expect(() => writePeExecutable(module, options)).toThrow(
      /unresolved symbols: external_answer/,
    );
  });

  it("aims an indirect call at the address table slot of the import", () => {
    const { module } = prepared(exiting(ENTRY, 0));
    const text = module.sections.find((section) => section.kind === "text")!;
    const bytes = [...text.contents()];
    const at = bytes.findIndex(
      (_byte, index) =>
        bytes[index] === INDIRECT_CALL[0] && bytes[index + 1] === INDIRECT_CALL[1],
    );
    const instructionEnd = text.address + at + INDIRECT_CALL.length + 4;
    const displacement = new DataView(new Uint8Array(bytes).buffer).getInt32(
      at + INDIRECT_CALL.length,
      true,
    );

    expect(instructionEnd + displacement).toBe(
      module.symbols.addressOf(importAddressSymbol(EXIT)),
    );
  });
});

function objectImage(fn: MachineFunction): Uint8Array {
  const module = new McModule();
  assembleFunction(module, x64McTarget, fn);
  layoutModule(module, x64McTarget, { mode: "object" });
  return writeCoffObject(module, x64McTarget, { machine: PE_MACHINE_AMD64 });
}

function viewOf(image: Uint8Array): DataView {
  return new DataView(image.buffer, image.byteOffset, image.byteLength);
}

function sectionData(image: Uint8Array, name: string): Uint8Array {
  const view = viewOf(image);
  const decoder = new TextDecoder();
  for (let index = 0; index < view.getUint16(2, true); index++) {
    const at = COFF_HEADER_BYTES + index * SECTION_HEADER_BYTES;
    const label = decoder.decode(image.subarray(at, at + 8)).replace(/\0+$/, "");
    if (label !== name) continue;
    const offset = view.getUint32(at + RAW_POINTER_FIELD, true);
    return image.subarray(offset, offset + view.getUint32(at + RAW_SIZE_FIELD, true));
  }
  throw new Error(`the object has no ${name} section`);
}

interface CoffSymbol {
  readonly name: string;
  readonly section: number;
  readonly storageClass: number;
}

function symbolsOf(image: Uint8Array): readonly CoffSymbol[] {
  const view = viewOf(image);
  const decoder = new TextDecoder();
  const base = view.getUint32(SYMBOL_TABLE_FIELD, true);
  const count = view.getUint32(SYMBOL_COUNT_FIELD, true);
  const strings = base + count * SYMBOL_ENTRY_BYTES;
  const nameAt = (at: number): string => {
    if (view.getUint32(at, true) !== LONG_NAME_MARKER) {
      return decoder.decode(image.subarray(at, at + 8)).replace(/\0+$/, "");
    }
    const start = strings + view.getUint32(at + 4, true);
    return decoder.decode(image.subarray(start, image.indexOf(0, start)));
  };
  return Array.from({ length: count }, (_unused, index) => {
    const at = base + index * SYMBOL_ENTRY_BYTES;
    return {
      name: nameAt(at),
      section: view.getInt16(at + SECTION_NUMBER_FIELD, true),
      storageClass: image[at + STORAGE_CLASS_FIELD]!,
    };
  });
}

function storing(name: string, slot: string): MachineFunction {
  const fn = new MachineFunction(name, name);
  const entry = fn.createBlock(`.L${name}_entry`);
  entry.instructions.push(instruction("movq", [mem(8, { symbol: slot }), imm(0)]));
  entry.instructions.push(
    instruction("ret", [use(reg("rax"), 4)], { returns: true, implicitFrom: 0 }),
  );
  return fn;
}

describe("coff object", () => {
  it("leaves the field of a call to an undefined symbol empty", () => {
    const text = sectionData(objectImage(calling(CALLER, UNDEFINED_SYMBOL)), ".text");

    expect([...text.subarray(1, 5)]).toEqual([0, 0, 0, 0]);
  });

  it("measures the addend of a displacement an immediate follows from the field end", () => {
    const text = sectionData(objectImage(storing("store", "external_slot")), ".text");

    expect(viewOf(text).getInt32(3, true)).toBe(-4);
  });

  it("publishes a defined function as external and its labels as static", () => {
    const symbols = symbolsOf(objectImage(calling(CALLER, UNDEFINED_SYMBOL)));

    expect(symbols).toContainEqual({
      name: CALLER,
      section: TEXT_SECTION_NUMBER,
      storageClass: EXTERNAL_CLASS,
    });
    expect(symbols).toContainEqual({
      name: `.L${CALLER}_entry`,
      section: TEXT_SECTION_NUMBER,
      storageClass: STATIC_CLASS,
    });
  });

  it("names a symbol it never defines external and section-less", () => {
    const symbols = symbolsOf(objectImage(calling(CALLER, UNDEFINED_SYMBOL)));

    expect(symbols).toContainEqual({
      name: UNDEFINED_SYMBOL,
      section: UNDEFINED_SECTION,
      storageClass: EXTERNAL_CLASS,
    });
  });
});

describe("pe container read back by binutils", () => {
  itDumpsObjects("produces a header binutils reads as a 64 bit windows image", () => {
    const report = inspectPe(executableImage(), ["-f"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("pei-x86-64");
  });

  itDumpsObjects("names every section it writes", () => {
    const report = inspectPe(executableImage(), ["-h"]);

    expect(report.failed).toBe(false);
    for (const name of [".text", ".idata"]) expect(report.output).toContain(name);
  });

  itDumpsObjects("describes a console subsystem image with stripped relocations", () => {
    const report = inspectPe(executableImage(), ["-p"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("Windows CUI");
    expect(report.output).toContain("relocations stripped");
  });

  itDumpsObjects("publishes every imported function under its dll", () => {
    const report = inspectPe(executableImage(), ["-p"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("DLL Name: kernel32.dll");
    for (const name of LIBRARIES[0]!.functions) expect(report.output).toContain(name);
  });
});
