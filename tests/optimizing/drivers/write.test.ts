import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeAotProgram } from "../../../src/optimizing/drivers/write.js";
import { removeDirectory } from "../../helpers/workspace.js";
import type { AotOutputFile, AotProgram } from "../../../src/optimizing/drivers/aot.js";

const directories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "tera-write-"));
  directories.push(directory);
  return directory;
}

function programOf(...files: readonly AotOutputFile[]): AotProgram {
  return { files, compiled: [], skipped: [] };
}

afterEach(() => {
  while (directories.length > 0) removeDirectory(directories.pop()!);
});

describe("writing an AOT program to disk", () => {
  it("returns the path of every file it wrote, in the order the program lists them", () => {
    const directory = workspace();
    const written = writeAotProgram(
      programOf(
        { name: "program.h", contents: "int32_t main(void);" },
        { name: "program.c", contents: "int32_t main(void) { return 0; }" },
      ),
      directory,
    );

    expect(written.map((path) => basename(path))).toEqual(["program.h", "program.c"]);
    expect(written).toEqual([join(directory, "program.h"), join(directory, "program.c")]);
  });

  it("writes text contents verbatim", () => {
    const directory = workspace();
    const contents = 'printf("%s\\n", "done");\n';
    writeAotProgram(programOf({ name: "program.c", contents }), directory);

    expect(readFileSync(join(directory, "program.c"), "utf8")).toBe(contents);
  });

  it("writes binary contents byte for byte", () => {
    const directory = workspace();
    const contents = Uint8Array.from([0x4d, 0x5a, 0x00, 0xff, 0x90]);
    writeAotProgram(programOf({ name: "program.exe", contents }), directory);

    expect(new Uint8Array(readFileSync(join(directory, "program.exe")))).toEqual(contents);
  });

  it("leaves the directory empty for a program that produced no files", () => {
    const directory = workspace();

    expect(writeAotProgram(programOf(), directory)).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("replaces a file left over from an earlier write rather than appending to it", () => {
    const directory = workspace();
    writeAotProgram(programOf({ name: "program.c", contents: "the longer first draft" }), directory);
    writeAotProgram(programOf({ name: "program.c", contents: "short" }), directory);

    expect(readFileSync(join(directory, "program.c"), "utf8")).toBe("short");
  });

  it("keeps the last of two files the program named alike", () => {
    const directory = workspace();
    const written = writeAotProgram(
      programOf(
        { name: "program.c", contents: "first" },
        { name: "program.c", contents: "second" },
      ),
      directory,
    );

    expect(written).toHaveLength(2);
    expect(readFileSync(join(directory, "program.c"), "utf8")).toBe("second");
  });

  it("fails rather than creating a directory the program named a file inside", () => {
    const directory = workspace();

    expect(() =>
      writeAotProgram(programOf({ name: join("nested", "program.c"), contents: "x" }), directory),
    ).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});
