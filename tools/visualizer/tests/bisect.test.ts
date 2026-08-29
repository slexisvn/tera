import { describe, expect, it } from "vitest";
import { bisect, firstBadLimit } from "../src/workers/bisect";
import type { RunRequest } from "../src/types/stage";

const HOT = [
  "fn pick(n: int) -> int:",
  "  if (n > 10):",
  "    return (n * 2)",
  "  return (n - 1)",
  "",
  "fn drive(n: int) -> int:",
  "  last = 0",
  "  i = 0",
  "  while (i < n):",
  "    last = (last + pick(i))",
  "    i = (i + 1)",
  "  return last",
  "",
  "print(drive(300))",
].join("\n");

const COLD = ["print(1 + 2)"].join("\n");

const CALLED_ONCE = [
  "fn work(n: int) -> int:",
  "  total = 0",
  "  i = 0",
  "  while (i < n):",
  "    total = (total + (i * 3))",
  "    i = (i + 1)",
  "  return total",
  "",
  "print(work(400))",
].join("\n");

function jit(source: string): RunRequest {
  return { source, pipeline: "jit", optLevel: "speed", target: "wasm", verify: false };
}

describe("the bisect search", () => {
  it("finds the first limit that differs", () => {
    const asked: number[] = [];
    const found = firstBadLimit(64, (limit) => {
      asked.push(limit);
      return limit >= 23;
    });

    expect(found).toBe(23);
    expect(asked.length).toBeLessThanOrEqual(7);
  });

  it("blames the very first pass when even one is enough", () => {
    expect(firstBadLimit(40, () => true)).toBe(1);
  });

  it("blames the last pass when only the whole pipeline differs", () => {
    expect(firstBadLimit(40, (limit) => limit === 40)).toBe(40);
  });
});

describe("bisecting a real compile", () => {
  it("clears every optional pass when the JIT agrees with the interpreter", () => {
    const report = bisect(jit(HOT));

    expect(report.verdict).toBe("clean");
    expect(report.total).toBeGreaterThan(0);
    expect(report.reference).toEqual(["89634"]);
    expect(report.observed).toEqual(["89634"]);
  });

  it("still has passes to bisect for a program with no function of its own", () => {
    const report = bisect(jit(COLD));

    expect(report.verdict).toBe("clean");
    expect(report.total).toBeGreaterThan(0);
  });

  it("keeps the search to a handful of compiles", () => {
    const report = bisect(jit(HOT));

    expect(report.compiles).toBeLessThanOrEqual(4);
  });

  it("optimizes a function the program calls once, like the pipeline pane does", () => {
    const report = bisect(jit(CALLED_ONCE));

    expect(report.verdict).not.toBe("no-passes");
    expect(report.total).toBeGreaterThan(0);
    expect(report.reference).toEqual(["239400"]);
  });
});
