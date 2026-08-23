import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import {
  assembleText,
  dumpObject,
  inspectElf,
  itAssembles,
  itDumpsObjects,
  itReadsElf,
} from "../../../helpers/gnu-assembler.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";

const src = (...lines: string[]) => lines.join("\n");

const PROGRAM = src(
  "fn leaf(a: int, b: int) -> int:",
  "  return a * b + a - b",
  "fn spread(a: int, b: int, c: int, d: int, e: int, f: int) -> int:",
  "  t = leaf(a, b) + leaf(c, d) + leaf(e, f)",
  "  u = leaf(t, a) + leaf(t, b) + leaf(t, c)",
  "  return t + u + a + b + c + d + e + f",
  "print(spread(1, 2, 3, 4, 5, 6))",
  "",
);

function compile(backend: string, format: "assembly" | "object" | "executable") {
  const program = nodeEngine({ typecheck: "off" }).compileAot(PROGRAM, { backend, format });
  expect(program.skipped).toEqual([]);
  return program;
}

function fileOf(backend: string, format: "assembly" | "object" | "executable", extension: string) {
  const file = compile(backend, format).files.find((candidate) =>
    candidate.name.endsWith(extension),
  );
  if (file === undefined) throw new Error(`program has no ${extension} output`);
  return file.contents;
}

interface SavedBase {
  readonly at: number;
  readonly allocated: number;
  readonly saved: number;
}

function framesSavingBase(frames: string): readonly SavedBase[] {
  const found: SavedBase[] = [];
  for (const entry of frames.split(/\r?\n(?=[0-9a-f]{8} )/)) {
    const range = /FDE cie=[0-9a-f]+ pc=([0-9a-f]+)\.\./.exec(entry);
    const allocated = /DW_CFA_def_cfa_offset: (\d+)/.exec(entry);
    const saved = /DW_CFA_offset: r3 \(rbx\) at cfa-(\d+)/.exec(entry);
    if (range === null || allocated === null || saved === null) continue;
    found.push({
      at: Number.parseInt(range[1]!, 16),
      allocated: Number(allocated[1]),
      saved: Number(saved[1]),
    });
  }
  return found;
}

function baseSlotIn(code: string, at: number): number | null {
  const labelled = code.indexOf(`\n${at.toString(16).padStart(ADDRESS_DIGITS, "0")} <`);
  if (labelled < 0) return null;
  const body = code.slice(labelled).split(/\r?\n\r?\n/)[0]!;
  const stored = /mov\s+%rbx,(0x[0-9a-f]+)?\(%rsp\)/.exec(body);
  if (stored === null) return null;
  return stored[1] === undefined ? 0 : Number(stored[1]);
}

const ADDRESS_DIGITS = 16;

describe("unwind tables the host toolchain reads back", () => {
  itDumpsObjects("decodes our .eh_frame into the prologue we emitted", () => {
    const object = fileOf("x64-linux", "object", ".o") as Uint8Array;

    const dumped = dumpObject(object, ["--dwarf=frames"]);

    expect(dumped.failed).toBe(false);
    expect(dumped.output).toContain("Contents of the .eh_frame section");
    expect(dumped.output).toContain("Augmentation:          \"zR\"");
    expect(dumped.output).toContain("Data alignment factor: -8");
    expect(dumped.output).toContain("Return address column: 16");
    expect(dumped.output).toContain("DW_CFA_def_cfa: r7 (rsp) ofs 8");
    expect(dumped.output).toMatch(/FDE cie=00000000 pc=[0-9a-f]+[.][.][0-9a-f]+/);
    expect(dumped.output).toMatch(/DW_CFA_def_cfa_offset: \d+/);
    expect(dumped.output).not.toContain("cie=invalid");
  });

  itDumpsObjects("agrees with the machine code about where a register was saved", () => {
    const object = fileOf("x64-linux", "object", ".o") as Uint8Array;
    const frames = framesSavingBase(dumpObject(object, ["--dwarf=frames"]).output);
    const code = dumpObject(object, ["-d"]).output;

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const slot = baseSlotIn(code, frame.at);
      expect(slot).not.toBeNull();
      expect(frame.allocated - slot!).toBe(frame.saved);
    }
  });

  itReadsElf("hands the executable a GNU_EH_FRAME segment", () => {
    const image = fileOf("x64-linux", "executable", ".elf") as Uint8Array;

    const report = inspectElf(image, ["-lW"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("GNU_EH_FRAME");
  });

  itAssembles("emits call frame directives the assembler accepts", () => {
    const text = fileOf(hostBackendId()!, "assembly", ".s") as string;

    expect(text).toContain("\t.cfi_startproc");
    expect(() => assembleText(text)).not.toThrow();
  });
});
