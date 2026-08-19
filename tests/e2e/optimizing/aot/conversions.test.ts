import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string, lines: readonly string[] = []): string {
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

function agrees(source: string, lines: readonly string[] = []): void {
  const run = runPe(image(source), lines.map((line) => `${line}\r\n`).join(""));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source, lines));
}

const TEXTS: readonly string[] = [
  "42",
  "  7  ",
  "3x",
  "-5",
  "+8",
  "3.7",
  "0",
  "abc",
  "",
];

const NUMERIC_TEXTS: readonly string[] = [
  "2.5",
  "-0.25",
  "0.1",
  "7",
  "1e3",
  "1.5e-2",
  "6.02e5",
  "0.0",
  "-0",
  "123.456",
  "zz",
  "1e",
];

describe("string to number conversions", () => {
  for (const text of TEXTS) {
    itRunsPe(`parses ${JSON.stringify(text)} as an int the way the interpreter does`, () =>
      agrees(`print(parse_int(${JSON.stringify(text)}))`));
  }

  for (const text of NUMERIC_TEXTS) {
    itRunsPe(`parses ${JSON.stringify(text)} as a float the way the interpreter does`, () =>
      agrees(`print(parse_float(${JSON.stringify(text)}))`));
  }

  itRunsPe("renders an int with String the way the interpreter does", () =>
    agrees("print(String(3))"));

  itRunsPe("renders a float with String the way the interpreter does", () =>
    agrees("print(String(2.5))"));

  itRunsPe("passes a string through String unchanged", () =>
    agrees('print(String("x"))'));

  itRunsPe("renders with String inside a concatenation", () =>
    agrees(src("n = 7", 'print("n=" + String(n))')));

  itRunsPe("reads a number out of text with Number", () => agrees('print(Number("42"))'));

  itRunsPe("reads a fraction out of text with Number", () => agrees('print(Number("3.5"))'));

  itRunsPe("hands a number Number was given straight back", () =>
    agrees(src("print(Number(42), Number(1.5))")));

  itRunsPe("counts a boolean Number was given", () =>
    agrees(src("b = 1 < 2", "print(Number(b), Number(2 < 1))")));

  itRunsPe("reads a number from stdin through Number", () =>
    agrees(src('n = Number(input(""))', "print(n * 2.0)"), ["21"]));

  itRunsPe("reads a number from stdin and computes with it", () =>
    agrees(src('n = parse_int(input("n: "))', "print(n + 1)"), ["5"]));

  itRunsPe("reads a float from stdin and computes with it", () =>
    agrees(src('x = parse_float(input("x: "))', "print(x * 2.0)"), ["1.25"]));

  itRunsPe("keeps a parsed value usable in arithmetic and comparison", () =>
    agrees(
      src(
        'total = parse_int("10") + parse_int("32")',
        "print(total)",
        "if total > 40:",
        '  print("big")',
      ),
    ));

  itNative("routes each conversion through its own C helper", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "fn f(a: string, b: string) -> float:",
        "  return parse_int(a) + parse_float(b)",
        "",
      ),
    );

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("tera_parse_int(");
    expect(cSource(program)).toContain("tera_parse_float(");
  });

  itNative("keeps the C backend in lockstep on one case per conversion", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("fn f() -> float:", '  return parse_int("40") + parse_float("2.5")', ""),
    );

    expect(runCFunction(cSource(program), "f", [])).toBe(42.5);
  });
});
