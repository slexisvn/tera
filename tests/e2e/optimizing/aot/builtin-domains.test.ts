import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

const TEXT = 's = "abcde"';
const NO_CODE = "no character code at that index";
const NO_REPEAT = "cannot repeat text a negative number of times";
const BY_ZERO = "cannot take the remainder by zero";

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(
    `${source}\n`,
  );
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

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function agreesInC(source: string): void {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
  });

  expect(program.skipped).toEqual([]);
  expect(runCProgram(cSource(program)).stdout).toBe(interpreted(source));
}

const IN_DOMAIN: readonly (readonly [string, string])[] = [
  ["reads the code of the first character", src(TEXT, "print(s.char_code_at(0))")],
  ["reads the code of the last character", src(TEXT, "print(s.char_code_at(4))")],
  ["repeats text no times", src(TEXT, "print(s.repeat(0))")],
  ["repeats text twice", src(TEXT, "print(s.repeat(2))")],
  ["takes a remainder by a literal", src("n = 7", "print(n % 3)")],
  ["takes a remainder by a run-time divisor", src("d = 3", "print(7 % d)")],
  ["takes a negative remainder", src("d = 3", "print((0 - 7) % d)")],
  ["takes a remainder by a length", src("xs: int[] = [1, 2]", "print(5 % xs.length)")],
  [
    "takes a remainder every turn of a loop",
    src("i = 0", "while i < 5:", "  print(i % 2)", "  i = i + 1"),
  ],
  ["keeps the remainder of the smallest int by -1", src("n = 0 - 2147483648", "m = 0 - 1", "print(n % m)")],
  ["divides by a run-time zero, which is a float and stays Infinity", src("z = 0", "print(7 / z)")],
];

const OUT_OF_DOMAIN: readonly (readonly [string, string, string])[] = [
  ["a character code one past the end", src(TEXT, "print(s.char_code_at(5))"), NO_CODE],
  ["a character code before the start", src(TEXT, "print(s.char_code_at(-1))"), NO_CODE],
  ["a character code of an empty string", src('e = ""', "print(e.char_code_at(0))"), NO_CODE],
  ["repeating text a negative number of times", src(TEXT, "print(s.repeat(-1))"), NO_REPEAT],
  ["a remainder by a run-time zero", src("z = 0", "print(7 % z)"), BY_ZERO],
  [
    "a remainder by the length of an empty array",
    src("xs: int[] = []", "print(5 % xs.length)"),
    BY_ZERO,
  ],
];

describe("builtins answer inside their domain the way the interpreter does", () => {
  for (const [name, source] of IN_DOMAIN) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }
});

describe("builtins fault outside their domain, where the interpreter answers NaN or raises", () => {
  for (const [name, source, message] of OUT_OF_DOMAIN) {
    itRunsPe(`faults on ${name}`, () => {
      const run = runPe(image(source));

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(message);
      expect(run.stdout).toBe("");
    });

    itNative(`faults on ${name} through the C backend`, () => {
      const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
        backend: "c",
        format: "assembly",
      });

      expect(program.skipped).toEqual([]);
      expect(runCProgram(cSource(program)).status).not.toBe(0);
    });
  }

  it("compiles a remainder by a non-zero literal without a guard to fault through", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("n = 7", "print(n % 3)", ""),
    );

    expect(program.skipped).toEqual([]);
  });
});
describe("AOT Math surface", () => {
  itRunsPe("raises to a spelled-out whole power", () => {
    agrees(
      src(
        "print(Math.pow(2.0, 10.0))",
        "print(Math.pow(3.0, 0.0))",
        "print(Math.pow(1.5, 3.0))",
        "fn cube(x: float) -> float:",
        "  return Math.pow(x, 3.0)",
        "print(cube(4.0))",
      ),
    );
  });

  itRunsPe("folds min and max over more than two values", () => {
    agrees(src("print(Math.max(3, 7, 2), Math.min(3, 7, 2))", "print(Math.max(1, 2, 3, 4))"));
  });

  itRunsPe("spells the Math constants", () => {
    agrees(src("print(Math.PI)", "print(Math.E)"));
  });

  it("declines a power the compiler cannot expand", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("fn f(x: float, y: float) -> float:", "  return Math.pow(x, y)", "print(f(2.0, 3.0))", ""),
    );

    expect(program.skipped.map((entry) => entry.reason).join("; ")).toContain("pow");
  });
});
