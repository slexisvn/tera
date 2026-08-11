import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { Engine } from "../api/engine.js";
import type { AotProgram } from "../optimizing/drivers/aot.js";
import { writeAotProgram } from "../optimizing/drivers/aot.js";
import type { CliConfig } from "./args.js";
import { SCALAR_STRING, type AotScalar } from "../optimizing/types/scalar.js";
import { AOT_STRING_BUFFER_CAPACITY } from "../optimizing/analyses/aot-legality.js";

type EntryPoint = {
  readonly symbol: string;
  readonly returnScalar: AotScalar;
  readonly readsLine: boolean;
};

const MODULE_NAME = "program";
const TRANSLATED = /\.(c|s)$/;
const MAIN_NAME = "main.c";

class CompileError extends Error {}

function fail(message: string): number {
  console.error(`tera compile: ${message}`);
  return 1;
}

function resolveCompiler(preferred: string | null): string {
  const candidates = preferred ? [preferred] : ["cc", "gcc", "clang"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error) return candidate;
  }
  const shown = candidates.join(", ");
  throw new CompileError(
    `no C compiler found (tried: ${shown}). Install gcc/clang and ensure it is on PATH, ` +
      `or pass --cc=<path>.`,
  );
}

const STDIN_LINE = "line";

function readLineLines(): readonly string[] {
  return [
    `  char ${STDIN_LINE}[${AOT_STRING_BUFFER_CAPACITY}];`,
    `  if (fgets(${STDIN_LINE}, sizeof ${STDIN_LINE}, stdin) == NULL) return 1;`,
    `  size_t used = strlen(${STDIN_LINE});`,
    `  while (used > 0 && (${STDIN_LINE}[used - 1] == '\\n' || ${STDIN_LINE}[used - 1] == '\\r')) {`,
    `    ${STDIN_LINE}[--used] = '\\0';`,
    "  }",
  ];
}

function mainSource(entry: EntryPoint, headerName: string): string {
  const reads = entry.readsLine;
  const call = `${entry.symbol}(${reads ? STDIN_LINE : ""})`;
  const print =
    entry.returnScalar === SCALAR_STRING
      ? `printf("%s\\n", ${call});`
      : `printf("%.17g\\n", (double)${call});`;
  return [
    "#include <stdio.h>",
    ...(reads ? ["#include <string.h>"] : []),
    `#include "${headerName}"`,
    "",
    "int main(void) {",
    ...(reads ? readLineLines() : []),
    `  ${print}`,
    "  return 0;",
    "}",
    "",
  ].join("\n");
}

function defaultOutput(inputFile: string): string {
  const base = path.basename(inputFile, path.extname(inputFile));
  return process.platform === "win32" ? `${base}.exe` : base;
}

function withExeSuffix(output: string): string {
  if (process.platform !== "win32") return output;
  return path.extname(output) ? output : `${output}.exe`;
}

function fileNamed(program: AotProgram, extension: string): string {
  const file = program.files.find((candidate) => candidate.name.endsWith(extension));
  if (file === undefined) {
    throw new CompileError(`backend produced no ${extension} output`);
  }
  return file.name;
}

function selectEntry(program: AotProgram, entry: string): EntryPoint {
  const compiled = program.compiled.find((fn) => fn.name === entry);
  if (compiled) {
    const parameters = compiled.emitted.parameterScalars;
    const readsLine = parameters.length === 1 && parameters[0] === SCALAR_STRING;
    if (parameters.length > 0 && !readsLine) {
      throw new CompileError(
        `entry '${entry}' must take no parameters or one string parameter ` +
          `(it takes ${parameters.length}: ${parameters.join(", ")})`,
      );
    }
    return {
      symbol: compiled.emitted.symbol,
      returnScalar: compiled.emitted.returnScalar,
      readsLine,
    };
  }

  const skipped = program.skipped.find((fn) => fn.name === entry);
  if (skipped) {
    throw new CompileError(
      `entry '${entry}' could not be lowered to native code: ${skipped.reason}`,
    );
  }

  const available = program.compiled.map((fn) => fn.name);
  const hint =
    available.length > 0
      ? ` Available functions: ${available.join(", ")}. Use --entry=<name> to pick one.`
      : "";
  throw new CompileError(`entry function '${entry}' not found.${hint}`);
}

export function runCompile(config: CliConfig, engine: Engine): number {
  const inputFile = config.files[0];
  if (!inputFile) return fail("no input file (usage: tera compile <file> [-o out])");
  if (config.files.length > 1) {
    return fail("compile takes exactly one input file");
  }

  const resolvedInput = path.resolve(inputFile);
  if (!fs.existsSync(resolvedInput)) return fail(`file not found: ${inputFile}`);

  let source: string;
  try {
    source = fs.readFileSync(resolvedInput, "utf8");
  } catch (error) {
    return fail(`cannot read ${inputFile}: ${(error as Error).message}`);
  }

  let program: AotProgram;
  let entry: EntryPoint;
  let headerName: string;
  let compiler: string;
  try {
    program = engine.compileAot(source, {
      sourceName: resolvedInput,
      moduleName: MODULE_NAME,
      backend: config.backend,
    });
    entry = selectEntry(program, config.entry);
    headerName = fileNamed(program, ".h");
    compiler = resolveCompiler(config.cc);
  } catch (error) {
    if (error instanceof CompileError) return fail(error.message);
    if (error instanceof Error) return fail(error.message);
    throw error;
  }

  for (const fn of program.skipped) {
    console.error(`tera compile: warning: skipped '${fn.name}' (${fn.reason})`);
  }

  const output = withExeSuffix(config.output ?? defaultOutput(resolvedInput));
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "tera-compile-"));
  try {
    const written = writeAotProgram(program, buildDir);
    const sourcePaths = written.filter((file) => TRANSLATED.test(file));
    if (sourcePaths.length === 0) {
      return fail("backend produced no source the C toolchain can build");
    }
    const mainPath = path.join(buildDir, MAIN_NAME);
    fs.writeFileSync(mainPath, mainSource(entry, headerName));

    const result = spawnSync(
      compiler,
      [...sourcePaths, mainPath, "-o", path.resolve(output), "-lm"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (result.error) {
      return fail(`failed to invoke '${compiler}': ${result.error.message}`);
    }
    if (result.status !== 0) {
      return fail(`${compiler} exited with status ${result.status ?? "unknown"}`);
    }
  } finally {
    if (config.keepTemps) {
      console.error(`tera compile: kept intermediates in ${buildDir}`);
    } else {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }

  console.error(`tera compile: wrote ${output}`);
  return 0;
}
