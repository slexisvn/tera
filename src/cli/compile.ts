import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { Engine } from "../api/engine.js";
import { AotLinkError, type AotProgram } from "../optimizing/drivers/aot.js";
import { writeAotProgram } from "../optimizing/drivers/write.js";
import type {
  AotOutputFile,
  AotOutputFormat,
  AotSkippedFunction,
} from "../optimizing/target/artifact.js";
import { isAotBackend, type AotBackend } from "../optimizing/target/backend.js";
import {
  defaultDelivery,
  missingEntryReason,
  programEntryShape,
  type ProgramEntryShape,
} from "../optimizing/target/entry.js";
import { PROGRAM_ENTRY_NAME } from "../optimizing/target/program-entry.js";
import { compilerOptions } from "../optimizing/options.js";
import type { CompileConfig, EmitKind } from "./config.js";
import {
  aotBackends,
  architectureOf,
  architectures,
  emitsOf,
  hostArchitecture,
} from "./targets.js";
import { HOST_PLATFORM } from "../optimizing/backends/index.js";
import { nodeModuleFileSystem } from "../frontend/modules/node-file-system.js";
import { searchPathsForEntry } from "../frontend/packages.js";
import { hostEngineOptions } from "./host.js";

const HEADER_SUFFIX = ".h";
const TRANSLATED = /\.(c|s)$/;
const MAIN_NAME = "main.c";
const HOST_EXECUTABLE_SUFFIX = process.platform === "win32" ? ".exe" : "";

const FORMATS: Record<EmitKind, AotOutputFormat> = {
  exe: "executable",
  obj: "object",
  source: "assembly",
};

class CompileError extends Error {}

interface EntryPoint {
  readonly symbol: string;
  readonly shape: ProgramEntryShape;
}

function fail(message: string): number {
  console.error(`tera compile: ${message}`);
  return 1;
}

function warnSkipped(skipped: readonly AotSkippedFunction[]): void {
  for (const fn of skipped) {
    console.error(`tera compile: warning: skipped '${fn.name}' (${fn.reason})`);
  }
}

function resolveCompiler(preferred: string | null): string {
  const candidates = preferred ? [preferred] : ["cc", "gcc", "clang"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error) return candidate;
  }
  throw new CompileError(
    `no C compiler found (tried: ${candidates.join(", ")}). Install gcc/clang and put it ` +
      `on PATH, or pass --cc=<path>.`,
  );
}

function deliveryLines(entry: EntryPoint, call: string): readonly string[] {
  if (entry.shape.delivery === "exit") return [`  return (int)${call};`];
  if (entry.shape.result === "string") return [`  printf("%s\\n", ${call});`, "  return 0;"];
  if (entry.shape.result === "int") return [`  printf("%d\\n", ${call});`, "  return 0;"];
  return [`  printf("%.17g\\n", (double)${call});`, "  return 0;"];
}

function moduleInitLines(program: AotProgram): readonly string[] {
  const inits = program.moduleInits ?? [];
  if (inits.length === 0) return [];
  return [
    "static void tera_module_init(void) {",
    ...inits.map((symbol) => `  (void)${symbol}();`),
    "}",
    "",
  ];
}

function mainSource(entry: EntryPoint, headerName: string, program: AotProgram): string {
  const inits = program.moduleInits ?? [];
  return [
    `#include "${headerName}"`,
    "",
    ...moduleInitLines(program),
    "int main(void) {",
    ...(inits.length > 0 ? ["  tera_module_init();"] : []),
    ...deliveryLines(entry, `${entry.symbol}()`),
    "}",
    "",
  ].join("\n");
}

function selectEntry(program: AotProgram, config: CompileConfig): EntryPoint {
  const name = config.entry ?? PROGRAM_ENTRY_NAME;
  const compiled = program.compiled.find((fn) => fn.name === name);
  if (compiled === undefined) {
    throw new CompileError(
      missingEntryReason(
        name,
        program.compiled.map((fn) => fn.name),
        program.skipped,
      ),
    );
  }
  const shape = programEntryShape(
    compiled.emitted.parameterScalars,
    compiled.emitted.returnScalar,
    config.result ?? defaultDelivery(compiled.emitted.returnScalar),
  );
  if (!shape.ok) throw new CompileError(`entry function ${name} ${shape.reason}`);
  return { symbol: compiled.emitted.symbol, shape: shape.shape };
}

function choosePlatform(
  arch: string,
  candidates: readonly AotBackend[],
  requested: string | null,
): AotBackend {
  const offered = candidates.map((backend) => backend.platform?.os ?? "").join(", ");
  if (requested !== null) {
    const named = candidates.find((backend) => backend.platform?.os === requested);
    if (named === undefined) {
      throw new CompileError(
        `no target builds ${arch} for ${requested} (it builds for ${offered})`,
      );
    }
    return named;
  }
  const host = candidates.find((backend) => backend.platform?.os === HOST_PLATFORM.os);
  if (host !== undefined) return host;
  if (candidates.length === 1) return candidates[0]!;
  throw new CompileError(
    `${arch} does not build for this machine; pass --platform (it builds for ${offered})`,
  );
}

function portableBackends(): readonly AotBackend[] {
  return aotBackends().filter((backend) => backend.platform === null);
}

function knownArchitectures(): string {
  return architectures()
    .map((architecture) => architecture.name)
    .join(", ");
}

function resolveBackend(engine: Engine, config: CompileConfig): AotBackend {
  const requested = config.target ?? hostArchitecture();
  const native = aotBackends().filter((backend) => architectureOf(backend) === requested);
  const candidates =
    native.length === 0 && config.target === null ? portableBackends() : native;
  if (candidates.length === 0) {
    throw new CompileError(
      `unknown target '${requested}' (known: ${knownArchitectures()}; see 'tera targets')`,
    );
  }
  const arch = architectureOf(candidates[0]!);
  const portable = candidates.find((backend) => backend.platform === null);
  if (portable !== undefined) {
    if (config.platform !== null) {
      throw new CompileError(
        `target '${arch}' is portable, so --platform does not apply to it`,
      );
    }
    return engine.backends.resolve(portable.id) as AotBackend;
  }
  const chosen = choosePlatform(arch, candidates, config.platform);
  return engine.backends.resolve(chosen.id) as AotBackend;
}

function requireHostToolchain(backend: AotBackend): void {
  const platform = backend.platform;
  if (platform === null) return;
  if (platform.os === HOST_PLATFORM.os && platform.arch === HOST_PLATFORM.arch) return;
  throw new CompileError(
    `${platform.os}-${platform.arch} is not this machine (${HOST_PLATFORM.os}-` +
      `${HOST_PLATFORM.arch}), so the C compiler here cannot link the result; ` +
      `emit ${emitsOf(backend).join(" or ")} and link with a cross toolchain instead`,
  );
}

function usesToolchain(config: CompileConfig, backend: AotBackend): boolean {
  if (config.emit === "exe") {
    if (config.link !== "cc" && backend.outputs.includes(FORMATS.exe)) return false;
    if (config.link === "none") {
      throw new CompileError(
        `target '${backend.id}' cannot write an executable itself (it emits ` +
          `${emitsOf(backend).join(", ")}); use --link=cc`,
      );
    }
    requireHostToolchain(backend);
    return true;
  }
  if (!backend.outputs.includes(FORMATS[config.emit])) {
    throw new CompileError(
      `target '${backend.id}' cannot emit ${config.emit} (it emits ${emitsOf(backend).join(", ")})`,
    );
  }
  return false;
}

function headerOf(program: AotProgram): AotOutputFile {
  const header = program.files.find((file) => file.name.endsWith(HEADER_SUFFIX));
  if (header === undefined) throw new CompileError("backend produced no header");
  return header;
}

function primaryOf(program: AotProgram): AotOutputFile {
  const primary = program.files.find((file) => !file.name.endsWith(HEADER_SUFFIX));
  if (primary === undefined) throw new CompileError("backend produced no artifact");
  return primary;
}

function defaultOutput(input: string, artifact: string): string {
  const base = path.basename(input, path.extname(input));
  const suffix = path.extname(artifact);
  return `${base}${suffix}`;
}

function writeDirect(program: AotProgram, config: CompileConfig, input: string): string {
  if (config.emit === "source") {
    const directory = config.output ?? ".";
    fs.mkdirSync(directory, { recursive: true });
    writeAotProgram(program, directory);
    return directory;
  }
  const primary = primaryOf(program);
  const output = path.resolve(config.output ?? defaultOutput(input, primary.name));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, primary.contents);
  for (const file of program.files) {
    if (file === primary) continue;
    fs.writeFileSync(path.join(path.dirname(output), file.name), file.contents);
  }
  return output;
}

function linkWithCompiler(
  program: AotProgram,
  config: CompileConfig,
  input: string,
  entry: EntryPoint,
): string {
  const compiler = resolveCompiler(config.cc);
  const output = path.resolve(
    config.output ??
      `${path.basename(input, path.extname(input))}${HOST_EXECUTABLE_SUFFIX}`,
  );
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "tera-compile-"));
  try {
    const written = writeAotProgram(program, buildDir);
    const sources = written.filter((file) => TRANSLATED.test(file));
    if (sources.length === 0) {
      throw new CompileError("backend produced no source the C toolchain can build");
    }
    const mainPath = path.join(buildDir, MAIN_NAME);
    fs.writeFileSync(mainPath, mainSource(entry, headerOf(program).name, program));
    const built = spawnSync(compiler, [...sources, mainPath, "-o", output, "-lm"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (built.error) {
      throw new CompileError(`failed to invoke '${compiler}': ${built.error.message}`);
    }
    if (built.status !== 0) {
      throw new CompileError(`${compiler} exited with status ${built.status ?? "unknown"}`);
    }
    return output;
  } finally {
    if (config.keepTemps) {
      console.error(`tera compile: kept intermediates in ${buildDir}`);
    } else {
      try {
        fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        console.error(`tera compile: could not remove ${buildDir}`);
      }
    }
  }
}

function compile(config: CompileConfig): number {
  const input = config.files[0];
  if (input === undefined) {
    throw new CompileError("no input file (usage: tera compile <file> [-o out])");
  }
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new CompileError(`file not found: ${input}`);
  const moduleName = path.basename(resolved, path.extname(resolved));
  const engine = new Engine(hostEngineOptions());
  const backend = resolveBackend(engine, config);
  const toolchain = usesToolchain(config, backend);
  const format = toolchain ? "assembly" : FORMATS[config.emit];

  let program: AotProgram;
  try {
    program = engine.compileAotModule(resolved, {
      sourceName: resolved,
      moduleName,
      searchPaths: searchPathsForEntry(nodeModuleFileSystem, resolved, config.modulePaths),
      wholeProgram: config.emit === "exe",
      backend: backend.id,
      format,
      ...(config.entry === null ? {} : { entry: config.entry }),
      ...(config.result === null ? {} : { result: config.result }),
      ...(config.heapBytes === null ? {} : { heapBytes: config.heapBytes }),
      ...(config.verify
        ? { compilerOptions: compilerOptions("speed", { verifyEachPass: true }) }
        : {}),
    });
  } catch (error) {
    if (error instanceof AotLinkError) warnSkipped(error.skipped);
    throw error;
  }
  warnSkipped(program.skipped);

  const written = toolchain
    ? linkWithCompiler(program, config, resolved, selectEntry(program, config))
    : writeDirect(program, config, resolved);
  console.error(`tera compile: wrote ${written}`);
  return 0;
}

export function runCompile(config: CompileConfig): number {
  try {
    return compile(config);
  } catch (error) {
    if (error instanceof CompileError) return fail(error.message);
    if (error instanceof Error) return fail(error.message);
    throw error;
  }
}
