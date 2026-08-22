import { describe, expect } from "vitest";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, interpreted, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

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
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }
});
