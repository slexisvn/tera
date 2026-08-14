import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string) {
  return nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
  });
}

function interpreted(source: string, lines: readonly string[]): string {
  const stream: string[] = [];
  let index = 0;
  nodeEngine({
    typecheck: "off",
    output: (text) => stream.push(`${text}\n`),
    input: (prompt) => {
      stream.push(prompt);
      return index < lines.length ? lines[index++]! : null;
    },
  }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string, lines: readonly string[]): void {
  const run = runPe(image(source), lines.map((line) => `${line}\r\n`).join(""));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source, lines));
}

describe("print and input as compiled builtins", () => {
  it("admits a print statement whose value is never used", () => {
    const program = compile('print("one")\nprint("two")');

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("tera_print_str");
  });

  it("formats a float the way the interpreter does", () => {
    const source = "print(1.5)\nprint(0.1)\nprint(1e21)";

    expect(compile(source).skipped).toEqual([]);
    expect(interpreted(source, [])).toBe("1.5\n0.1\n1e+21\n");
  });

  it("separates several print arguments with one space and one newline", () => {
    const source = src('print("count:", 2, 5)', 'print("only")');

    expect(compile(source).skipped).toEqual([]);
    expect(interpreted(source, [])).toBe("count: 2 5\nonly\n");
  });

  itRunsPe("prints several arguments natively the way the interpreter does", () => {
    agrees(src('print("count:", 2, 5)', 'print("only")'), []);
  });

  it("declines a print it has no way to format", () => {
    const program = compile('print([1, 2])');

    expect(program.skipped.map((fn) => fn.name)).toEqual(["tera_program"]);
  });

  it("declines a print result used as a value", () => {
    const program = compile('x = print("hi")\nprint(x)');

    expect(program.skipped.map((fn) => fn.name)).toEqual(["tera_program"]);
  });

  it("gives every input call site storage of its own", () => {
    const program = compile(src('a = input("a: ")', 'b = input("b: ")', "print(a)", "print(b)"));

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("static char sb0[");
    expect(cSource(program)).toContain("static char sb1[");
  });

  itNative("keeps two reads apart in generated C", () => {
    const program = compile(src('a = input("a: ")', 'b = input("b: ")', "print(a)", "print(b)"));
    const body = cSource(program);
    const first = body.indexOf("tera_input(sb0");
    const second = body.indexOf("tera_input(sb1");

    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  itRunsPe("writes both lines a program prints", () => {
    agrees(src('print("one")', 'print("two")'), []);
  });

  itRunsPe("prints integers the same way the interpreter does", () => {
    agrees(src("print(0)", "print(7)", "print(0 - 42)", "print(2147483647)"), []);
  });

  itRunsPe("does not let a second read overwrite the first", () => {
    agrees(src('a = input("a: ")', 'b = input("b: ")', "print(a)", "print(b)"), ["one", "two"]);
  });

  itRunsPe("reads inside a loop", () => {
    agrees(
      src("i = 0", "while i < 3:", '  print(input("> "))', "  i = i + 1"),
      ["red", "green", "blue"],
    );
  });

  itRunsPe("returns an empty line once stdin is exhausted", () => {
    agrees(src('first = input("1: ")', 'second = input("2: ")', "print(second.length)"), ["only"]);
  });

  itRunsPe("prompts with nothing when input is called bare", () => {
    agrees(src("print(input())"), ["bare"]);
  });

  itRunsPe("gives each object the line it was built from, not the newest one", () => {
    agrees(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "fn read() -> P:",
        "  return P(input())",
        "a = read()",
        "b = read()",
        "print(a.n)",
        "print(b.n)",
      ),
      ["one", "two"],
    );
  });

  itRunsPe("rewrites only the object a method was called on", () => {
    agrees(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "  public rename(n: string):",
        "    this.n = n",
        "a = P(input())",
        "b = P(input())",
        "a.rename(input())",
        "print(a.n)",
        "print(b.n)",
      ),
      ["one", "two", "three"],
    );
  });

  itRunsPe("keeps every line apart when one read serves all of them", () => {
    agrees(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "fn read() -> P:",
        "  return P(input())",
        "a = read()",
        "b = read()",
        "c = read()",
        "print(a.n)",
        "print(b.n)",
        "print(c.n)",
      ),
      ["one", "two", "three"],
    );
  });
});
