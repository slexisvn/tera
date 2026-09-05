import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirectory } from "./workspace.js";
import {
  C_TEXT_STREAM_SUPPORT,
  C_TEXT_WRITER,
} from "../../src/optimizing/backends/c/emit.js";
import { cTypedefs, C_WIDE_TEXT_UNIT } from "../../src/optimizing/target/c-types.js";

const SYSTEM_HEADERS = ["stdint.h", "string.h", "stdio.h", "stdlib.h", "math.h"];
const CANDIDATES = ["cc", "gcc", "clang"];
const OPTIMIZATION = ["-O0", "-pipe"];
const LIBRARIES = ["-lm"];

export const INCLUDES = SYSTEM_HEADERS.map((header) => `#include <${header}>`);
export const BINARY = process.platform === "win32" ? "program.exe" : "program";

export const TEXT_WRITER = C_TEXT_WRITER;

export const TEXT_WRITER_SOURCE = [
  cTypedefs(C_WIDE_TEXT_UNIT),
  C_TEXT_STREAM_SUPPORT,
];

export function build(
  compiler: string,
  sources: readonly string[],
  binary: string,
): SpawnSyncReturns<string> {
  return spawnSync(compiler, [...sources, ...OPTIMIZATION, "-o", binary, ...LIBRARIES], {
    encoding: "utf8",
  });
}

export function detectCompiler(): string | null {
  const directory = mkdtempSync(join(tmpdir(), "tera-cc-"));
  try {
    const source = join(directory, "probe.c");
    const binary = join(directory, BINARY);
    writeFileSync(source, [...INCLUDES, "int main(void) { return 0; }", ""].join("\n"));
    for (const candidate of CANDIDATES) {
      const probe = build(candidate, [source], binary);
      if (probe.error === undefined && probe.status === 0) return candidate;
    }
    return null;
  } finally {
    removeDirectory(directory);
  }
}
