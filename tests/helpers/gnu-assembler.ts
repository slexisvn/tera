import { spawnSync } from "node:child_process";
import { removeDirectory } from "./workspace.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { runsToolchain } from "./native-tier.js";

const COMPILERS = ["cc", "gcc", "clang"];
const COPIERS = ["objcopy", "llvm-objcopy"];

interface Toolchain {
  readonly compiler: string;
  readonly copier: string;
}

function inBuildDirectory<T>(use: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "tera-gas-"));
  try {
    return use(directory);
  } finally {
    removeDirectory(directory);
  }
}

function locate(candidates: readonly string[], probe: (name: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  return null;
}

function detect(): Toolchain | null {
  return inBuildDirectory((directory) => {
    const source = join(directory, "probe.s");
    const object = join(directory, "probe.o");
    writeFileSync(source, "\t.text\n\tret\n");
    const compiler = locate(COMPILERS, (name) => {
      const built = spawnSync(name, ["-c", source, "-o", object], { encoding: "utf8" });
      return built.status === 0;
    });
    if (compiler === null) return null;
    const copier = locate(COPIERS, (name) => {
      const copied = spawnSync(
        name,
        ["-O", "binary", "--only-section=.text", object, join(directory, "probe.bin")],
        { encoding: "utf8" },
      );
      return copied.status === 0;
    });
    if (copier === null) return null;
    return { compiler, copier };
  });
}

export const gnuToolchain = runsToolchain ? detect() : null;

export const itAssembles = it.skipIf(gnuToolchain === null);

export function assembleText(text: string): Uint8Array {
  if (gnuToolchain === null) throw new Error("no assembler toolchain is available");
  return inBuildDirectory((directory) => {
    const source = join(directory, "unit.s");
    const object = join(directory, "unit.o");
    const binary = join(directory, "unit.bin");
    writeFileSync(source, `\t.text\n${text}\n`);
    const built = spawnSync(gnuToolchain.compiler, ["-c", source, "-o", object], {
      encoding: "utf8",
    });
    if (built.status !== 0) {
      throw new Error(`assembling failed:\n${built.stderr}\n${text}`);
    }
    const copied = spawnSync(
      gnuToolchain.copier,
      ["-O", "binary", "--only-section=.text", object, binary],
      { encoding: "utf8" },
    );
    if (copied.status !== 0) {
      throw new Error(`extracting .text failed:\n${copied.stderr}`);
    }
    return new Uint8Array(readFileSync(binary));
  });
}

export interface DecodedLine {
  readonly file: string;
  readonly line: number;
  readonly address: number;
}

const DECODED_LINE = /^(\S+)\s+(\d+)\s+(0x[0-9a-f]+)/;
const OBJDUMPS = ["objdump", "llvm-objdump"];

function decodedLinesAt(path: string): DecodedLine[] {
  const dumper = locate(OBJDUMPS, (name) => {
    const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
    return probe.status === 0;
  });
  if (dumper === null) throw new Error("no objdump is available");
  const dumped = spawnSync(dumper, ["--dwarf=decodedline", path], { encoding: "utf8" });
  if (dumped.status !== 0) throw new Error(`decoding lines failed:\n${dumped.stderr}`);
  const rows: DecodedLine[] = [];
  for (const row of dumped.stdout.split("\n")) {
    const match = DECODED_LINE.exec(row.trim());
    if (match !== null) {
      rows.push({ file: match[1]!, line: Number(match[2]), address: Number(match[3]) });
    }
  }
  return rows;
}

export function decodedLinesOf(text: string): DecodedLine[] {
  if (gnuToolchain === null) throw new Error("no assembler toolchain is available");
  return inBuildDirectory((directory) => {
    const source = join(directory, "unit.s");
    const object = join(directory, "unit.o");
    writeFileSync(source, text);
    const built = spawnSync(gnuToolchain.compiler, ["-c", source, "-o", object], {
      encoding: "utf8",
    });
    if (built.status !== 0) throw new Error(`assembling failed:\n${built.stderr}`);
    return decodedLinesAt(object);
  });
}

export function decodedLinesOfImage(image: Uint8Array, extension: string): DecodedLine[] {
  return inBuildDirectory((directory) => {
    const path = join(directory, `image.${extension}`);
    writeFileSync(path, image);
    return decodedLinesAt(path);
  });
}

export function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
}

export function extractSection(image: Uint8Array, section: string): Uint8Array {
  if (gnuToolchain === null) throw new Error("no assembler toolchain is available");
  return inBuildDirectory((directory) => {
    const source = join(directory, "image.o");
    const binary = join(directory, "image.bin");
    writeFileSync(source, image);
    const copied = spawnSync(
      gnuToolchain.copier,
      ["-O", "binary", `--only-section=${section}`, source, binary],
      { encoding: "utf8" },
    );
    if (copied.status !== 0) throw new Error(`extracting ${section} failed:\n${copied.stderr}`);
    return new Uint8Array(readFileSync(binary));
  });
}

export interface LinkedRun {
  readonly status: number | null;
  readonly stdout: string;
}

export function linkAndRun(
  object: Uint8Array,
  objectName: string,
  main: string,
  headers: ReadonlyMap<string, string>,
): LinkedRun {
  if (gnuToolchain === null) throw new Error("no assembler toolchain is available");
  return inBuildDirectory((directory) => {
    const objectPath = join(directory, objectName);
    const mainPath = join(directory, "main.c");
    const program = join(directory, process.platform === "win32" ? "linked.exe" : "linked.out");
    writeFileSync(objectPath, object);
    writeFileSync(mainPath, main);
    for (const [name, contents] of headers) writeFileSync(join(directory, name), contents);
    const built = spawnSync(gnuToolchain.compiler, [mainPath, objectPath, "-o", program], {
      encoding: "utf8",
    });
    if (built.status !== 0) throw new Error(`linking failed:\n${built.stderr}`);
    const run = spawnSync(program, [], { encoding: "utf8" });
    return { status: run.status, stdout: run.stdout ?? "" };
  });
}

const READERS = ["readelf", "llvm-readelf"];
const DUMPERS = ["objdump", "llvm-objdump"];

function version(name: string): boolean {
  return spawnSync(name, ["--version"], { encoding: "utf8" }).status === 0;
}

export const elfReader = runsToolchain ? locate(READERS, version) : null;

export const objectDumper = runsToolchain ? locate(DUMPERS, version) : null;

export const itReadsElf = it.skipIf(elfReader === null);

export const itDumpsObjects = it.skipIf(objectDumper === null);

export interface ImageReport {
  readonly output: string;
  readonly failed: boolean;
}

function report(
  tool: string | null,
  image: Uint8Array,
  name: string,
  flags: readonly string[],
): ImageReport {
  if (tool === null) throw new Error(`no reader is available for ${name}`);
  return inBuildDirectory((directory) => {
    const path = join(directory, name);
    writeFileSync(path, image);
    const run = spawnSync(tool, [...flags, path], { encoding: "utf8" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    return {
      output,
      failed: run.status !== 0 || /Error:|Warning:|unable to|corrupt/i.test(output),
    };
  });
}

export function inspectElf(image: Uint8Array, flags: readonly string[]): ImageReport {
  return report(elfReader, image, "image.elf", flags);
}

export function inspectPe(image: Uint8Array, flags: readonly string[]): ImageReport {
  return report(objectDumper, image, "image.exe", flags);
}

export function dumpObject(image: Uint8Array, flags: readonly string[]): ImageReport {
  return report(objectDumper, image, "image.o", flags);
}
