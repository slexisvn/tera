import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCStringFunction } from "../../../helpers/c-executor.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

const RENDER = src("fn render(x: float) -> string:", "  return x.to_string()");

function compiled(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, { backend: "c" });
  expect(program.skipped).toEqual([]);
  return program;
}

const SHORTEST_ROUND_TRIP = [0.1, 1 / 3, 4.35, 9.999999999999999e22, 4503599627370497];
const FORM_BOUNDARIES = [1, -0.25, 1e21, 1e20, 1e-6, 1e-7, 123456789.5];
const EXTREMES = [0, 5e-324, 1.7976931348623157e308, 2.2250738585072014e-308];

describe("AOT float text", () => {
  itNative("renders each sampled double exactly the way the interpreter does", () => {
    const source = cSource(compiled(RENDER));
    const sampled = [...SHORTEST_ROUND_TRIP, ...FORM_BOUNDARIES, ...EXTREMES];

    expect(sampled.map((value) => runCStringFunction(source, "render", [value]))).toEqual(
      sampled.map((value) => String(value)),
    );
  });

  itRunsPe("renders each sampled double natively the way the interpreter does", () => {
    const sampled = [...SHORTEST_ROUND_TRIP, ...FORM_BOUNDARIES, ...EXTREMES];
    const printed = sampled.map((value) => `print(${value.toExponential()})`).join("\n");
    const program = nodeEngine({ typecheck: "off" }).compileAot(`${printed}\n`, {
      backend: "x64-windows",
      format: "executable",
    });

    expect(program.skipped).toEqual([]);
    const run = runPe(program.files[0]!.contents as Uint8Array);
    expect(run.stdout).toBe(sampled.map((value) => `${String(value)}\n`).join(""));
  });

  it("interpolates a float into a template the way the interpreter does", () => {
    const source = src(
      "fn label(x: float) -> string:",
      "  return `area ${x}`",
      "",
      "print(label(2.25))",
    );

    expect(compiled(source).skipped).toEqual([]);
    expect(nodeEngine({ typecheck: "off" }).runNative(`${source}\nlabel(2.25)`)).toBe(
      "area 2.25",
    );
  });

  it("interpolates an integer into a template the way the interpreter does", () => {
    const source = src("fn label(n: int) -> string:", "  return `n=${n}`");

    expect(compiled(source).skipped).toEqual([]);
    expect(nodeEngine({ typecheck: "off" }).runNative(`${source}\nlabel(7)`)).toBe("n=7");
  });
});
