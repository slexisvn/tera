import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import type { AotProgram } from "../../src/optimizing/drivers/aot.js";
import { cCompiler } from "./c-executor.js";

export type NativeArgument = number | string;

const PROTOTYPE = /^(int32_t|double)\s+(\w+)\s*\(([^)]*)\);$/gm;
const BINARY = process.platform === "win32" ? "program.exe" : "program";

export const itAssembles = it.skipIf(cCompiler === null);

export function nativeFile(program: AotProgram, extension: string): string {
  const file = program.files.find((candidate) => candidate.name.endsWith(extension));
  if (file === undefined) throw new Error(`program has no ${extension} output`);
  return String(file.contents);
}

function prototypes(header: string): Map<string, { returns: string; params: string[] }> {
  const found = new Map<string, { returns: string; params: string[] }>();
  PROTOTYPE.lastIndex = 0;
  let match = PROTOTYPE.exec(header);
  while (match !== null) {
    found.set(match[2]!, { returns: match[1]!, params: parameterTypes(match[3]!) });
    match = PROTOTYPE.exec(header);
  }
  return found;
}

function parameterTypes(params: string): string[] {
  const trimmed = params.trim();
  if (trimmed.length === 0 || trimmed === "void") return [];
  return trimmed.split(",").map((param) => {
    const text = param.trim();
    if (text.startsWith("const char *")) return "const char *";
    const match = text.match(/^(int32_t|double)\s+\w+$/);
    if (!match) throw new Error(`unsupported parameter: ${param}`);
    return match[1]!;
  });
}

function literal(type: string, value: NativeArgument): string {
  if (type === "const char *") {
    if (typeof value !== "string") throw new Error(`expected a string argument, got ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value !== "number") throw new Error(`expected a numeric argument, got ${value}`);
  if (type === "int32_t") return `(int32_t)${Math.trunc(value)}`;
  if (Number.isNaN(value)) return "(0.0/0.0)";
  if (!Number.isFinite(value)) return value > 0 ? "(1.0/0.0)" : "(-1.0/0.0)";
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return `${value}.0`;
  return value.toExponential(20);
}

function mainSource(
  header: string,
  symbol: string,
  args: readonly NativeArgument[],
): string {
  const signature = prototypes(header).get(symbol);
  if (signature === undefined) throw new Error(`header has no prototype for ${symbol}`);
  if (signature.params.length !== args.length) {
    throw new Error(`expected ${signature.params.length} args, got ${args.length}`);
  }
  const call = `${symbol}(${signature.params
    .map((type, index) => literal(type, args[index]!))
    .join(", ")})`;
  return [
    "#include <stdio.h>",
    '#include "program.h"',
    "",
    "int main(void) {",
    `  printf("%.17g\\n", (double)${call});`,
    "  return 0;",
    "}",
    "",
  ].join("\n");
}

export function runNativeFunction(
  program: AotProgram,
  symbol: string,
  args: readonly NativeArgument[] = [],
): number {
  if (cCompiler === null) throw new Error("no C toolchain available");
  const header = nativeFile(program, ".h");
  const assembly = nativeFile(program, ".s");
  const directory = mkdtempSync(join(tmpdir(), "tera-x64-"));
  try {
    writeFileSync(join(directory, "program.h"), header);
    writeFileSync(join(directory, "program.s"), assembly);
    writeFileSync(join(directory, "main.c"), mainSource(header, symbol, args));
    const binary = join(directory, BINARY);
    const built = spawnSync(
      cCompiler,
      [join(directory, "main.c"), join(directory, "program.s"), "-o", binary, "-lm"],
      { encoding: "utf8" },
    );
    if (built.status !== 0) {
      throw new Error(`assembling ${symbol} failed:\n${built.stderr}\n${assembly}`);
    }
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
    if (run.status !== 0) {
      throw new Error(`running ${symbol} failed: ${run.stderr || run.status}\n${assembly}`);
    }
    const text = run.stdout.trim();
    const value = Number(text);
    if (Number.isNaN(value) && text !== "nan" && text !== "-nan") {
      throw new Error(`unexpected output for ${symbol}: ${run.stdout}`);
    }
    return value;
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      void 0;
    }
  }
}
