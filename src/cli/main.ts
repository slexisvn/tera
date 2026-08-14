import fs from "fs";
import path from "path";
import { createReactiveTeraOptions, createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import { Engine } from "../api/engine.js";
import type { EngineOptions, EngineUnhandledRejection, OptimizedGraph } from "../api/engine.js";
import type { TeraExtension } from "../api/extensions.js";
import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";
import { nativeToTagged, taggedToNative } from "../runtime/domain/host.js";
import { checkSource } from "../frontend/checker/index.js";
import type { CheckSourceOptions, Diagnostic } from "../frontend/checker/index.js";
import { parse } from "../frontend/parser/language.js";
import { buildModuleGraph, checkModuleGraph, type ModuleGraph } from "../frontend/modules/index.js";
import { nodeModuleFileSystem } from "../frontend/modules/node-file-system.js";
import { searchPathsForEntry, searchPathsIn } from "../frontend/packages.js";
import { createBackendRegistry } from "../optimizing/backends/index.js";
import { parseArgs, CliUsageError } from "./args.js";
import type { CheckConfig, CliConfig, EngineFlags, RunConfig, SourceInputs } from "./config.js";
import { printAst } from "./ast-printer.js";
import { runDebug } from "./debug.js";
import { helpFor } from "./help.js";
import { nativesExtension, exposeGcExtension } from "./natives.js";
import { createStdinInput } from "./stdin.js";
import { runTargets } from "./targets.js";

type Source = { name: string; code: string };

const USAGE_EXIT = 2;
const FAILURE_EXIT = 1;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}

function reportUnhandledRejections(rejections: EngineUnhandledRejection[]): void {
  for (const rejection of rejections) {
    console.error(`Uncaught (in promise) ${rejection.message}`);
  }
}

function readVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function matchesFilter(filter: string | null, name: string | null | undefined): boolean {
  if (filter === null) return true;
  return typeof name === "string" && name.includes(filter);
}

type TieringOverrides = {
  baselineThreshold?: number;
  jitThreshold?: number;
  loopOsrThreshold?: number;
  maxDeoptCount?: number;
};

function buildTiering(config: EngineFlags): TieringOverrides | undefined {
  const policy: TieringOverrides = {};
  if (config.optMode === "none") {
    policy.jitThreshold = Number.MAX_SAFE_INTEGER;
    policy.loopOsrThreshold = Number.MAX_SAFE_INTEGER;
  } else if (config.optMode === "always") {
    policy.baselineThreshold = 2;
    policy.jitThreshold = 3;
    policy.loopOsrThreshold = 3;
  }
  if (config.jitThreshold !== null) policy.jitThreshold = config.jitThreshold;
  if (config.baselineThreshold !== null) policy.baselineThreshold = config.baselineThreshold;
  if (config.maxDeopt !== null) policy.maxDeoptCount = config.maxDeopt;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export function buildEngineOptions(config: EngineFlags): EngineOptions {
  const base = createReactiveTeraOptions({ nativeToTagged, taggedToNative });
  const extensions: TeraExtension[] = [...((base.extensions as TeraExtension[]) ?? [])];
  if (config.allowNatives) extensions.push(nativesExtension());
  if (config.exposeGc) extensions.push(exposeGcExtension());

  const options: EngineOptions = {
    ...base,
    extensions,
    input: createStdinInput(),
    backends: createBackendRegistry(),
    moduleFileSystem: nodeModuleFileSystem,
  };

  if (config.typecheck) options.typecheck = config.typecheck;
  if (!config.osr) options.osr = false;

  const tiering = buildTiering(config);
  if (tiering) options.tieringPolicy = tiering as EngineOptions["tieringPolicy"];

  if (config.traceCategories.length > 0) {
    options.trace = true;
    options.traceCategories = config.traceCategories;
  }

  if (config.printBytecode) {
    options.onCompile = (fn: RegisterCompiledFunction) => {
      if (matchesFilter(config.filter, fn.name)) console.log(fn.disassemble());
    };
  }
  if (config.printIr) {
    options.onOptimize = (fn: RegisterCompiledFunction, graph: OptimizedGraph) => {
      if (matchesFilter(config.filter, fn.name)) console.log(graph.dump());
    };
  }

  return options;
}

function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

function gatherSources(config: SourceInputs): Source[] {
  const sources: Source[] = [];
  if (config.eval !== null) sources.push({ name: "[eval]", code: config.eval });
  for (const file of config.files) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new CliUsageError(`file not found: ${file}`);
    sources.push({ name: resolved, code: fs.readFileSync(resolved, "utf8") });
  }
  if (config.readStdin) sources.push({ name: "[stdin]", code: readStdin() });
  return sources;
}

function reportDiagnostic(location: string, diagnostic: Diagnostic): boolean {
  console.error(`${location}: ${diagnostic.severity}: ${diagnostic.message}`);
  return diagnostic.severity === "error";
}

function checkModuleFile(
  file: string,
  options: CheckSourceOptions,
  modulePaths: readonly string[],
): boolean {
  const graph = buildModuleGraph(file, {
    fileSystem: nodeModuleFileSystem,
    searchPaths: searchPathsForEntry(nodeModuleFileSystem, file, modulePaths),
    parseSource: (source) => parse(source, { syntaxPlugins: options.syntaxPlugins }),
  });
  let hadError = false;
  for (const diagnostic of checkModuleGraph(graph, { ...options, mode: "strict" }).diagnostics) {
    const origin = diagnostic.path ?? diagnostic.module;
    hadError = reportDiagnostic(`${origin}:${diagnostic.line}:${diagnostic.column}`, diagnostic) || hadError;
  }
  return hadError;
}

function runCheck(config: CheckConfig): number {
  const options = createReactiveCheckOptions("strict") as CheckSourceOptions;
  let hadError = false;
  for (const file of config.files) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new CliUsageError(`file not found: ${file}`);
    hadError = checkModuleFile(resolved, options, config.modulePaths) || hadError;
  }
  for (const source of gatherSources({ ...config, files: [] })) {
    for (const diagnostic of checkSource(source.code, options)) {
      hadError = reportDiagnostic(`${source.name}:${diagnostic.line}:${diagnostic.column}`, diagnostic) || hadError;
    }
  }
  return hadError ? FAILURE_EXIT : 0;
}

function printModuleGraph(graph: ModuleGraph): void {
  console.log(`entry: ${graph.entry.spec}`);
  for (const record of graph.modules.values()) {
    const targets = record.imports.map((entry) => entry.module);
    console.log(`  ${record.spec} [${record.kind}]${targets.length > 0 ? ` -> ${targets.join(", ")}` : ""}`);
  }
  console.log(`init order: ${graph.initOrder.map((record) => record.spec).join(" -> ")}`);
  for (const cycle of graph.cycles) console.log(`cycle: ${cycle.join(" -> ")}`);
}

async function runModuleEntry(engine: Engine, config: RunConfig, file: string): Promise<void> {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new CliUsageError(`file not found: ${file}`);
  const graph = engine.loadModuleGraph(resolved, {
    searchPaths: searchPathsForEntry(nodeModuleFileSystem, resolved, config.modulePaths),
  });
  if (config.printModuleGraph) printModuleGraph(graph);
  if (config.printAst) {
    for (const record of graph.initOrder) console.log(printAst(record.ast));
  }
  await engine.runModuleGraphNative(graph);
}

async function runProgram(config: RunConfig): Promise<number> {
  const options = buildEngineOptions(config);
  let sawUnhandledRejection = false;
  options.onUnhandledRejection = (rejections) => {
    reportUnhandledRejections(rejections);
    sawUnhandledRejection = true;
  };
  const engine = new Engine(options);
  for (const file of config.files) await runModuleEntry(engine, config, file);
  const sources = gatherSources({ ...config, files: [] });
  if (sources.length > 0) {
    const moduleRoot = process.cwd();
    const searchPaths = searchPathsIn(nodeModuleFileSystem, moduleRoot, config.modulePaths);
    for (const source of sources) {
      if (config.printAst) {
        console.log(printAst(engine.parseSource(source.code, { sourceName: source.name })));
      }
      await engine.runNative(source.code, { sourceName: source.name, moduleRoot, searchPaths });
    }
  }
  if (config.stats) console.log(JSON.stringify(engine.getStats(), null, 2));
  return sawUnhandledRejection ? FAILURE_EXIT : 0;
}

export async function dispatch(config: CliConfig): Promise<number> {
  if (config.command === "help") {
    console.log(helpFor(config.topic));
    return 0;
  }
  if (config.command === "version") {
    console.log(readVersion());
    return 0;
  }
  if (config.command === "targets") return runTargets();
  if (config.command === "check") return runCheck(config);
  if (config.command === "debug") return runDebug(config, buildEngineOptions(config));
  if (config.command === "compile") {
    const { runCompile } = await import("./compile.js");
    return runCompile(config);
  }
  if (config.command === "repl") {
    const options = buildEngineOptions(config);
    options.onUnhandledRejection = reportUnhandledRejections;
    const { startREPL } = await import("./repl/index.js");
    await startREPL(new Engine(options), { modulePaths: config.modulePaths });
    return 0;
  }
  return runProgram(config);
}

export async function main(argv: readonly string[]): Promise<number> {
  let config: CliConfig;
  try {
    config = parseArgs([...argv]);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`tera: ${error.message}`);
      return USAGE_EXIT;
    }
    throw error;
  }

  try {
    return await dispatch(config);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`tera: ${error.message}`);
      return USAGE_EXIT;
    }
    console.error(errorMessage(error));
    return FAILURE_EXIT;
  }
}
