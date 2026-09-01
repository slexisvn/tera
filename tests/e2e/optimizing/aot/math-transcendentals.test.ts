import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";

const compiled = (source: string) =>
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend: "c" });

describe("the transcendental Math functions", () => {
  it("answer the same values the host does", () => {
    const engine = nodeEngine({ typecheck: "off" });
    expect(engine.runNative("Math.exp(1.0)")).toBeCloseTo(Math.E);
    expect(engine.runNative("Math.sin(Math.PI / 2.0)")).toBeCloseTo(1);
    expect(engine.runNative("Math.cos(Math.PI)")).toBeCloseTo(-1);

    const printed: string[] = [];
    const collecting = nodeEngine({ typecheck: "off", output: (t) => printed.push(t) });
    collecting.run("print(Math.exp(0.0))\nprint(Math.sin(0.0))\nprint(Math.cos(0.0))\n");
    expect(printed).toEqual(["1", "0", "1"]);
  });

  for (const name of ["exp", "sin", "cos"]) {
    it(`is refused by the compiler the same way Math.log is, naming Math.${name}`, () => {
      const reference = JSON.stringify(compiled("print(Math.log(2.0))").skipped);
      const subject = JSON.stringify(compiled(`print(Math.${name}(2.0))`).skipped);

      expect(reference).toContain(
        "Math.log is part of the runtime rather than of the program",
      );
      expect(subject).toContain(
        `Math.${name} is part of the runtime rather than of the program`,
      );
    });
  }
});
