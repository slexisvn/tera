import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { itAssembles, nativeFile, runNativeFunction } from "../../../helpers/native-executor.js";
import { cSource, runCFunction } from "../../../helpers/c-executor.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";

const HOST_TARGET = hostBackendId();

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-native-mod-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function compileFor(files: Record<string, string>, backend?: string): AotProgram {
  const root = project(files);
  return nodeEngine({ typecheck: "off" }).compileAotModule(path.join(root, "main.tera"), {
    root,
    ...(backend === undefined ? {} : { backend }),
  });
}

const FILES = {
  "main.tera": [
    "from mathlib import square",
    "from lib import scaled",
    "fn total(n: int) -> int:",
    "  return square(n) + scaled(n)",
    "total(7)",
    "",
  ].join("\n"),
  "mathlib.tera": "fn square(n: int) -> int:\n  return n * n\n",
  "lib.tera": [
    "fn _double(n: int) -> int:",
    "  return n * 2",
    "fn scaled(n: int) -> int:",
    "  return _double(n) + 1",
    "",
  ].join("\n"),
};

describe.skipIf(HOST_TARGET === null)(`multi-module AOT on ${HOST_TARGET ?? "no host target"}`, () => {
  itAssembles("emits module-qualified symbols in the host assembly", () => {
    const assembly = nativeFile(compileFor(FILES, HOST_TARGET!), ".s");
    expect(assembly).toContain("mathlib_square");
    expect(assembly).toContain("lib_scaled");
  });

  itAssembles("keeps a module-private helper out of the exported symbols", () => {
    const program = compileFor(FILES, HOST_TARGET!);
    const assembly = nativeFile(program, ".s");
    const header = nativeFile(program, ".h");
    expect(assembly).toContain("lib__double");
    expect(assembly).not.toMatch(/\.globl\s+_?lib__double/);
    expect(header).not.toContain("lib__double");
  });

  itAssembles("exports the public cross-module symbols", () => {
    const assembly = nativeFile(compileFor(FILES, HOST_TARGET!), ".s");
    expect(assembly).toMatch(/\.globl\s+_?mathlib_square/);
    expect(assembly).toMatch(/\.globl\s+_?lib_scaled/);
  });

  itAssembles("agrees with the C backend on the same program", () => {
    const viaC = compileFor(FILES);
    expect(runNativeFunction(compileFor(FILES, HOST_TARGET!), "total", [7])).toBe(
      runCFunction(cSource(viaC), "total", [7]),
    );
  });

  itAssembles("agrees with the interpreter", () => {
    const root = project(FILES);
    const expected = nodeEngine({ typecheck: "off" }).runModuleNative(
      path.join(root, "main.tera"),
      { root },
    );
    expect(runNativeFunction(compileFor(FILES, HOST_TARGET!), "total", [7])).toBe(expected);
  });
});
