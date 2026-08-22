import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCFunction, runCStringFunction } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n") + "\n";

function compile(source: string) {
  return nodeEngine().compileAot(source);
}

describe("AOT control flow", () => {
  itNative("compiles an if/else whose branches both return", () => {
    const program = compile(
      `fn grade(score: int) -> int:\n  if score >= 90:\n    return 1\n  else:\n    return 0\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "grade", [95])).toBe(1);
    expect(runCFunction(cSource(program), "grade", [40])).toBe(0);
  });

  itNative("compiles an else-if chain in which every arm returns", () => {
    const program = compile(
      `fn grade(score: int) -> string:\n` +
        `  if score >= 90:\n    return "A"\n` +
        `  else if score >= 75:\n    return "B"\n` +
        `  else if score >= 60:\n    return "C"\n` +
        `  else:\n    return "F"\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCStringFunction(cSource(program), "grade", [95])).toBe("A");
    expect(runCStringFunction(cSource(program), "grade", [80])).toBe("B");
    expect(runCStringFunction(cSource(program), "grade", [65])).toBe("C");
    expect(runCStringFunction(cSource(program), "grade", [10])).toBe("F");
  });

  itNative("keeps the code that follows a partially returning if", () => {
    const program = compile(
      `fn clamp(n: int) -> int:\n  if n < 0:\n    return 0\n  return n * 2\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "clamp", [-5])).toBe(0);
    expect(runCFunction(cSource(program), "clamp", [5])).toBe(10);
  });

  itNative("drops the statements that follow a return inside a branch", () => {
    const program = compile(
      `fn pick(n: int) -> int:\n` +
        `  acc = 0\n` +
        `  if n > 0:\n    return n\n    acc = 99\n` +
        `  else:\n    return -n\n    acc = 77\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "pick", [7])).toBe(7);
    expect(runCFunction(cSource(program), "pick", [-7])).toBe(7);
  });

  itNative("returns from inside a loop that sits after another return", () => {
    const program = compile(
      `fn first_over(limit: int, count: int) -> int:\n` +
        `  if count <= 0:\n    return -1\n  else:\n    i = 0\n` +
        `    while i < count:\n      if i > limit:\n        return i\n      i = i + 1\n` +
        `    return -1\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "first_over", [3, 10])).toBe(4);
    expect(runCFunction(cSource(program), "first_over", [3, 0])).toBe(-1);
    expect(runCFunction(cSource(program), "first_over", [30, 10])).toBe(-1);
  });
});

const NAMED = src(
  "fn name(v: int) -> string:",
  "  switch v:",
  "    case 1:",
  '      return "one"',
  "    case 2:",
  '      return "two"',
  "    default:",
  '      return "other"',
);

const COUNTED = src(
  "fn size(v: string) -> int:",
  "  switch v:",
  '    case "small":',
  "      return 1",
  '    case "large":',
  "      return 3",
  "    default:",
  "      return 0",
);

const FALLS_THROUGH = src(
  "fn band(v: int) -> int:",
  "  switch v:",
  "    case 1:",
  "    case 2:",
  "      return 10",
  "    default:",
  "      return 20",
);

const BREAKS = src(
  "fn label(v: int) -> int:",
  "  out = 0",
  "  switch v:",
  "    case 1:",
  "      out = 11",
  "      break",
  "    default:",
  "      out = 22",
  "  return out",
);

describe("AOT switch", () => {
  itNative("picks the arm that matches an int subject", () => {
    const program = compile(NAMED);

    expect(program.skipped).toEqual([]);
    expect(runCStringFunction(cSource(program), "name", [1])).toBe("one");
    expect(runCStringFunction(cSource(program), "name", [2])).toBe("two");
  });

  itNative("falls back to the default arm", () => {
    const program = compile(NAMED);

    expect(runCStringFunction(cSource(program), "name", [9])).toBe("other");
  });

  itNative("matches a string subject", () => {
    const program = compile(COUNTED);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "size", ["small"])).toBe(1);
    expect(runCFunction(cSource(program), "size", ["large"])).toBe(3);
    expect(runCFunction(cSource(program), "size", ["other"])).toBe(0);
  });

  itNative("shares one body between stacked case labels", () => {
    const program = compile(FALLS_THROUGH);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "band", [1])).toBe(10);
    expect(runCFunction(cSource(program), "band", [2])).toBe(10);
    expect(runCFunction(cSource(program), "band", [3])).toBe(20);
  });

  itNative("leaves the switch when an arm breaks", () => {
    const program = compile(BREAKS);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "label", [1])).toBe(11);
    expect(runCFunction(cSource(program), "label", [2])).toBe(22);
  });

  it("refuses a case label that can never equal the subject", () => {
    expect(() =>
      compile(
        src(
          "fn name(v: int) -> string:",
          "  switch v:",
          '    case "a":',
          '      return "one"',
          "    default:",
          '      return "other"',
        ),
      ),
    ).toThrow(/not comparable to switch subject type 'int'/);
  });
});
