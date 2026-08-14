import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import { BackendLoweringError } from "../../../src/optimizing/target/errors.js";
import type { TeraCompilerExtension } from "../../../src/api/extensions.js";

const src = (...lines: string[]) => lines.join("\n");

const hotLoop = src(
  "fn run(n):",
  "  i = 0",
  "  t = 0",
  "  while i < n:",
  "    t = t + i",
  "    i = i + 1",
  "  return t",
  "k = 0",
  "while k < 200:",
  "  run(5)",
  "  k = k + 1",
);

function throwingPass(error: () => Error): TeraCompilerExtension {
  return {
    optimizerPasses: [
      {
        name: "explode",
        phase: "ir",
        run: () => {
          throw error();
        },
      },
    ],
  };
}

function optimize(compiler: TeraCompilerExtension) {
  const engine = nodeEngine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
    compiler,
  });
  engine.runNative(hotLoop);
  const fn = engine.collectFunctions().find((candidate) => candidate.name === "run");
  expect(fn).toBeDefined();
  return fn!;
}

describe("JIT compile failures are classified", () => {
  it("permanently disables optimization when the compiler itself throws", () => {
    const fn = optimize(throwingPass(() => new TypeError("cannot read x of undefined")));

    expect(fn.disableOptimization).toBe(true);
    expect(fn.lastCompileFailureReason).toContain("internal compiler error");
    expect(fn.optimizedCode).toBeFalsy();
  });

  it("only cools down when the target legitimately cannot lower the graph", () => {
    const fn = optimize(throwingPass(() => new BackendLoweringError("target says no")));

    expect(fn.disableOptimization).toBe(false);
    expect(fn.lastCompileFailureReason).toBe("target says no");
    expect(fn.lastCompileFailureReason).not.toContain("internal compiler error");
    expect(fn.optimizationCooldownUntil).toBeGreaterThan(0);
  });

  it("keeps the program running and correct either way", () => {
    const engine = nodeEngine({
      typecheck: "off",
      tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
      compiler: throwingPass(() => new TypeError("boom")),
    });

    expect(engine.runNative(src(hotLoop, "run(10)"))).toBe(45);
  });
});

describe("AOT compile failures are classified", () => {
  it("surfaces an internal compiler error instead of silently skipping the function", () => {
    const engine = nodeEngine({
      typecheck: "off",
      compiler: throwingPass(() => new TypeError("cannot read x of undefined")),
    });

    expect(() =>
      engine.compileAot(src("fn answer():", "  return 42"), { functionNames: ["answer"] }),
    ).toThrow("cannot read x of undefined");
  });

  it("records a genuine lowering limit as skipped", () => {
    const engine = nodeEngine({ typecheck: "off" });
    const program = engine.compileAot(
      src("fn answer():", "  o = {a: 1}", "  return o.a"),
      { functionNames: ["answer"] },
    );

    expect(program.compiled).toEqual([]);
    expect(program.skipped.map((fn) => fn.name)).toEqual(["answer"]);
    expect(program.skipped[0]!.reason).toContain("C backend cannot emit");
  });
});

