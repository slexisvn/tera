import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(
    `${source}\n`,
  );
  return stream.join("");
}

function agrees(source: string): void {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  const run = runPe(program.files[0]!.contents as Uint8Array);

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

/** An empty needle matches in the gaps, which is where the two members part ways. */
const PROGRAMS: readonly (readonly [string, string])[] = [
  ["puts the replacement in front of the text", 'print("abcde".replace("", "-"))'],
  ["puts the replacement between every character", 'print("abcde".replace_all("", "-"))'],
  ["replaces the whole of an empty text", 'print("".replace("", "-"))'],
  ["leaves an empty text with no gaps to fill", 'print("".replace_all("", "-"))'],
  ["puts the replacement in front of one character", 'print("a".replace("", "-"))'],
  ["leaves one character with no gaps to fill", 'print("a".replace_all("", "-"))'],
  ["fills every gap with nothing", 'print("abc".replace_all("", ""))'],
  ["replaces only the first of several matches", 'print("aaa".replace("a", "-"))'],
  ["replaces every one of several matches", 'print("aaa".replace_all("a", "-"))'],
  ["replaces overlapping matches left to right", 'print("aaa".replace_all("aa", "-"))'],
  ["leaves text that has no match", 'print("abc".replace("z", "-"))'],
  ["leaves text that has no match anywhere", 'print("abc".replace_all("z", "-"))'],
  ["drops every match for an empty replacement", 'print("aaa".replace_all("a", ""))'],
  ["replaces the whole text", 'print("abc".replace_all("abc", "-"))'],
  [
    "replaces inside text held by a variable",
    src('s = "a.b.c"', 'print(s.replace_all(".", "/"))'),
  ],
  [
    "replaces a longer needle with a longer replacement",
    src('s = "one two one"', 'print(s.replace_all("one", "three"))'),
  ],
];

describe("replace and replace_all", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }
});
