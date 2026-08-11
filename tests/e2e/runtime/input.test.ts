import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/index.js";

type Session = {
  output: string[];
  prompts: string[];
  run(source: string): unknown;
};

const session = (lines: (string | null)[]): Session => {
  const output: string[] = [];
  const prompts: string[] = [];
  let index = 0;
  const engine = new Engine({
    output: (text) => output.push(String(text)),
    input: (prompt) => {
      prompts.push(prompt);
      return index < lines.length ? lines[index++]! : null;
    },
  });
  return { output, prompts, run: (source) => engine.runNative(source) };
};

describe("input() builtin", () => {
  it("passes the prompt to the engine input hook and returns the line", () => {
    const s = session(["H2+O2->H2O"]);
    s.run('abc = input("Enter equation: ")\nprint(abc)');
    expect(s.prompts).toEqual(["Enter equation: "]);
    expect(s.output).toEqual(["H2+O2->H2O"]);
  });

  it("passes an empty prompt when called with no argument", () => {
    const s = session(["bare"]);
    expect(s.run("input()")).toBe("bare");
    expect(s.prompts).toEqual([""]);
  });

  it("returns an empty string for an empty line", () => {
    const s = session([""]);
    s.run('line = input("p")\nprint(line == "")\nprint(line.length)');
    expect(s.output).toEqual(["true", "0"]);
  });

  it("returns null once the input is exhausted", () => {
    const s = session(["only"]);
    s.run("first = input()\nsecond = input()\nprint(first)\nprint(second == null)");
    expect(s.output).toEqual(["only", "true"]);
  });

  it("reads successive lines in order", () => {
    const s = session(["1", "2", "3"]);
    s.run("total = 0\nfor i in range(3):\n  total = total + parse_int(input())\nprint(total)");
    expect(s.output).toEqual(["6"]);
  });

  it("returns a string that supports string methods", () => {
    const s = session(["H2O"]);
    s.run('f = input("")\nprint(f.length)\nprint(f.char_at(0))\nprint(f + "!")');
    expect(s.output).toEqual(["3", "H", "H2O!"]);
  });

  it("throws a clear error when no input hook is configured", () => {
    expect(() => new Engine().runNative('input("x")')).toThrow(/'input' engine option/);
  });
});
