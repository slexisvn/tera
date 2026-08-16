import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

function ran(lines: readonly string[]) {
  const program = nodeEngine().compileAot(`${lines.join("\n")}\n`, { wholeProgram: true });
  expect(program.skipped).toEqual([]);
  return runCProgram(cSource(program));
}

describe("AOT boolean text", () => {
  itNative("prints a comparison as true and false", () => {
    expect(ran(["print(1 < 2)", "print(2 < 1)"]).stdout).toBe("true\nfalse\n");
  });

  itNative("prints the boolean a function returns", () => {
    expect(
      ran([
        "fn positive(n: int) -> bool:",
        "  return n > 0",
        "print(positive(5), positive(-5))",
      ]).stdout,
    ).toBe("true false\n");
  });

  itNative("spells a boolean out when it is concatenated", () => {
    expect(ran(["b = 1 < 2", 'print("b is " + b.to_string())']).stdout).toBe("b is true\n");
  });

  itNative("spells the same boolean out at every use of one call", () => {
    expect(ran(["b = 2 > 1", "print(b, b)"]).stdout).toBe("true true\n");
  });

  itNative("spells a boolean out inside a loop", () => {
    expect(
      ran(["i = 0", "while i < 3:", "  print(i < 2)", "  i += 1"]).stdout,
    ).toBe("true\ntrue\nfalse\n");
  });

  itNative("keeps a boolean numeric where it is not read as text", () => {
    expect(
      ran([
        "fn score(n: int) -> int:",
        "  hit = n > 0",
        "  if hit:",
        "    return 1",
        "  return 0",
        "print(score(4) + score(-4))",
      ]).stdout,
    ).toBe("1\n");
  });
});
