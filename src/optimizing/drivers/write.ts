import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AotProgram } from "./aot.js";
import { AOT_OUTPUT_REGULAR_MODE, type AotOutputFile } from "../target/artifact.js";

function maskedMode(mode: number): number {
  return mode & ~process.umask();
}

export function writeAotFile(file: AotOutputFile, path: string): void {
  const mode = file.mode ?? AOT_OUTPUT_REGULAR_MODE;
  writeFileSync(path, file.contents, { mode });
  if (file.mode !== undefined) chmodSync(path, maskedMode(mode));
}

export function writeAotProgram(program: AotProgram, outDir: string): readonly string[] {
  const written: string[] = [];
  for (const file of program.files) {
    const path = join(outDir, file.name);
    writeAotFile(file, path);
    written.push(path);
  }
  return written;
}
