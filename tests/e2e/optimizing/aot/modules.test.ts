import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-aot-mod-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function compile(files: Record<string, string>): AotProgram {
  const root = project(files);
  return nodeEngine().compileAotModule(path.join(root, "main.tera"), { root });
}

const MATHLIB = ["fn square(n: int) -> int:", "  return n * n", ""].join("\n");

const MAIN = [
  "from mathlib import square",
  "fn total(n: int) -> int:",
  "  return square(n) + 1",
  "total(7)",
  "",
].join("\n");

describe("whole-program AOT across modules", () => {
  it("emits the imported function under a module-qualified symbol", () => {
    expect(cSource(compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB }))).toContain(
      "int32_t mathlib_square(int32_t",
    );
  });

  it("keeps the entry module's functions unqualified", () => {
    expect(cSource(compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB }))).toContain(
      "int32_t total(int32_t",
    );
  });

  it("resolves the cross-module call to the qualified symbol", () => {
    const source = cSource(compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB }));
    expect(source).toMatch(/int32_t total\(int32_t[\s\S]*mathlib_square\(/);
  });

  it("does not drop the caller as an unresolved reference", () => {
    const program = compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB });
    expect(program.compiled.map((fn) => fn.name)).toContain("total");
    expect(program.skipped.map((fn) => fn.name)).not.toContain("total");
  });

  it("gives two modules with the same function name distinct symbols", () => {
    const source = cSource(
      compile({
        "main.tera": [
          "from a import helper as ah",
          "from b import helper as bh",
          "fn total(n: int) -> int:",
          "  return ah(n) + bh(n)",
          "total(2)",
          "",
        ].join("\n"),
        "a.tera": "fn helper(n: int) -> int:\n  return n + 1\n",
        "b.tera": "fn helper(n: int) -> int:\n  return n + 2\n",
      }),
    );
    expect(source).toContain("int32_t a_helper(int32_t");
    expect(source).toContain("int32_t b_helper(int32_t");
  });

  it("resolves a chain of cross-module calls", () => {
    const program = compile({
      "main.tera": "from a import outer\nfn go() -> int:\n  return outer(3)\ngo()\n",
      "a.tera": "from b import inner\nfn outer(n: int) -> int:\n  return inner(n) * 2\n",
      "b.tera": "fn inner(n: int) -> int:\n  return n + 1\n",
    });
    expect(program.skipped.map((fn) => fn.name)).not.toContain("outer");
    expect(cSource(program)).toContain("int32_t b_inner(int32_t");
  });

  it("produces a deterministic C source across builds", () => {
    const files = { "main.tera": MAIN, "mathlib.tera": MATHLIB };
    const root = project(files);
    const first = nodeEngine().compileAotModule(path.join(root, "main.tera"), { root });
    const second = nodeEngine().compileAotModule(path.join(root, "main.tera"), { root });
    expect(cSource(second)).toBe(cSource(first));
  });
});

describe("running compiled multi-module code", () => {
  itNative("computes the same result as the interpreter", () => {
    const program = compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB });
    expect(runCFunction(cSource(program), "total", [7])).toBe(50);
  });

  itNative("runs a three-module call chain", () => {
    const program = compile({
      "main.tera": "from a import outer\nfn go() -> int:\n  return outer(3)\ngo()\n",
      "a.tera": "from b import inner\nfn outer(n: int) -> int:\n  return inner(n) * 2\n",
      "b.tera": "fn inner(n: int) -> int:\n  return n + 1\n",
    });
    expect(runCFunction(cSource(program), "go", [])).toBe(8);
  });

  itNative("keeps same-named functions from two modules apart at runtime", () => {
    const program = compile({
      "main.tera": [
        "from a import helper as ah",
        "from b import helper as bh",
        "fn total(n: int) -> int:",
        "  return ah(n) * 100 + bh(n)",
        "total(2)",
        "",
      ].join("\n"),
      "a.tera": "fn helper(n: int) -> int:\n  return n + 1\n",
      "b.tera": "fn helper(n: int) -> int:\n  return n + 2\n",
    });
    expect(runCFunction(cSource(program), "total", [2])).toBe(304);
  });
});

describe("linkage", () => {
  const PRIVATE_HELPER = {
    "main.tera": [
      "from lib import scaled",
      "fn go(n: int) -> int:",
      "  return scaled(n)",
      "go(4)",
      "",
    ].join("\n"),
    "lib.tera": [
      "fn _double(n: int) -> int:",
      "  return n * 2",
      "fn scaled(n: int) -> int:",
      "  return _double(n) + 1",
      "",
    ].join("\n"),
  };

  it("gives a module-private function internal linkage", () => {
    expect(cSource(compile(PRIVATE_HELPER))).toContain("static int32_t lib__double(int32_t");
  });

  it("keeps a public function externally linked", () => {
    const source = cSource(compile(PRIVATE_HELPER));
    expect(source).toContain("int32_t lib_scaled(int32_t");
    expect(source).not.toContain("static int32_t lib_scaled(int32_t");
  });

  it("keeps internal prototypes out of the header", () => {
    const program = compile(PRIVATE_HELPER);
    const header = program.files.find((file) => file.name.endsWith(".h"));
    expect(String(header!.contents)).not.toContain("lib__double");
    expect(String(header!.contents)).toContain("lib_scaled");
  });

  itNative("still runs the private helper correctly", () => {
    expect(runCFunction(cSource(compile(PRIVATE_HELPER)), "go", [4])).toBe(9);
  });
});

describe("module init table", () => {
  const NUMERIC_MODULE = {
    "main.tera": [
      "from consts import base",
      "fn go() -> int:",
      "  return base + 1",
      "go()",
      "",
    ].join("\n"),
    "consts.tera": "base = 41\n",
  };

  function headerOf(files: readonly { name: string; contents: string | Uint8Array }[]): string {
    return String(files.find((file) => file.name.endsWith(".h"))!.contents);
  }

  it("lists only init functions that actually lowered", () => {
    const program = compile(NUMERIC_MODULE);
    for (const symbol of program.moduleInits ?? []) {
      expect(program.compiled.map((fn) => fn.emitted.symbol)).toContain(symbol);
    }
  });

  it("omits the table when no module init survives", () => {
    const program = compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB });
    expect(program.moduleInits).toEqual([]);
    expect(headerOf(program.files)).not.toContain("tera_module_inits");
  });

  it("never lists the entry module", () => {
    const program = compile(NUMERIC_MODULE);
    expect(program.moduleInits ?? []).not.toContain("tera_program");
  });
});

describe("whole-program internalization", () => {
  function compileWhole(files: Record<string, string>, entry?: string): AotProgram {
    const root = project(files);
    return nodeEngine().compileAotModule(path.join(root, "main.tera"), {
      root,
      wholeProgram: true,
      ...(entry === undefined ? {} : { entry }),
    });
  }

  it("hides every symbol but the entry", () => {
    const source = cSource(compileWhole({ "main.tera": MAIN, "mathlib.tera": MATHLIB }));
    expect(source).toContain("static int32_t mathlib_square(int32_t");
    expect(source).toContain("static int32_t total(int32_t");
  });

  it("keeps a named entry exported so the C stub can call it", () => {
    const program = compileWhole({ "main.tera": MAIN, "mathlib.tera": MATHLIB }, "total");
    const header = String(program.files.find((file) => file.name.endsWith(".h"))!.contents);
    expect(header).toContain("int32_t total(int32_t");
    expect(header).not.toContain("mathlib_square");
  });

  it("leaves public symbols exported when not building whole-program", () => {
    const source = cSource(compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB }));
    expect(source).not.toContain("static int32_t mathlib_square(int32_t");
  });

  itNative("still runs after internalization", () => {
    const program = compileWhole({ "main.tera": MAIN, "mathlib.tera": MATHLIB }, "total");
    expect(runCFunction(cSource(program), "total", [7])).toBe(50);
  });
});
