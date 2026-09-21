import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeAotProgram } from "../../../src/optimizing/drivers/write.js";
import { removeDirectory } from "../../helpers/workspace.js";
import type { AotOutputFile, AotProgram } from "../../../src/optimizing/drivers/aot.js";
import { AOT_OUTPUT_EXECUTABLE_MODE } from "../../../src/optimizing/target/artifact.js";

const directories: string[] = [];
const EXECUTE_BITS = 0o111;

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

  it.skipIf(process.platform === "win32")("marks executable output as executable", () => {
    const directory = workspace();
    writeAotProgram(
      programOf({
        name: "program.elf",
        contents: Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]),
        mode: AOT_OUTPUT_EXECUTABLE_MODE,
      }),
      directory,
    );

    const expected = AOT_OUTPUT_EXECUTABLE_MODE & ~process.umask() & EXECUTE_BITS;
    expect(statSync(join(directory, "program.elf")).mode & EXECUTE_BITS).toBe(expected);
  });

  it.skipIf(process.platform === "win32")("updates the mode when replacing an old output", () => {
    const directory = workspace();
    const executable = join(directory, "program.elf");
    writeFileSync(executable, "old");
    chmodSync(executable, 0o600);

    writeAotProgram(
      programOf({
        name: "program.elf",
        contents: "new",
        mode: AOT_OUTPUT_EXECUTABLE_MODE,
      }),
      directory,
    );

    const expected = AOT_OUTPUT_EXECUTABLE_MODE & ~process.umask() & EXECUTE_BITS;
    expect(readFileSync(executable, "utf8")).toBe("new");
    expect(statSync(executable).mode & EXECUTE_BITS).toBe(expected);
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
