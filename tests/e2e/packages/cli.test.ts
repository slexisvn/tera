import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../../src/cli/main.js";

const FIXTURE = fileURLToPath(new URL("./fixture", import.meta.url));
const ENTRY = path.join(FIXTURE, "src", "main.tera");
const UNKNOWN_IMPORT = path.join(FIXTURE, "src", "unknown-import.tera");
const OUTPUT = "{body: GET /status}";

const scratch: string[] = [];
let previousCwd: string | null = null;

afterEach(() => {
  if (previousCwd !== null) process.chdir(previousCwd);
  previousCwd = null;
  while (scratch.length > 0) fs.rmSync(scratch.pop()!, { recursive: true, force: true });
});

function workingDirectory(directory: string): void {
  previousCwd = process.cwd();
  process.chdir(directory);
}

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-packages-"));
  scratch.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

type CliRun = { status: number; out: string; err: string };

async function cli(...argv: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (message?: unknown) => void out.push(String(message));
  console.error = (message?: unknown) => void err.push(String(message));
  try {
    const status = await main(argv);
    return { status, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("tera run", () => {
  it("runs a program that imports an installed package with no module path flag", async () => {
    const run = await cli(ENTRY);

    expect(run.err).toBe("");
    expect(run.status).toBe(0);
    expect(run.out).toBe(OUTPUT);
  });

  it("resolves the package, its scope and its transitive dependency", async () => {
    const run = await cli("--print-module-graph", ENTRY);

    expect(run.status).toBe(0);
    expect(run.out).toContain("slexis.http [package]");
    expect(run.out).toContain("slexis [namespace]");
    expect(run.out).toContain("slexis.json [package]");
    expect(run.out).toContain("slexis.http.client [file]");
    expect(run.out).toContain(
      "init order: slexis.json -> slexis.http -> slexis.http.client -> __main__",
    );
  });

  it("prefers a module path directory over the installed package", async () => {
    const override = workspace({
      "slexis/http/__init__.tera": 'fn fetch(path: string) -> string:\n  return "override " + path\n',
    });
    const run = await cli("--module-path", override, ENTRY);

    expect(run.status).toBe(0);
    expect(run.out).toBe("override /status");
  });

  it("imports an installed package from source given on the command line", async () => {
    workingDirectory(FIXTURE);
    const run = await cli("-e", 'from slexis.http import fetch\nprint(fetch("/status"))');

    expect(run.err).toBe("");
    expect(run.status).toBe(0);
    expect(run.out).toBe(OUTPUT);
  });

  it("does not resolve an installed package for a program outside the project", async () => {
    const outside = workspace({ "main.tera": fs.readFileSync(ENTRY, "utf8") });
    const run = await cli(path.join(outside, "main.tera"));

    expect(run.status).toBe(1);
    expect(run.err).toContain("Cannot resolve module 'slexis.http'");
  });
});

describe("tera check", () => {
  it("type-checks a program against the installed package", async () => {
    const run = await cli("check", ENTRY);

    expect(run.err).toBe("");
    expect(run.status).toBe(0);
  });

  it("reports a name the installed package does not export", async () => {
    const run = await cli("check", UNKNOWN_IMPORT);

    expect(run.status).toBe(1);
    expect(run.err).toContain("Module 'slexis.http' has no export 'missing'");
  });
});
