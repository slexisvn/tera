import fs from "fs";
import path from "path";
import { Engine } from "../api/engine.js";
import type { EngineOptions } from "../api/engine.js";
import { DebugController } from "../debugger/index.js";
import type { DebugCommand, DebugFrameSnapshot, DebugPauseEvent } from "../debugger/index.js";
import { nodeModuleFileSystem } from "../frontend/modules/node-file-system.js";
import { searchPathsForEntry } from "../frontend/packages.js";
import type { DebugConfig } from "./config.js";

const DEBUG_PROMPT = "(tera-debug) ";
const LOCATION_SEPARATOR = ":";

class DebugQuit extends Error {}

type SourceLines = (sourceName: string) => readonly string[];

function readLines(target: string): readonly string[] {
  try {
    return fs.readFileSync(target, "utf8").replace(/\r\n?/g, "\n").split("\n");
  } catch {
    return [];
  }
}

function sourceCache(): SourceLines {
  const cache = new Map<string, readonly string[]>();
  return (sourceName) => {
    const cached = cache.get(sourceName);
    if (cached !== undefined) return cached;
    const lines = readLines(sourceName);
    cache.set(sourceName, lines);
    return lines;
  };
}

function currentFrame(event: DebugPauseEvent): DebugFrameSnapshot {
  return event.snapshot.frames[event.snapshot.frames.length - 1]!;
}

function printPause(event: DebugPauseEvent, sourceLines: SourceLines): void {
  const loc = event.location;
  console.log(
    `${event.reason} at ${loc.sourceName}:${loc.line}:${loc.column} in ${loc.functionName}`,
  );
  const sourceLine = sourceLines(loc.sourceName)[loc.line - 1];
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
    "b [file:]<line>   set breakpoint (file defaults to the paused one)",
    "clear [file:]<n>  clear breakpoint",
    "locals            show locals",
    "bt                show backtrace",
    "q, quit           quit",
  ];
  console.log(lines.join("\n"));
}

type DebugSession = {
  readonly sourceLines: SourceLines;
  readonly sources: readonly string[];
};

type BreakLocation = { readonly sourceName: string; readonly line: number };

function withForwardSlashes(target: string): string {
  return target.split(path.win32.sep).join(path.posix.sep);
}

function resolveSource(value: string, sources: readonly string[]): string {
  const absolute = path.resolve(value);
  if (sources.includes(absolute)) return absolute;
  const suffix = withForwardSlashes(value);
  const matches = sources.filter((source) => withForwardSlashes(source).endsWith(suffix));
  return matches.length === 1 ? matches[0]! : absolute;
}

function parseLocation(
  value: string,
  event: DebugPauseEvent,
  session: DebugSession,
): BreakLocation | null {
  const separator = value.lastIndexOf(LOCATION_SEPARATOR);
  const line = Number(separator < 0 ? value : value.slice(separator + 1));
  if (!Number.isInteger(line) || line <= 0) return null;
  if (separator < 0) return { sourceName: event.location.sourceName, line };
  return { sourceName: resolveSource(value.slice(0, separator), session.sources), line };
}

function parseDebugCommand(
  input: string,
  event: DebugPauseEvent,
  controller: DebugController,
  session: DebugSession,
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
      const target = parseLocation(value, event, session);
      if (target === null) {
        console.log("breakpoint line must be a positive integer");
        return null;
      }
      const bp = controller.setBreakpoint(target);
      console.log(`breakpoint ${bp.id} at ${bp.sourceName}:${bp.line}`);
      return null;
    }
    case "clear":
    case "delete": {
      const target = parseLocation(value, event, session);
      if (target === null) {
        console.log("clear line must be a positive integer");
        return null;
      }
      const ok = controller.clearBreakpointAt(target.sourceName, target.line);
      console.log(ok ? `cleared ${target.sourceName}:${target.line}` : "no breakpoint");
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
  session: DebugSession,
  readLine: () => string,
): DebugCommand {
  printPause(event, session.sourceLines);
  while (true) {
    fs.writeSync(1, DEBUG_PROMPT);
    const parsed = parseDebugCommand(readLine(), event, controller, session);
    if (parsed) return parsed;
  }
}

export async function runDebug(config: DebugConfig, options: EngineOptions): Promise<number> {
  const fileName = config.files[0];
  if (!fileName) {
    console.error("tera debug: no input file (usage: tera debug <file>)");
    return 2;
  }
  const resolved = path.resolve(fileName);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: file not found: ${fileName}`);
    return 1;
  }
  const sources: string[] = [];
  const session: DebugSession = { sourceLines: sourceCache(), sources };
  const readLine = () => options.input?.("") ?? "";
  const controller = new DebugController({
    pauseOnEntry: true,
    onPause: (event, activeController) =>
      promptDebugCommand(event, activeController, session, readLine),
  });
  const engine = new Engine({ ...options, debugger: controller });
  try {
    const graph = engine.loadModuleGraph(resolved, {
      searchPaths: searchPathsForEntry(nodeModuleFileSystem, resolved, config.modulePaths),
    });
    for (const record of graph.initOrder) {
      if (record.path !== null) sources.push(record.path);
    }
    await engine.runModuleGraphNative(graph);
  } catch (error) {
    if (error instanceof DebugQuit) return 0;
    throw error;
  }
  return 0;
}
