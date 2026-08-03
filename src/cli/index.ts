#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createReactiveTeraOptions, createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import { Engine } from "../api/engine.js";
import type { EngineOptions, OptimizedGraph } from "../api/engine.js";
import type { TeraExtension } from "../api/extensions.js";
import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";
import { nativeToTagged, taggedToNative } from "../runtime/domain/host.js";
import { DebugController } from "../debugger/index.js";
import type { DebugCommand, DebugFrameSnapshot, DebugPauseEvent } from "../debugger/index.js";
import { checkSource } from "../frontend/checker/index.js";
import type { CheckSourceOptions } from "../frontend/checker/index.js";
import { parseArgs, CliUsageError } from "./args.js";
import type { CliConfig } from "./args.js";
import { printAst } from "./ast-printer.js";
import { nativesExtension, exposeGcExtension } from "./natives.js";

type Source = { name: string; code: string };

class DebugQuit extends Error {}
const DEBUG_PROMPT = "(tera-debug) ";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}

function printHelp(): void {
  const lines = [
    "Usage: tera [options] [file ...]",
    "       tera -e <source>",
    "       tera debug <file>",
    "",
    "Input:",
    "  -e, --eval <source>       run source passed on the command line",
    "  -                         read a program from stdin",
    "  --                        treat remaining arguments as file paths",
    "",
    "Inspection:",
    "  --print-bytecode          disassemble each function as it is compiled",
    "  --print-ast               print the parsed AST of each program",
    "  --print-ir, --trace-turbo dump the optimizer CFG of each optimized function",
    "  --filter=<substr>         restrict name-filtered dumps to matching functions",
    "  --stats                   print engine statistics after running",
    "",
    "Tracing:",
    "  --trace[=cats]            enable the tracer (all categories, or a comma list)",
    "  --trace-opt               trace optimizing compilation",
    "  --trace-deopt             trace deoptimizations",
    "  --trace-ic                trace inline caches",
    "  --trace-maps              trace hidden-class transitions",
    "  --trace-gc                trace garbage collection",
    "  --trace-feedback          trace feedback vectors",
    "",
    "Optimization:",
    "  --no-opt                  never tier up to the optimizing compiler",
    "  --always-opt              optimize functions as early as possible",
    "  --opt-threshold=<n>       call count before optimizing",
    "  --baseline-threshold=<n>  call count before baseline compilation",
    "  --max-deopt=<n>           deopts tolerated before optimization is disabled",
    "  --no-osr                  disable on-stack replacement",
    "  --allow-natives-syntax    expose OptimizeFunctionOnNextCall and friends",
    "  --expose-gc               expose a global gc() function",
    "",
    "Types:",
    "  --typecheck=off|warn|strict  set the type checker mode",
    "  --check                      type-check without running",
    "",
    "  -h, --help                show this help",
    "  -v, --version             show the version",
  ];
  console.log(lines.join("\n"));
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

function buildTiering(config: CliConfig): TieringOverrides | undefined {
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

function buildEngineOptions(config: CliConfig): EngineOptions {
  const base = createReactiveTeraOptions({ nativeToTagged, taggedToNative });
  const extensions: TeraExtension[] = [...((base.extensions as TeraExtension[]) ?? [])];
  if (config.allowNatives) extensions.push(nativesExtension());
  if (config.exposeGc) extensions.push(exposeGcExtension());

  const options: EngineOptions = { ...base, extensions };

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

function gatherSources(config: CliConfig): Source[] {
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

function runCheck(sources: Source[]): number {
  const options = createReactiveCheckOptions("strict") as CheckSourceOptions;
  let hadError = false;
  for (const source of sources) {
    for (const diagnostic of checkSource(source.code, options)) {
      const location = `${source.name}:${diagnostic.line}:${diagnostic.column}`;
      console.error(`${location}: ${diagnostic.severity}: ${diagnostic.message}`);
      if (diagnostic.severity === "error") hadError = true;
    }
  }
  return hadError ? 1 : 0;
}

async function runSources(config: CliConfig, engine: Engine, sources: Source[]): Promise<void> {
  for (const source of sources) {
    if (config.printAst) {
      console.log(printAst(engine.parseSource(source.code, { sourceName: source.name })));
    }
    await engine.runNative(source.code, { sourceName: source.name });
  }
}

function currentFrame(event: DebugPauseEvent): DebugFrameSnapshot {
  return event.snapshot.frames[event.snapshot.frames.length - 1]!;
}

function debugReadLine(): string {
  const input: string[] = [];
  const buffer = Buffer.alloc(1);
  while (true) {
    const read = fs.readSync(process.stdin.fd, buffer, 0, 1, null);
    if (read === 0) return input.join("");
    const ch = buffer.toString("utf8", 0, read);
    if (ch === "\n") return input.join("");
    if (ch !== "\r") input.push(ch);
  }
}

function printPause(event: DebugPauseEvent, lines: string[]): void {
  const loc = event.location;
  console.log(`${event.reason} at ${loc.sourceName}:${loc.line}:${loc.column} in ${loc.functionName}`);
  const sourceLine = lines[loc.line - 1];
  if (sourceLine !== undefined) console.log(`${String(loc.line).padStart(4)} | ${sourceLine}`);
}

function printLocals(event: DebugPauseEvent): void {
  const frame = currentFrame(event);
  if (frame.locals.length === 0) {
    console.log("locals: <empty>");
    return;
  }
  for (const local of frame.locals) console.log(`${local.name} = ${local.value.display}`);
}

function printBacktrace(event: DebugPauseEvent): void {
  const frames = [...event.snapshot.frames].reverse();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const loc = frame.location;
    const where = loc ? `${loc.sourceName}:${loc.line}:${loc.column}` : "<generated>";
    console.log(`#${i} ${frame.functionName} ${where}`);
  }
}

function printDebugHelp(): void {
  const lines = [
    "c, continue       continue",
    "s, step           step into",
    "n, next           step over",
    "o, out            step out",
    "b <line>          set breakpoint",
    "clear <line>      clear breakpoint",
    "locals            show locals",
    "bt                show backtrace",
    "q, quit           quit",
  ];
  console.log(lines.join("\n"));
}

function parseDebugCommand(
  input: string,
  event: DebugPauseEvent,
  controller: DebugController,
): DebugCommand | null {
  const [command = "", value = ""] = input.trim().split(/\s+/, 2);
  switch (command) {
    case "":
    case "n":
    case "next":
      return "stepOver";
    case "c":
    case "continue":
      return "continue";
    case "s":
    case "step":
      return "stepInto";
    case "o":
    case "out":
      return "stepOut";
    case "b":
    case "break": {
      const line = Number(value);
      if (!Number.isInteger(line) || line <= 0) {
        console.log("breakpoint line must be a positive integer");
        return null;
      }
      const bp = controller.setBreakpoint({ sourceName: event.location.sourceName, line });
      console.log(`breakpoint ${bp.id} at ${bp.sourceName}:${bp.line}`);
      return null;
    }
    case "clear":
    case "delete": {
      const line = Number(value);
      if (!Number.isInteger(line) || line <= 0) {
        console.log("clear line must be a positive integer");
        return null;
      }
      const ok = controller.clearBreakpointAt(event.location.sourceName, line);
      console.log(ok ? `cleared ${event.location.sourceName}:${line}` : "no breakpoint");
      return null;
    }
    case "locals":
    case "l":
      printLocals(event);
      return null;
    case "bt":
    case "backtrace":
      printBacktrace(event);
      return null;
    case "h":
    case "help":
      printDebugHelp();
      return null;
    case "q":
    case "quit":
      throw new DebugQuit();
    default:
      console.log(`unknown command '${command}'`);
      printDebugHelp();
      return null;
  }
}

function promptDebugCommand(
  event: DebugPauseEvent,
  controller: DebugController,
  lines: string[],
): DebugCommand {
  printPause(event, lines);
  while (true) {
    fs.writeSync(1, DEBUG_PROMPT);
    const parsed = parseDebugCommand(debugReadLine(), event, controller);
    if (parsed) return parsed;
  }
}

async function runDebug(config: CliConfig, options: EngineOptions): Promise<number> {
  const fileName = config.files[0];
  if (!fileName) {
    printHelp();
    return 1;
  }
  const resolved = path.resolve(fileName);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: file not found: ${fileName}`);
    return 1;
  }
  const source = fs.readFileSync(resolved, "utf8");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const controller = new DebugController({
    pauseOnEntry: true,
    onPause: (event, activeController) => promptDebugCommand(event, activeController, lines),
  });
  const engine = new Engine({ ...options, debugger: controller });
  try {
    await engine.runNative(source, { sourceName: resolved });
  } catch (error) {
    if (error instanceof DebugQuit) return 0;
    throw error;
  }
  return 0;
}

async function main(): Promise<number> {
  let config: CliConfig;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`tera: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (config.command === "help") {
    printHelp();
    return 0;
  }
  if (config.command === "version") {
    console.log(readVersion());
    return 0;
  }

  const options = buildEngineOptions(config);

  if (config.command === "debug") return runDebug(config, options);

  if (config.command === "repl") {
    const { startREPL } = await import("./repl.js");
    await startREPL(new Engine(options));
    return 0;
  }

  const sources = gatherSources(config);
  if (config.check) return runCheck(sources);

  const engine = new Engine(options);
  await runSources(config, engine, sources);
  if (config.stats) console.log(JSON.stringify(engine.getStats(), null, 2));
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
