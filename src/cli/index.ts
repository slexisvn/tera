#!/usr/bin/env node
import { Engine } from "../api/engine.js";
import { DebugController } from "../debugger/index.js";
import type { DebugCommand, DebugFrameSnapshot, DebugPauseEvent } from "../debugger/index.js";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const file = args[0];
const DEBUG_PROMPT = "(tera-debug) ";

class DebugQuit extends Error {}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}

function printHelp(): void {
  console.log("Usage: tera [file]");
  console.log("       tera -e <source>");
  console.log("       tera debug <file>");
  console.log("       tera --help");
}

function readLineSync(): string {
  const input = [];
  const buffer = Buffer.alloc(1);
  while (true) {
    const read = fs.readSync(process.stdin.fd, buffer, 0, 1, null);
    if (read === 0) return input.join("");
    const ch = buffer.toString("utf8", 0, read);
    if (ch === "\n") return input.join("");
    if (ch !== "\r") input.push(ch);
  }
}

function currentFrame(event: DebugPauseEvent): DebugFrameSnapshot {
  return event.snapshot.frames[event.snapshot.frames.length - 1]!;
}

function printPause(event: DebugPauseEvent, lines: string[]): void {
  const loc = event.location;
  console.log(
    `${event.reason} at ${loc.sourceName}:${loc.line}:${loc.column} in ${loc.functionName}`,
  );
  const sourceLine = lines[loc.line - 1];
  if (sourceLine !== undefined) {
    console.log(`${String(loc.line).padStart(4)} | ${sourceLine}`);
  }
}

function printLocals(event: DebugPauseEvent): void {
  const frame = currentFrame(event);
  if (frame.locals.length === 0) {
    console.log("locals: <empty>");
    return;
  }
  for (const local of frame.locals) {
    console.log(`${local.name} = ${local.value.display}`);
  }
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
  console.log("c, continue       continue");
  console.log("s, step           step into");
  console.log("n, next           step over");
  console.log("o, out            step out");
  console.log("b <line>          set breakpoint");
  console.log("clear <line>      clear breakpoint");
  console.log("locals            show locals");
  console.log("bt                show backtrace");
  console.log("q, quit           quit");
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
      const bp = controller.setBreakpoint({
        sourceName: event.location.sourceName,
        line,
      });
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
    const parsed = parseDebugCommand(readLineSync(), event, controller);
    if (parsed) return parsed;
  }
}

async function runDebugFile(fileName: string | undefined): Promise<void> {
  if (!fileName) {
    printHelp();
    process.exit(1);
  }
  const resolved = path.resolve(fileName);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: file not found: ${fileName}`);
    process.exit(1);
  }
  const source = fs.readFileSync(resolved, "utf8");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const controller = new DebugController({
    pauseOnEntry: true,
    onPause: (event, activeController) =>
      promptDebugCommand(event, activeController, lines),
  });
  const engine = new Engine({ debugger: controller });
  try {
    await engine.runNative(source, { sourceName: resolved });
  } catch (error) {
    if (error instanceof DebugQuit) return;
    throw error;
  }
}

if (file === "--help" || file === "-h") {
  printHelp();
} else if (file === "debug" || file === "--debug") {
  try {
    await runDebugFile(args[1]);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
} else if (file === "-e" || file === "--eval") {
  const source = args.slice(1).join(" ");
  const engine = new Engine();
  try {
    await engine.runNative(source);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
} else if (!file) {
  const { startREPL } = await import("./repl.js");
  startREPL(new Engine());
} else {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: file not found: ${file}`);
    process.exit(1);
  }
  const source = fs.readFileSync(resolved, "utf8");
  const engine = new Engine();
  try {
    await engine.runNative(source);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
