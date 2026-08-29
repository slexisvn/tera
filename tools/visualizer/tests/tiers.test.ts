import { describe, expect, it } from "vitest";
import { compareTiers } from "../src/workers/tiers";
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

const THROWS = ["fn boom() -> int:", '  throw "no answer here"', "", "print(boom())"].join("\n");

function request(source: string, over: Partial<RunRequest> = {}): RunRequest {
  return {
    source,
    pipeline: "jit",
    optLevel: "speed",
    target: "wasm",
    verify: false,
    ...over,
  };
}

describe("comparing the tiers", () => {
  it("runs the interpreter, the baseline and both JIT settings", () => {
    const report = compareTiers(request(HOT));

    expect(report.rows.map((row) => row.id)).toEqual([
      "interpreter",
      "baseline",
      "jit-plain",
      "jit",
    ]);
  });

  it("agrees on a program every tier gets right", () => {
    const report = compareTiers(request(HOT));

    expect(report.verdict).toBe("agree");
    expect(report.firstBad).toBeNull();
    for (const row of report.rows) expect(row.lines).toEqual(["89634"]);
  });

  it("adds the build as its own row for an AOT target", () => {
    const report = compareTiers(request(HOT, { pipeline: "aot", target: "c" }));

    const built = report.rows.find((row) => row.id === "aot");
    expect(built!.kind).toBe("built");
    expect(built!.ok).toBe(true);
  });

  it("still agrees when every tier fails the same way", () => {
    const report = compareTiers(request(THROWS));

    expect(report.verdict).toBe("agree");
    expect(report.rows.every((row) => row.lines.join(" ").includes("threw"))).toBe(true);
  });

  it("runs the optimizing JIT even when the program calls the function once", () => {
    const report = compareTiers(request(CALLED_ONCE));

    expect(report.verdict).toBe("agree");
    expect(report.rows.map((row) => row.lines)).toEqual([
      ["239400"],
      ["239400"],
      ["239400"],
      ["239400"],
    ]);
  });
});
