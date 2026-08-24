import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

function program(source: string, backend = "x64-windows") {
  const built = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend,
    format: backend === "c" ? "assembly" : "executable",
  });
  expect(built.skipped).toEqual([]);
  return built;
}

function ran(source: string): string {
  const run = runPe(program(source).files[0]!.contents as Uint8Array);
  expect(run.status).toBe(0);
  return run.stdout;
}

const IN_RANGE = src(
  "r = Math.random()",
  "print(r >= 0.0 and r < 1.0)",
);

const DISTINCT = src(
  "seen = Set()",
  "for i of range(0, 200):",
  "  seen.add(Math.random())",
  "print(seen.size)",
);

const SPREAD = src(
  "below = 0",
  "for i of range(0, 2000):",
  "  if Math.random() < 0.5:",
  "    below = below + 1",
  "print(below > 850 and below < 1150)",
);

const SAMPLE = src("print(Math.floor(Math.random() * 1000000000.0))");

describe("AOT Math.random", () => {
  it("compiles a program that draws a random number", () => {
    expect(() => program(IN_RANGE)).not.toThrow();
  });

  it("gives the C backend a generator of its own", () => {
    expect(cSource(program(IN_RANGE, "c"))).toContain("tera_random");
  });

  itRunsPe("answers a value the unit interval holds", () => {
    expect(ran(IN_RANGE)).toBe("true\n");
  });

  itRunsPe("answers a different value every draw", () => {
    expect(ran(DISTINCT)).toBe("200\n");
  });

  itRunsPe("spreads its draws over the interval", () => {
    expect(ran(SPREAD)).toBe("true\n");
  });

  itRunsPe("starts from a different place on each run", () => {
    const image = program(SAMPLE).files[0]!.contents as Uint8Array;
    const runs = new Set([runPe(image).stdout, runPe(image).stdout, runPe(image).stdout]);

    expect(runs.size).toBe(3);
  });

  itNative("draws inside the unit interval through the C backend", () => {
    const run = runCProgram(cSource(program(IN_RANGE, "c")));

    expect([run.status, run.stdout]).toEqual([0, "true\n"]);
  });
});
