import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { cCalls } from "../../../helpers/aot-agreement.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { TERA_EXIT_UNCAUGHT_THROW } from "../../../../src/optimizing/target/faults.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string, backend = "c") {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend });
  expect(program.skipped).toEqual([]);
  return program;
}

const native = cCalls({
  toC: (source: string) => cSource(compile(source)),
  interpret: (source: string, call: string) => interpret(source, call),
});

function interpret(source: string, call: string): unknown {
  return nodeEngine({ typecheck: "off" }).runNative(`${source}\n${call}\n`);
}

function image(source: string, entry: string | null = null): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
    ...(entry === null ? {} : { entry }),
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

const BOX = [
  "class Box:",
  "  public constructor(w: int = 2, h: int = 3):",
  "    this.w = w",
  "    this.h = h",
  "  public area() -> int:",
  "    return this.w * this.h",
  "  public scaled(by: int = 10) -> int:",
  "    return this.area() * by",
];

describe("AOT default arguments", () => {
  itNative("fills a constructor default the caller left out", native.matches(
      src(...BOX, "fn go(w: int) -> int:", "  return Box(w).area()"),
      "go",
      [5],
    ));

  itNative("fills every constructor default when none are given", native.matches(src(...BOX, "fn go() -> int:", "  return Box().area()"), "go", []));

  itNative("fills a method default", native.matches(
      src(...BOX, "fn go(w: int) -> int:", "  return Box(w).scaled()"),
      "go",
      [4],
    ));

  itNative("fills a plain function default", native.matches(
      src("fn twice(a: int, b: int = 5) -> int:", "  return a * b", "fn go(a: int) -> int:", "  return twice(a)"),
      "go",
      [6],
    ));

  itNative("fills a default skipped over by a named argument", native.matches(
      src(...BOX, "fn go() -> int:", "  return Box(h=10).area()"),
      "go",
      [],
    ));

  itNative("leaves an omitted optional parameter absent", native.matches(
      src(
        "fn f(a: int, b?: int) -> int:",
        "  return b == null ? a : a + b",
        "fn go(n: int) -> int:",
        "  return f(n)",
      ),
      "go",
      [7],
    ));

  itNative("passes an optional parameter that is supplied", native.matches(
      src(
        "fn f(a: int, b?: int) -> int:",
        "  return b == null ? a : a + b",
        "fn go(n: int) -> int:",
        "  return f(n, 5)",
      ),
      "go",
      [7],
    ));

  itNative("leaves an omitted optional string absent", native.matches(
      src(
        "fn f(a: int, s?: string) -> string:",
        '  return s == null ? "none" : s',
        "fn go(n: int) -> int:",
        "  return f(n).length",
      ),
      "go",
      [1],
    ));

  it("declines a call whose omitted parameter has no literal default", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "fn base() -> int:",
        "  return 9",
        "fn f(a: int, b: int = base()) -> int:",
        "  return a + b",
        "fn go() -> int:",
        "  return f(1)",
      ),
      { backend: "c" },
    );

    expect(program.skipped.map((fn) => fn.reason).join("; ")).toContain(
      "call to f passes 1 of 2 arguments",
    );
  });

  itRunsPe("runs defaulted calls natively", () => {
    const run = runPe(image(src(...BOX, "print(Box().area())", "print(Box(5).scaled())")));

    expect([run.status, run.stdout]).toEqual([0, "6\n150\n"]);
  });
});

describe("AOT uncaught throw", () => {
  it("compiles a throw as a program-terminating call", () => {
    const program = compile(src("fn guard(n: int) -> int:", '  if n < 0:', '    throw "negative"', "  return n"));

    expect(cSource(program)).toContain("tera_throw(");
  });

  itRunsPe("reports the message on stderr and exits non-zero", () => {
    const run = runPe(
      image(src('print("before")', 'throw "insufficient funds"', 'print("after")')),
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([
      TERA_EXIT_UNCAUGHT_THROW,
      "before\n",
      "Uncaught insufficient funds\n",
    ]);
  });

  itRunsPe("stays silent and exits zero when the program catches the throw", () => {
    const run = runPe(
      image(src("try:", '  throw "x"', "catch e:", "  print(e)", 'print("after")')),
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([0, "x\nafter\n", ""]);
  });

  itRunsPe("reports a throw that escapes the handler it was raised in", () => {
    const run = runPe(
      image(src("try:", '  print("guarded")', "catch e:", '  print("skipped")', 'throw "later"')),
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([
      TERA_EXIT_UNCAUGHT_THROW,
      "guarded\n",
      "Uncaught later\n",
    ]);
  });
});

describe("examples/classes.tera as a standalone binary", () => {
  const source = readFileSync("examples/classes.tera", "utf8");

  it("compiles every function in the example", () => {
    expect(compile(source.trimEnd()).skipped).toEqual([]);
  });

  itRunsPe("prints exactly what the interpreter prints", () => {
    const printed: string[] = [];
    nodeEngine({ typecheck: "off", output: (text) => printed.push(`${text}\n`) }).run(source);
    const run = runPe(image(source.trimEnd()));

    expect([run.status, run.stdout]).toEqual([0, printed.join("")]);
  });
});
