import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, image, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-parse-number-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents, "utf8");
  }
  return root;
}

const compiled = (source: string) =>
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend: "c" });

const spelled = (text: string): string => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const NEAREST: readonly string[] = [
  "493.08965445287464",
  "247.19405812145894",
  "123456789.123456789",
  "1.0000000000000002",
  "0.30000000000000004",
  "9007199254740993",
  "1234567890123456789",
  "0.1",
  "2.675",
  "3.141592653589793238462643383279502884197169399375105820974944592307816406286",
];

const SCALED: readonly string[] = [
  "1e300",
  "1e-300",
  "1e308",
  "1e309",
  "1e-323",
  "1e-324",
  "1e400",
  "1e-400",
  "5e-324",
  "2.4703282292062327e-324",
  "2.4703282292062328e-324",
  "1.7976931348623157e308",
  "1.7976931348623159e308",
  "2.2250738585072014e-308",
  "1e21",
  "1e-7",
  "6.02214076e23",
];

const SPELLINGS: readonly string[] = [
  "0",
  "-0",
  "+1",
  " 42 ",
  "42abc",
  "abc",
  "",
  ".5",
  "5.",
  "1e",
  "1e+",
  "1e5x",
  "0.1e1",
  "Infinity",
  "-Infinity",
  "Infinit",
  "0x10",
  "010",
  "00.5",
  "\t 3.25 ",
  "1_000",
  "1,5",
  "12345678901234567890",
  "99999999999999999999999999",
  "0.000000000000000000001",
];

const READERS: readonly string[] = ["parse_float", "parse_int", "Number"];

const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["values that round to the nearest double", NEAREST],
  ["values at the edges of the exponent range", SCALED],
  ["spellings that are not plain decimals", SPELLINGS],
];

function printsEvery(reader: string, texts: readonly string[]): string {
  return texts.map((text) => `print(${reader}(${spelled(text)}))`).join("\n");
}

function readsEachLine(reader: string): string {
  return src(
    'count: int = Math.trunc(parse_float(input("")))',
    "seen: int = 0",
    "while seen < count:",
    '  line: string = input("")',
    `  print(${reader}(line))`,
    "  seen = seen + 1",
  );
}

function interpretedLines(source: string, lines: readonly string[]): string {
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

function interpretedModule(entry: string, root: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).runModule(entry, {
    root,
  });
  return stream.join("");
}

function agreesGiven(source: string, lines: readonly string[]): void {
  const run = runPe(image(source), lines.map((line) => `${line}\r\n`).join(""));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpretedLines(source, lines));
}

function agreesOnRead(reader: string, texts: readonly string[]): void {
  agreesGiven(readsEachLine(reader), [String(texts.length), ...texts]);
}

describe("reading a number out of text", () => {
  for (const reader of READERS) {
    it(`compiles ${reader} rather than refusing it`, () => {
      expect(compiled(`print(${reader}("1.5"))`).skipped).toEqual([]);
    });
  }

  for (const [what, texts] of GROUPS) {
    for (const reader of READERS) {
      itRunsPe(`answers ${reader} the way the interpreter does for ${what}`, () => {
        peAgrees(printsEvery(reader, texts));
      });

      itNative(
        `answers ${reader} the same way through the C backend for ${what}`,
        native.agrees(printsEvery(reader, texts)),
      );
    }
  }

  for (const reader of READERS) {
    itRunsPe(`answers ${reader} the way the interpreter does for text it reads in`, () => {
      agreesOnRead(reader, [...NEAREST, ...SCALED, ...SPELLINGS]);
    });
  }

  itRunsPe("reads the numbers inside a JSON document the way the interpreter does", () => {
    peAgrees(
      src(
        "type Doc = { size: float, count: float }",
        'd: Doc = JSON.parse("{\\"size\\": 493.08965445287464, \\"count\\": 1e300}")',
        "print(d.size, d.count)",
      ),
    );
  });

  itRunsPe("still counts characters elsewhere in a program that reads a number", () => {
    agreesGiven(
      src(
        "fn width(t: string) -> int:",
        "  n: int = 0",
        "  i: int = 0",
        "  while i < t.length:",
        "    c: int = t.char_code_at(i)",
        "    if c == 32:",
        "      n = n + 2",
        "    else if c >= 97 and c <= 122:",
        "      n = n + 5",
        "    else:",
        "      n = n + 11",
        "    i = i + 1",
        "  return n",
        "",
        "fn go() -> float:",
        '  s: string = input("")',
        "  return parse_float(s)",
        "",
        'print(width("hello"), width("a big world"))',
        "print(go())",
      ),
      ["1.5"],
    );
  });

  itRunsPe("reads a number the same way from an imported module", () => {
    const root = project({
      "main.tera": src(
        "from lib import read",
        'print(read("493.08965445287464"))',
        'print(read("1e300"))',
        "",
      ),
      "lib.tera": src("fn read(t: string) -> float:", "  return parse_float(t)", ""),
    });
    const entry = path.join(root, "main.tera");
    const program = nodeEngine({ typecheck: "off" }).compileAotModule(entry, {
      root,
      backend: "x64-windows",
      format: "executable",
    });
    expect(program.skipped).toEqual([]);
    const run = runPe(program.files[0]!.contents as Uint8Array);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(interpretedModule(entry, root));
  });
});
