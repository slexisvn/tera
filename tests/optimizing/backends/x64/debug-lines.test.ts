import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import {
  decodedLinesOf,
  decodedLinesOfImage,
  itAssembles,
} from "../../../helpers/gnu-assembler.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";

const HOST_TARGET = hostBackendId()!;
const SOURCE_NAME = "loop.tera";

const LOOP = [
  "fn hot(n: int) -> int:",
  "  acc: int = 0",
  "  i: int = 0",
  "  while i < n:",
  "    acc = acc + i",
  "    i = i + 1",
  "  return acc",
  "",
  "print(hot(4))",
].join("\n");

function assemblyOf(source: string, sourceName?: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: HOST_TARGET,
    ...(sourceName === undefined ? {} : { sourceName }),
  });
  expect(program.skipped).toEqual([]);
  const file = program.files.find((candidate) => candidate.name.endsWith(".s"))!;
  return String(file.contents);
}

function directivesOf(text: string, prefix: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
}

describe("source positions in emitted assembly", () => {
  it("names the file once and marks the line of each statement", () => {
    const assembly = assemblyOf(LOOP, SOURCE_NAME);

    expect(directivesOf(assembly, ".file")).toEqual([`.file 1 "${SOURCE_NAME}"`]);
    const marked = directivesOf(assembly, ".loc").map((line) => Number(line.split(" ")[2]));
    expect(new Set(marked)).toEqual(new Set([4, 5, 6, 7]));
  });

  it("marks no line when the program was never given a file name", () => {
    const assembly = assemblyOf(LOOP);

    expect(directivesOf(assembly, ".loc")).toEqual([]);
    expect(directivesOf(assembly, ".file")).toEqual([]);
  });

  it("repeats a mark only when the line changes", () => {
    const marked = directivesOf(assemblyOf(LOOP, SOURCE_NAME), ".loc");

    for (let at = 1; at < marked.length; at++) {
      expect(marked[at]).not.toBe(marked[at - 1]);
    }
  });

  itAssembles("decodes back to the statements it came from", () => {
    const rows = decodedLinesOf(assemblyOf(LOOP, SOURCE_NAME));
    const forLoop = rows.filter((row) => row.file === SOURCE_NAME);

    expect(forLoop).not.toEqual([]);
    expect(new Set(forLoop.map((row) => row.line))).toEqual(new Set([4, 5, 6, 7]));
    for (let at = 1; at < forLoop.length; at++) {
      expect(forLoop[at]!.address).toBeGreaterThan(forLoop[at - 1]!.address);
    }
  });
});

function compiled(backend: string, format: "object" | "executable"): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${LOOP}\n`, {
    backend,
    format,
    sourceName: SOURCE_NAME,
  });
  expect(program.skipped).toEqual([]);
  return program;
}

function imageOf(backend: string, format: "object" | "executable"): Uint8Array {
  const file = compiled(backend, format).files.find(
    (candidate) => !candidate.name.endsWith(".h"),
  )!;
  return file.contents as Uint8Array;
}

describe("source positions in the containers tera writes itself", () => {
  const CONTAINERS = [
    ["a coff object", "x64-windows", "object", "obj"],
    ["an elf object", "x64-linux", "object", "o"],
    ["a pe executable", "x64-windows", "executable", "exe"],
  ] as const;

  itAssembles.each(CONTAINERS)(
    "names the same lines from %s",
    (_name, backend, format, extension) => {
      const rows = decodedLinesOfImage(imageOf(backend, format), extension).filter(
        (row) => row.file === SOURCE_NAME,
      );

      expect(new Set(rows.map((row) => row.line))).toEqual(new Set([4, 5, 6, 7]));
    },
  );

  itRunsPe("still runs the executable it described", () => {
    const run = runPe(imageOf("x64-windows", "executable"));

    expect(run.stdout.trim()).toBe("6");
    expect(run.status).toBe(0);
  });

  it("leaves an elf executable alone, since it carries no section table", () => {
    const image = imageOf("x64-linux", "executable");

    expect(Buffer.from(image).includes(Buffer.from(".debug_line"))).toBe(false);
  });
});
