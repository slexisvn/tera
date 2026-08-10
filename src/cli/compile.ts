import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { Engine } from "../api/engine.js";
import type { AotProgram } from "../optimizing/drivers/aot.js";
import { writeAotProgram } from "../optimizing/drivers/aot.js";
import type { CliConfig } from "./args.js";

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

function mainSource(entrySymbol: string, headerName: string): string {
  return [
    "#include <stdio.h>",
    `#include "${headerName}"`,
    "",
    "int main(void) {",
    `  printf("%.17g\\n", (double)${entrySymbol}());`,
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

function selectEntry(program: AotProgram, entry: string): { symbol: string } {
  const compiled = program.compiled.find((fn) => fn.name === entry);
  if (compiled) {
    if (compiled.emitted.parameterCount > 0) {
      throw new CompileError(
        `entry '${entry}' must take no parameters (it takes ${compiled.emitted.parameterCount})`,
      );
    }
    return { symbol: compiled.emitted.symbol };
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
  let entrySymbol: string;
  let headerName: string;
  let compiler: string;
  try {
    program = engine.compileAot(source, {
      sourceName: resolvedInput,
      moduleName: MODULE_NAME,
      backend: config.backend,
    });
    entrySymbol = selectEntry(program, config.entry).symbol;
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
    fs.writeFileSync(mainPath, mainSource(entrySymbol, headerName));

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
