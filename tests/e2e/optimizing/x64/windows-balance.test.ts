import { describe, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const EQUATIONS: readonly string[] = [
  "H2 + O2 -> H2O",
  "Fe + O2 -> Fe2O3",
  "C3H8 + O2 -> CO2 + H2O",
  "Na + Cl2 -> NaCl",
  "KMnO4 + HCl -> KCl + MnCl2 + H2O + Cl2",
  "Ca(OH)2 + H3PO4 -> Ca3(PO4)2 + H2O",
  "junk",
  "H2 + O2",
];

const source = readFileSync("examples/balance.tera", "utf8");

function interpreted(equation: string): string {
  const stream: string[] = [];
  nodeEngine({
    typecheck: "off",
    output: (text) => stream.push(`${text}\n`),
    input: (prompt) => {
      stream.push(prompt);
      return equation;
    },
  }).run(source);
  return stream.join("");
}

let built: Uint8Array | null = null;

function executable(): Uint8Array {
  if (built !== null) return built;
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend: "x64-windows",
    format: "executable",
  });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  built = program.files[0]!.contents as Uint8Array;
  return built;
}

describe("examples/balance.tera as a standalone windows executable", () => {
  itRunsPe("compiles the top level of the example along with its functions", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
      backend: "x64-windows",
      format: "executable",
    });

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.name)).toEqual(["tera_program", "balance"]);
  });

  itRunsPe("writes the same bytes as the interpreter for every equation", () => {
    const image = executable();

    for (const equation of EQUATIONS) {
      const run = runPe(image, `${equation}\r\n`);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(interpreted(equation));
    }
  });

  itRunsPe("balances an equation it was never given at compile time", () => {
    const run = runPe(executable(), "Al + HCl -> AlCl3 + H2\r\n");

    expect(run.stdout).toBe("Enter equation: 2Al + 6HCl -> 2AlCl3 + 3H2\n");
  });

  itRunsPe("reads input that has no trailing newline", () => {
    const run = runPe(executable(), "H2 + O2 -> H2O");

    expect(run.stdout).toBe("Enter equation: 2H2 + O2 -> 2H2O\n");
  });

  itRunsPe("agrees with the interpreter when stdin is closed straight away", () => {
    const run = runPe(executable(), "");

    expect(run.stdout).toBe(interpreted(""));
  });
});
