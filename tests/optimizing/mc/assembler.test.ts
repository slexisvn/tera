import { describe, expect, it } from "vitest";
import {
  BSS_SECTION,
  DATA_SECTION,
  RODATA_SECTION,
  TEXT_SECTION,
  assembleData,
  assembleFunction,
  assembleRoutine,
} from "../../../src/optimizing/mc/assembler.js";
import { McModule } from "../../../src/optimizing/mc/module.js";
import {
  MachineFunction,
  instruction,
  label,
  type MachineDatum,
  type MachineInstruction,
} from "../../../src/optimizing/machine/ir.js";
import { asciiData, integerData, zeroData } from "../../../src/optimizing/machine/data.js";
import { x64McTarget } from "../../../src/optimizing/backends/x64/mc/target.js";
import type { McFragment } from "../../../src/optimizing/mc/fragment.js";

function returning(name: string, blocks: readonly (readonly MachineInstruction[])[]): MachineFunction {
  const fn = new MachineFunction(name, name);
  blocks.forEach((body, index) => {
    const block = fn.createBlock(`.L${name}_${index}`);
    for (const node of body) block.instructions.push(node);
  });
  return fn;
}

function datumOf(
  label: string,
  items: MachineDatum["items"],
  writable: boolean,
  alignment = 8,
): MachineDatum {
  return { label, alignment, items, writable };
}

const kindsOf = (fragments: readonly McFragment[]): readonly string[] =>
  fragments.map((fragment) => fragment.kind);

describe("assembling a machine function into a module", () => {
  it("defines the function symbol at the fragment its first block starts on", () => {
    const module = new McModule();
    const assembled = assembleFunction(module, x64McTarget, returning("probe", [[instruction("ret", [])]]));

    expect(module.symbols.lookup("probe")?.definition?.fragment).toBe(assembled.entry);
    expect(module.symbols.lookup("probe")?.kind).toBe("function");
  });

  it("puts the function in the text section at the target's function alignment", () => {
    const module = new McModule();
    const assembled = assembleFunction(module, x64McTarget, returning("probe", [[instruction("ret", [])]]));

    expect(assembled.section.name).toBe(TEXT_SECTION);
    expect(assembled.section.kind).toBe("text");
    expect(assembled.section.alignment).toBe(x64McTarget.functionAlignment);
  });

  it("opens the function with an alignment fragment so the entry lands on a boundary", () => {
    const module = new McModule();
    const assembled = assembleFunction(module, x64McTarget, returning("probe", [[instruction("ret", [])]]));

    expect(kindsOf(assembled.section.fragments)[0]).toBe("align");
  });

  it("gives the section the target's padding rather than leaving it zero-filled", () => {
    const module = new McModule();
    const assembled = assembleFunction(module, x64McTarget, returning("probe", [[instruction("ret", [])]]));

    expect(assembled.section.padding).toBe(x64McTarget.padding);
  });

  it("counts every instruction it placed, across every block", () => {
    const module = new McModule();
    const assembled = assembleFunction(
      module,
      x64McTarget,
      returning("probe", [[instruction("nop", []), instruction("nop", [])], [instruction("ret", [])]]),
    );

    expect(assembled.instructions).toBe(3);
  });

  it("counts nothing for a function whose blocks hold no instructions", () => {
    const module = new McModule();
    const assembled = assembleFunction(module, x64McTarget, returning("probe", [[], []]));

    expect(assembled.instructions).toBe(0);
  });

  it("defines a local label for every block so a branch can name it", () => {
    const module = new McModule();
    assembleFunction(
      module,
      x64McTarget,
      returning("probe", [[instruction("nop", [])], [instruction("ret", [])]]),
    );

    for (const name of [".Lprobe_0", ".Lprobe_1"]) {
      expect(module.symbols.lookup(name)?.binding).toBe("local");
      expect(module.symbols.lookup(name)?.definition).not.toBeNull();
    }
  });

  it("binds the function globally unless the caller asks otherwise", () => {
    const module = new McModule();
    assembleFunction(module, x64McTarget, returning("probe", [[instruction("ret", [])]]));

    expect(module.symbols.lookup("probe")?.binding).toBe("global");
  });

  it("binds the function locally when the caller asks for it", () => {
    const module = new McModule();
    assembleFunction(module, x64McTarget, returning("probe", [[instruction("ret", [])]]), "local");

    expect(module.symbols.lookup("probe")?.binding).toBe("local");
  });

  it("references every symbol an encoded fixup names, so nothing links undefined by accident", () => {
    const module = new McModule();
    const fn = returning("probe", []);
    const start = fn.createBlock(".Lprobe_start");
    const landing = fn.createBlock(".Lprobe_landing");
    start.instructions.push(instruction("jmp", [label(landing)], { terminator: true }));
    landing.instructions.push(instruction("ret", []));
    assembleFunction(module, x64McTarget, fn);

    expect(module.symbols.lookup(".Lprobe_landing")).toBeDefined();
    expect(module.symbols.undefinedSymbols).toEqual([]);
  });

  it("shares one text section between two functions assembled into the same module", () => {
    const module = new McModule();
    const first = assembleFunction(module, x64McTarget, returning("one", [[instruction("ret", [])]]));
    const second = assembleFunction(module, x64McTarget, returning("two", [[instruction("ret", [])]]));

    expect(second.section).toBe(first.section);
    expect(module.sections).toHaveLength(1);
  });

  it("keeps the two functions' entries apart inside that shared section", () => {
    const module = new McModule();
    const first = assembleFunction(module, x64McTarget, returning("one", [[instruction("ret", [])]]));
    const second = assembleFunction(module, x64McTarget, returning("two", [[instruction("ret", [])]]));

    expect(second.entry).not.toBe(first.entry);
    expect(module.symbols.lookup("one")?.definition?.fragment).toBe(first.entry);
    expect(module.symbols.lookup("two")?.definition?.fragment).toBe(second.entry);
  });
});

describe("assembling a runtime routine that has no blocks", () => {
  it("defines the routine symbol at its entry", () => {
    const module = new McModule();
    const assembled = assembleRoutine(module, x64McTarget, "tera_helper", [instruction("ret", [])]);

    expect(module.symbols.lookup("tera_helper")?.definition?.fragment).toBe(assembled.entry);
    expect(module.symbols.lookup("tera_helper")?.kind).toBe("function");
  });

  it("binds the routine locally unless the caller asks otherwise", () => {
    const module = new McModule();
    assembleRoutine(module, x64McTarget, "tera_helper", [instruction("ret", [])]);

    expect(module.symbols.lookup("tera_helper")?.binding).toBe("local");
  });

  it("binds the routine globally when the caller asks for it", () => {
    const module = new McModule();
    assembleRoutine(module, x64McTarget, "tera_helper", [instruction("ret", [])], "global");

    expect(module.symbols.lookup("tera_helper")?.binding).toBe("global");
  });

  it("counts the body it was handed and defines no block labels", () => {
    const module = new McModule();
    const assembled = assembleRoutine(module, x64McTarget, "tera_helper", [
      instruction("nop", []),
      instruction("ret", []),
    ]);

    expect(assembled.instructions).toBe(2);
    expect(module.symbols.symbols.map((symbol) => symbol.name)).toEqual(["tera_helper"]);
  });

  it("shares the text section with a function already assembled", () => {
    const module = new McModule();
    const fn = assembleFunction(module, x64McTarget, returning("probe", [[instruction("ret", [])]]));
    const routine = assembleRoutine(module, x64McTarget, "tera_helper", [instruction("ret", [])]);

    expect(routine.section).toBe(fn.section);
  });
});

describe("placing data a machine function refers to", () => {
  it("puts a read-only datum in rodata", () => {
    const module = new McModule();
    assembleData(module, [datumOf(".LC0", [integerData(7, 8)], false)]);

    expect(module.sections.map((section) => section.name)).toEqual([RODATA_SECTION]);
    expect(module.sections[0]!.kind).toBe("rodata");
  });

  it("puts a writable datum that carries content in data", () => {
    const module = new McModule();
    assembleData(module, [datumOf(".LD0", [integerData(7, 8)], true)]);

    expect(module.sections.map((section) => section.name)).toEqual([DATA_SECTION]);
    expect(module.sections[0]!.kind).toBe("data");
  });

  it("puts a writable datum that is nothing but zeroes in bss", () => {
    const module = new McModule();
    assembleData(module, [datumOf(".LB0", [zeroData(16), zeroData(8)], true)]);

    expect(module.sections.map((section) => section.name)).toEqual([BSS_SECTION]);
    expect(module.sections[0]!.kind).toBe("bss");
  });

  it("keeps a read-only run of zeroes out of bss, which only holds writable storage", () => {
    const module = new McModule();
    assembleData(module, [datumOf(".LC0", [zeroData(16)], false)]);

    expect(module.sections.map((section) => section.name)).toEqual([RODATA_SECTION]);
  });

  it("keeps a writable datum out of bss once one item carries content", () => {
    const module = new McModule();
    assembleData(module, [datumOf(".LD0", [zeroData(8), integerData(1, 8)], true)]);

    expect(module.sections.map((section) => section.name)).toEqual([DATA_SECTION]);
  });

  it("defines every datum's label as a local object", () => {
    const module = new McModule();
    assembleData(module, [
      datumOf(".LC0", [asciiData("hi", true)], false),
      datumOf(".LD0", [integerData(1, 4)], true),
    ]);

    for (const name of [".LC0", ".LD0"]) {
      expect(module.symbols.lookup(name)?.binding).toBe("local");
      expect(module.symbols.lookup(name)?.kind).toBe("object");
    }
  });

  it("writes the bytes the datum's items encode", () => {
    const module = new McModule();
    assembleData(module, [datumOf(".LC0", [asciiData("hi", true)], false)]);
    const bytes = module.sections[0]!.fragments.flatMap((fragment) =>
      fragment.kind === "bytes" ? fragment.bytes : [],
    );

    expect(bytes).toEqual([0x68, 0x69, 0x00]);
  });

  it("raises each section to the widest alignment any of its data asked for", () => {
    const module = new McModule();
    assembleData(module, [
      datumOf(".LC0", [integerData(1, 4)], false, 4),
      datumOf(".LC1", [integerData(1, 8)], false, 32),
    ]);

    expect(module.sections[0]!.alignment).toBe(32);
  });

  it("opens every datum with an alignment fragment of its own", () => {
    const module = new McModule();
    assembleData(module, [
      datumOf(".LC0", [integerData(1, 4)], false, 4),
      datumOf(".LC1", [integerData(1, 8)], false, 8),
    ]);

    expect(kindsOf(module.sections[0]!.fragments)).toEqual(["align", "bytes", "align", "bytes"]);
  });

  it("splits data across the sections their writability and content call for", () => {
    const module = new McModule();
    assembleData(module, [
      datumOf(".LC0", [integerData(1, 8)], false),
      datumOf(".LD0", [integerData(2, 8)], true),
      datumOf(".LB0", [zeroData(8)], true),
    ]);

    expect(module.sections.map((section) => section.name)).toEqual([
      RODATA_SECTION,
      DATA_SECTION,
      BSS_SECTION,
    ]);
  });

  it("creates no section at all for an empty list of data", () => {
    const module = new McModule();
    assembleData(module, []);

    expect(module.sections).toEqual([]);
  });
});
