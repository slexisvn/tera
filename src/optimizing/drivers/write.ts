import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AotProgram } from "./aot.js";

export function writeAotProgram(program: AotProgram, outDir: string): readonly string[] {
  const written: string[] = [];
  for (const file of program.files) {
    const path = join(outDir, file.name);
    writeFileSync(path, file.contents);
    written.push(path);
  }
  return written;
}
