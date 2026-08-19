import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

const TEXT = 's = "abcde"';
const AT = ["fn at(t: string, i: int) -> string:", "  return t[i]"];
const OUT_OF_RANGE = "string index is out of range";

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

const IN_RANGE: readonly (readonly [string, string])[] = [
  ["reads the last character through -1", src(TEXT, "print(s[-1])")],
  ["reads the first character through -length", src(TEXT, "print(s[-5])")],
  ["reads the first character through 0", src(TEXT, "print(s[0])")],
  ["reads the last character through length - 1", src(TEXT, "print(s[s.length - 1])")],
  ["reads the only character of a one-character string through -1", src('o = "x"', "print(o[-1])")],
  [
    "counts back from an index only known at run time",
    src(TEXT, "n = 0 - 2", "print(s[n])"),
  ],
  ["counts back inside a function that was handed the string", src(...AT, 'print(at("abc", 0 - 1))')],
  [
    "counts back from the length of a string it just built",
    src(TEXT, "t = s.to_upper_case()", "print(t[-1])"),
  ],
  [
    "walks the whole string backwards through negative indices",
    src(TEXT, "i = 1", "while i <= 5:", "  print(s[0 - i])", "  i = i + 1"),
  ],
  [
    "walks the whole string forwards through positive indices",
    src(TEXT, "i = 0", "while i < 5:", "  print(s[i])", "  i = i + 1"),
  ],
  [
    "leaves char_at answering the empty string off either end",
    src(TEXT, "print(s.char_at(9), s.char_at(-1))"),
  ],
];

const BEYOND_THE_ENDS: readonly (readonly [string, string])[] = [
  ["reading one past the end", src(TEXT, "print(s[5])")],
  ["reading far past the end", src(TEXT, "print(s[99])")],
  ["reading one before the start", src(TEXT, "print(s[-6])")],
  ["reading anything out of an empty string", src('e = ""', "print(e[0])")],
  ["counting back out of an empty string", src('e = ""', "print(e[-1])")],
  ["reading out of range inside a callee", src(...AT, 'print(at("abc", 9))')],
];

describe("negative string subscripts count back from the end", () => {
  for (const [name, source] of IN_RANGE) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }
});

describe("string subscripts beyond either end fault, where the interpreter answers undefined", () => {
  for (const [name, source] of BEYOND_THE_ENDS) {
    itRunsPe(`faults on ${name}`, () => {
      const run = runPe(image(source));

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(OUT_OF_RANGE);
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

  itRunsPe("keeps the output the program wrote before the subscript it faulted on", () => {
    const run = runPe(image(src(TEXT, 'print("before")', "print(s[9])")));

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("before\n");
    expect(run.stderr).toContain(OUT_OF_RANGE);
  });
});
