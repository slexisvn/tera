import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { cIdentifier } from "../../src/optimizing/backends/c/emit.js";
import type { AotProgram } from "../../src/optimizing/drivers/aot.js";

export type CArgument = number | string;

export function cSource(program: AotProgram): string {
  const file = program.files.find((candidate) => candidate.name.endsWith(".c"));
  if (file === undefined) throw new Error("program has no C source file");
  return String(file.contents);
}

const DEFINITION = /^(int32_t|double)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
const LOCAL_INCLUDE = /^#include\s+"[^"]*"\s*$/gm;
const SYSTEM_HEADERS = ["stdint.h", "string.h", "stdio.h", "stdlib.h", "math.h"];
const CANDIDATES = ["cc", "gcc", "clang"];

const INCLUDES = SYSTEM_HEADERS.map((header) => `#include <${header}>`);
const BINARY = process.platform === "win32" ? "program.exe" : "program";

function inBuildDirectory<T>(use: (sourcePath: string, binaryPath: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "tera-c-"));
  try {
    return use(join(directory, "program.c"), join(directory, BINARY));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function build(candidate: string, sourcePath: string, binaryPath: string) {
  return spawnSync(candidate, [sourcePath, "-O1", "-o", binaryPath, "-lm"], { encoding: "utf8" });
}

function detectCompiler(): string | null {
  return inBuildDirectory((sourcePath, binaryPath) => {
    writeFileSync(sourcePath, [...INCLUDES, "int main(void) { return 0; }", ""].join("\n"));
    for (const candidate of CANDIDATES) {
      const probe = build(candidate, sourcePath, binaryPath);
      if (probe.error === undefined && probe.status === 0) return candidate;
    }
    return null;
  });
}

export const cCompiler = detectCompiler();

export const itNative = it.skipIf(cCompiler === null);

function definitions(source: string): Array<{ returns: string; name: string; params: string }> {
  const found: Array<{ returns: string; name: string; params: string }> = [];
  DEFINITION.lastIndex = 0;
  let match = DEFINITION.exec(source);
  while (match !== null) {
    found.push({ returns: match[1]!, name: match[2]!, params: match[3]! });
    match = DEFINITION.exec(source);
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

function literal(type: string, value: CArgument): string {
  if (type === "const char *") {
    if (typeof value !== "string") throw new Error(`expected a string argument, got ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value !== "number") throw new Error(`expected a numeric argument, got ${value}`);
  if (type === "int32_t") return `(int32_t)${Math.trunc(value)}`;
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function buildProgram(source: string, symbol: string, args: readonly CArgument[]): string {
  const body = source.replace(LOCAL_INCLUDE, "");
  const entry = cIdentifier(symbol);
  const found = definitions(body);
  const target = found.find((definition) => definition.name === entry);
  if (target === undefined) throw new Error(`missing function ${symbol}`);

  const types = parameterTypes(target.params);
  if (types.length !== args.length) {
    throw new Error(`expected ${types.length} args, got ${args.length}`);
  }

  const prototypes = found.map(
    (definition) => `${definition.returns} ${definition.name}(${definition.params});`,
  );
  const call = `${entry}(${types.map((type, index) => literal(type, args[index]!)).join(", ")})`;
  return [
    ...INCLUDES,
    ...prototypes,
    body,
    "int main(void) {",
    `  printf("%.17g\\n", (double)${call});`,
    "  return 0;",
    "}",
    "",
  ].join("\n");
}

export function runCFunction(
  source: string,
  symbol: string,
  args: readonly CArgument[],
): number {
  if (cCompiler === null) throw new Error("no C compiler available");
  const program = buildProgram(source, symbol, args);
  return inBuildDirectory((sourcePath, binaryPath) => {
    writeFileSync(sourcePath, program);

    const compiled = build(cCompiler, sourcePath, binaryPath);
    if (compiled.status !== 0) {
      throw new Error(`compilation failed for ${symbol}:\n${compiled.stderr}\n${program}`);
    }

    const run = spawnSync(binaryPath, [], { encoding: "utf8", timeout: 10_000 });
    if (run.status !== 0) {
      throw new Error(`execution failed for ${symbol}: ${run.stderr || run.status}`);
    }
    const value = Number(run.stdout.trim());
    if (Number.isNaN(value) && run.stdout.trim() !== "nan") {
      throw new Error(`unexpected output for ${symbol}: ${run.stdout}`);
    }
    return value;
  });
}
