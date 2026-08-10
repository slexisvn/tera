import { describe, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Engine } from "../../../src/index.js";
import { parseArgs } from "../../../src/cli/args.js";
import { runCompile } from "../../../src/cli/compile.js";
import { itNative } from "../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

function inWorkspace<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tera-cli-compile-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compile(dir: string, source: string, extraArgs: readonly string[] = []) {
  const input = join(dir, "input.tera");
  const output = join(dir, process.platform === "win32" ? "out.exe" : "out");
  writeFileSync(input, `${source}\n`);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => void errors.push(String(message));
  try {
    const status = runCompile(
      parseArgs(["compile", input, "-o", output, ...extraArgs]),
      new Engine({ typecheck: "off" }),
    );
    return { status, output, errors };
  } finally {
    console.error = originalError;
  }
}

function run(binary: string): string {
  const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`binary failed: ${result.stderr || result.status}`);
  return result.stdout.trim();
}

describe("tera compile", () => {
  itNative("builds a native binary whose output matches the interpreter", () => {
    const source = src(
      "fn main() -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < 10:",
      "    total = total + i * i",
      "    i = i + 1",
      "  return total",
    );

    inWorkspace((dir) => {
      const interpreted = new Engine({ typecheck: "off" }).runNative(`${source}\nmain()`);
      const { status, output } = compile(dir, source);

      expect(status).toBe(0);
      expect(Number(run(output))).toBe(interpreted);
    });
  });

  itNative("prints an integral entry result without reinterpreting its bits", () => {
    inWorkspace((dir) => {
      const { status, output } = compile(dir, src("fn main() -> int:", "  return 285"));

      expect(status).toBe(0);
      expect(run(output)).toBe("285");
    });
  });

  itNative("reports an entry the backend could not lower instead of writing a binary", () => {
    inWorkspace((dir) => {
      const { status, errors } = compile(
        dir,
        src("fn main():", "  o = {a: 1}", "  return o.a"),
      );

      expect(status).toBe(1);
      expect(errors.join("\n")).toContain("could not be lowered to native code");
    });
  });

  itNative("keeps intermediates the backend named, not names the CLI guessed", () => {
    inWorkspace((dir) => {
      const { status, errors } = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--keep-temps",
      ]);
      const kept = errors.find((line) => line.includes("kept intermediates in"));

      expect(status).toBe(0);
      expect(kept).toBeDefined();
      const buildDir = kept!.slice(kept!.indexOf("kept intermediates in ") + 22).trim();
      expect(readFileSync(join(buildDir, "main.c"), "utf8")).toContain('#include "program.h"');
      expect(readFileSync(join(buildDir, "program.h"), "utf8")).toContain("tera_main(void)");
      rmSync(buildDir, { recursive: true, force: true });
    });
  });
});
