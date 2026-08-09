import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cIdentifier } from "../../../../src/optimizing/backends/c/emit.js";

export type CArgument = number | string;

const DEFINITION = /^(int32_t|double)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
const LOCAL_INCLUDE = /^#include\s+"[^"]*"\s*$/gm;
const SYSTEM_HEADERS = ["stdint.h", "string.h", "stdio.h", "stdlib.h", "math.h"];

let compilerCache: string | null | undefined;

function compiler(): string {
  if (compilerCache === undefined) {
    compilerCache = null;
    for (const candidate of ["cc", "gcc", "clang"]) {
      if (!spawnSync(candidate, ["--version"], { stdio: "ignore" }).error) {
        compilerCache = candidate;
        break;
      }
    }
  }
  if (compilerCache === null) throw new Error("no C compiler available");
  return compilerCache;
}

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
    ...SYSTEM_HEADERS.map((header) => `#include <${header}>`),
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
  const program = buildProgram(source, symbol, args);
  const directory = mkdtempSync(join(tmpdir(), "tera-c-"));
  try {
    const sourcePath = join(directory, "program.c");
    const binaryPath = join(directory, process.platform === "win32" ? "program.exe" : "program");
    writeFileSync(sourcePath, program);

    const build = spawnSync(compiler(), [sourcePath, "-O1", "-o", binaryPath, "-lm"], {
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`compilation failed for ${symbol}:\n${build.stderr}\n${program}`);
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
