import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import { Engine } from "../../../src/api/engine.js";
import { nativeToTagged, taggedToNative } from "../../../src/runtime/domain/host.js";
import { nodeModuleFileSystem } from "../../../src/frontend/modules/node-file-system.js";
import { createBackendRegistry } from "../../../src/optimizing/backends/index.js";
import { createAnalyzer } from "../../../src/cli/repl/analysis.js";
import { createCommandRegistry } from "../../../src/cli/repl/commands.js";
import { createHistory } from "../../../src/cli/repl/history.js";
import { createLanguage } from "../../../src/cli/repl/language.js";
import { createPrinter } from "../../../src/cli/repl/display.js";
import { createSessionState } from "../../../src/cli/repl/session-state.js";
import { defaultTheme } from "../../../src/cli/repl/theme.js";
import { replModules, runSession, type ReadLine } from "../../../src/cli/repl/session.js";
import type { Terminal } from "../../../src/cli/repl/types.js";

const FIXTURE = fileURLToPath(new URL("./fixture", import.meta.url));

const scratch: string[] = [];
let previousCwd: string | null = null;

afterEach(() => {
  if (previousCwd !== null) process.chdir(previousCwd);
  previousCwd = null;
  while (scratch.length > 0) fs.rmSync(scratch.pop()!, { recursive: true, force: true });
});

function emptyProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-packages-repl-"));
  scratch.push(root);
  fs.writeFileSync(path.join(root, "tera.json"), "{}\n", "utf8");
  return root;
}

function scriptedReadLine(lines: readonly string[]): ReadLine {
  let index = 0;
  return async () => {
    if (index >= lines.length) return null;
    return { text: lines[index++]!, forceContinue: false };
  };
}

async function replIn(directory: string, lines: readonly string[]): Promise<string> {
  previousCwd = process.cwd();
  process.chdir(directory);
  const output: string[] = [];
  const term = ((text: string) => output.push(text)) as unknown as Terminal;
  const language = createLanguage();
  const engine = new Engine({
    ...createReactiveTeraOptions({ nativeToTagged, taggedToNative }),
    backends: createBackendRegistry(),
    moduleFileSystem: nodeModuleFileSystem,
  });
  await runSession({
    engine,
    printer: createPrinter(term, defaultTheme),
    language,
    analyzer: createAnalyzer(),
    history: createHistory(),
    state: createSessionState(),
    commander: createCommandRegistry(),
    readLine: scriptedReadLine(lines),
    modules: replModules({ modulePaths: [] }),
    knownNames: () => new Set<string>(),
    clearScreen: () => {},
    publishPending: () => {},
  });
  return output.join("");
}

describe("repl package resolution", () => {
  it("imports an installed package from the project it was started in", async () => {
    const output = await replIn(FIXTURE, ["from slexis.http import fetch", 'fetch("/status")']);

    expect(output).toContain("{body: GET /status}");
  });

  it("reports an unresolvable module outside a project", async () => {
    const output = await replIn(emptyProject(), ["from slexis.http import fetch"]);

    expect(output).toContain("Cannot resolve module 'slexis.http'");
  });
});

describe(".packages", () => {
  it("lists every installed package with its version and source", async () => {
    const output = await replIn(FIXTURE, [".packages"]);

    expect(output).toContain(path.join(FIXTURE, "tera_packages"));
    expect(output).toContain("slexis.http  1.0.0  petahub  2 files");
    expect(output).toContain("slexis.json  0.4.1  petahub  1 file");
  });

  it("says so when the project has no installed packages", async () => {
    const output = await replIn(emptyProject(), [".packages"]);

    expect(output).toContain("no tera_packages directory");
  });

  it("keeps the session alive when the state file is unreadable", async () => {
    const root = emptyProject();
    fs.mkdirSync(path.join(root, "tera_packages", ".peta"), { recursive: true });
    fs.writeFileSync(path.join(root, "tera_packages", ".peta", "state.json"), "{", "utf8");

    const output = await replIn(root, [".packages", "1 + 1"]);

    expect(output).toContain("2");
  });
});
