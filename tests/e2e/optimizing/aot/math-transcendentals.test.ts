import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const compiled = (source: string) =>
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend: "c" });

const spelled = (value: number): string => {
  const text = String(value).replace("e+", "e");
  const body = text.includes(".") || text.includes("e") ? text : `${text}.0`;
  return body.startsWith("-") ? `(0.0 - ${body.slice(1)})` : body;
};

const OVER = [
  0, 1, -1, 0.5, -0.5, 2, 10, 100,
  Math.PI, Math.PI / 2, Math.PI / 4, 2 * Math.PI,
  709.78, -745, 1e-30, 1e10, 1e100, 1e300, 123456789.123, 0.7853981633974483,
];

function printsEvery(member: string, values: readonly number[]): string {
  return values.map((value) => `print(Math.${member}(${spelled(value)}))`).join("\n");
}

describe("the transcendental Math functions", () => {
  it("answer the same values the host does when interpreted", () => {
    const engine = nodeEngine({ typecheck: "off" });
    expect(engine.runNative("Math.exp(1.0)")).toBeCloseTo(Math.E);
    expect(engine.runNative("Math.sin(Math.PI / 2.0)")).toBeCloseTo(1);
    expect(engine.runNative("Math.cos(Math.PI)")).toBeCloseTo(-1);
    expect(engine.runNative("Math.log(1.0)")).toBeCloseTo(0);
  });

  for (const member of ["exp", "log", "sin", "cos"]) {
    it(`compiles Math.${member} rather than refusing it`, () => {
      const program = compiled(`print(Math.${member}(2.0))`);

      expect(program.skipped).toEqual([]);
    });
  }

  it("leaves the Math functions a backend carries natively alone", () => {
    const program = compiled(src("print(Math.sqrt(2.0))", "print(Math.abs(0.0 - 1.0))"));

    expect(program.skipped).toEqual([]);
  });

  for (const member of ["exp", "log", "sin", "cos"]) {
    itRunsPe(`answers Math.${member} the way the interpreter does`, () => {
      peAgrees(printsEvery(member, OVER));
    });

    itNative(
      `answers Math.${member} the same way through the C backend`,
      native.agrees(printsEvery(member, OVER)),
    );
  }

  itRunsPe("answers the same for text a program builds from all four", () => {
    peAgrees(
      src(
        "xs: float[] = [0.25, 1.5, 12.0, 1000.0, 100000.0]",
        "for x of xs:",
        "  print(Math.exp(x), Math.log(x), Math.sin(x), Math.cos(x))",
      ),
    );
  });

  itRunsPe("reduces an argument far outside one turn the way the interpreter does", () => {
    peAgrees(
      src(
        "xs: float[] = [1e10, 1e20, 1e100, 1e300, 123456789.123, 1647099.0, 1647101.0]",
        "for x of xs:",
        "  print(Math.sin(x), Math.cos(x))",
      ),
    );
  });

  itRunsPe("answers the edges of exp the way the interpreter does", () => {
    peAgrees(
      src(
        "xs: float[] = [709.782712893383973096, 709.7827128933841, 0.0 - 745.1332191019411, 0.0 - 745.2, 1e-320]",
        "for x of xs:",
        "  print(Math.exp(x))",
      ),
    );
  });

  itRunsPe("answers the edges of log the way the interpreter does", () => {
    peAgrees(
      src(
        "xs: float[] = [1.0, 2.0, 1e-308, 5e-324, 1.7976931348623157e308, 0.0]",
        "for x of xs:",
        "  print(Math.log(x))",
      ),
    );
  });
});
