import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import { Engine, nativeToTagged, taggedToNative } from "../../src/index.js";
import { createAnalyzer } from "../../src/cli/repl/analysis.js";
import { createCommandRegistry } from "../../src/cli/repl/commands.js";
import { createHistory } from "../../src/cli/repl/history.js";
import { createLanguage } from "../../src/cli/repl/language.js";
import { createPrinter } from "../../src/cli/repl/display.js";
import { createSessionState } from "../../src/cli/repl/session-state.js";
import { runSession, type ReadLine } from "../../src/cli/repl/session.js";
import type { Terminal } from "../../src/cli/repl/types.js";

const HISTORY_FILE = path.join(os.tmpdir(), `tera-history-${process.pid}.txt`);

beforeAll(() => {
  process.env.TERA_HISTORY = HISTORY_FILE;
});

afterAll(() => {
  delete process.env.TERA_HISTORY;
});

type ScriptLine = string | { text: string; forceContinue?: boolean };

function scriptedReadLine(lines: ScriptLine[]): ReadLine {
  let index = 0;
  return async () => {
    if (index >= lines.length) return null;
    const item = lines[index++];
    if (typeof item === "string") return { text: item, forceContinue: false };
    return { text: item.text, forceContinue: item.forceContinue ?? false };
  };
}

async function runScript(lines: ScriptLine[]): Promise<string> {
  const output: string[] = [];
  const term = ((text: string) => output.push(text)) as unknown as Terminal;
  const language = createLanguage();
  const engine = new Engine(createReactiveTeraOptions({ nativeToTagged, taggedToNative }));
  await runSession({
    engine,
    printer: createPrinter(term, (await import("../../src/cli/repl/theme.js")).defaultTheme),
    language,
    analyzer: createAnalyzer(),
    history: createHistory(),
    state: createSessionState(),
    commander: createCommandRegistry(),
    readLine: scriptedReadLine(lines),
    knownNames: () => new Set<string>([...language.keywords, ...language.builtins.keys()]),
    clearScreen: () => {},
  });
  return output.join("");
}

describe("runSession", () => {
  it("evaluates an expression and prints its value", async () => {
    expect(await runScript(["1 + 2"])).toContain("3");
  });

  it("keeps variable state across inputs", async () => {
    expect(await runScript(["x = 21", "x * 2"])).toContain("42");
  });

  it("accumulates an indented block until a blank line then evaluates it", async () => {
    const output = await runScript([
      "fn dbl(n: int) -> int:",
      "  return n * 2",
      "",
      "dbl(21)",
    ]);
    expect(output).toContain("42");
  });

  it("runs meta commands and lists help", async () => {
    expect(await runScript([".help"])).toContain(".exit");
  });

  it("stops the loop on .exit", async () => {
    const output = await runScript([".exit", "1 + 1"]);
    expect(output).not.toContain("2");
  });

  it("shows documentation for a builtin via ?name", async () => {
    expect(await runScript(["?range"])).toContain("range");
  });

  it("reports errors and offers a suggestion for an unknown name", async () => {
    const output = await runScript(["prnt(1)"]);
    expect(output.toLowerCase()).toContain("print");
  });

  it("keeps typing on a new line when a line ends with a backslash", async () => {
    const output = await runScript(["a = 40 \\", "a = a + 2", "a"]);
    expect(output).toContain("42");
  });

  it("keeps reading after a forced continuation even when the buffer is complete", async () => {
    const output = await runScript([
      { text: "y = 40", forceContinue: true },
      "y = y + 2",
      "y",
    ]);
    expect(output).toContain("42");
  });
});
