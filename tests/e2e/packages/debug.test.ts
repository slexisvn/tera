import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDebug } from "../../../src/cli/debug.js";
import { parseArgs } from "../../../src/cli/args.js";
import { buildEngineOptions } from "../../../src/cli/main.js";
import type { DebugConfig } from "../../../src/cli/config.js";

const FIXTURE = fileURLToPath(new URL("./fixture", import.meta.url));
const ENTRY = path.join(FIXTURE, "src", "main.tera");
const PACKAGE = path.join(FIXTURE, "tera_packages", "slexis", "http", "__init__.tera");

type DebugRun = { status: number; out: string };

async function debugSession(script: readonly string[], argv: string[] = []): Promise<DebugRun> {
  const commands = [...script];
  const out: string[] = [];
  const log = console.log;
  console.log = (message?: unknown) => void out.push(String(message));
  try {
    const config = parseArgs(["debug", ENTRY, ...argv]) as DebugConfig;
    const status = await runDebug(config, {
      ...buildEngineOptions(config),
      input: () => commands.shift() ?? "c",
    });
    return { status, out: out.join("\n") };
  } finally {
    console.log = log;
  }
}

describe("tera debug", () => {
  it("runs a program that imports an installed package", async () => {
    const run = await debugSession(["c"]);

    expect(run.status).toBe(0);
    expect(run.out).toContain("{body: GET /status}");
  });

  it("pauses inside an installed package on a file breakpoint", async () => {
    const run = await debugSession([`b ${PACKAGE}:5`, "c", "locals", "c"]);

    expect(run.status).toBe(0);
    expect(run.out).toContain(`breakpoint 1 at ${PACKAGE}:5`);
    expect(run.out).toContain(`breakpoint at ${PACKAGE}:5`);
    expect(run.out).toContain("path = /status");
  });

  it("takes a breakpoint file relative to the working directory", async () => {
    const run = await debugSession(["b tera_packages/slexis/http/__init__.tera:5", "c", "c"]);

    expect(run.out).toContain(`breakpoint 1 at ${PACKAGE}:5`);
    expect(run.out).toContain(`breakpoint at ${PACKAGE}:5`);
  });

  it("shows the source line of the file it paused in, not of the entry", async () => {
    const run = await debugSession([`b ${PACKAGE}:5`, "c", "c"]);

    expect(run.out).toContain("return encode(request(path))");
  });

  it("rejects a breakpoint that names no line", async () => {
    const run = await debugSession(["b nowhere", "c"]);

    expect(run.out).toContain("breakpoint line must be a positive integer");
  });
});
