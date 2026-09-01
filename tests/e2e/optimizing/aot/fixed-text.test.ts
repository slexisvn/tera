import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { image, interpreted, peAgrees } from "../../../helpers/aot-agreement.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function compileProject(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-aot-fixed-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents, "utf8");
  }
  return nodeEngine().compileAotModule(path.join(root, "main.tera"), { root });
}

const compiled = (source: string, backend: string) =>
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend });

const TIES = src(
  "print((1.005).to_fixed(2))",
  "print((8.575).to_fixed(2))",
  "print((2.675).to_fixed(2))",
  "print((0.5).to_fixed(0))",
  "print((1.5).to_fixed(0))",
  "print((2.5).to_fixed(0))",
  "print((-1.005).to_fixed(2))",
);

const MAGNITUDES = src(
  "print((0.0).to_fixed(2))",
  "print((1e-7).to_fixed(10))",
  "print((5e-324).to_fixed(20))",
  "print((1e20).to_fixed(2))",
  "print((1e21).to_fixed(2))",
  "print((123456789.987654321).to_fixed(6))",
  "print((0.1).to_fixed(20))",
);

const REPORT = src(
  "class Row:",
  "  public constructor(name: string, hours: float, rate: float):",
  "    this.name = name",
  "    this.hours = hours",
  "    this.rate = rate",
  "",
  "fn money(amount: float) -> string:",
  '  return "$" + amount.to_fixed(2)',
  "",
  'rows: Row[] = [Row("ada", 41.5, 62.0), Row("grace", 38.0, 71.5)]',
  "total: float = 0.0",
  "for row of rows:",
  "  total += row.hours * row.rate",
  "  print(money(row.hours * row.rate))",
  'print("total", money(total))',
);

describe("AOT fixed text", () => {
  it("compiles a program that formats a number", () => {
    expect(compiled("print((2.5).to_fixed(2))", "c").skipped).toEqual([]);
  });

  it("compiles a report that formats numbers inside a loop", () => {
    expect(compiled(REPORT, "c").skipped).toEqual([]);
  });

  it("leaves the formatter out of a program that never asks for it", () => {
    expect(cSource(compiled("print(2.5)", "c"))).not.toContain("_fixed_text");
  });

  it("stands aside for a class that declares the member itself", () => {
    const source = src(
      "class Money:",
      "  public constructor(cents: int):",
      "    this.cents = cents",
      "  public to_fixed(digits: int) -> string:",
      "    return this.cents.to_string() + digits.to_string()",
      "",
      "print(Money(5).to_fixed(2))",
    );

    expect(interpreted(source)).toBe("52\n");
    expect(cSource(compiled(source, "c"))).not.toContain("_fixed_text");
  });

  itRunsPe("rounds ties the way the interpreter does", () => {
    peAgrees(TIES);
  });

  itRunsPe("formats every magnitude the way the interpreter does", () => {
    peAgrees(MAGNITUDES);
  });

  itRunsPe("formats a value held in a variable, a field and an expression", () => {
    peAgrees(
      src(
        "rate: float = 62.5",
        "print(rate.to_fixed(1))",
        "print((rate * 3.0).to_fixed(3))",
        "shape = { size: 2.125 }",
        "print(shape.size.to_fixed(2))",
      ),
    );
  });

  itRunsPe("formats an integer receiver and a call with no digits", () => {
    peAgrees(src("n: int = 7", "print(n.to_fixed(2))", "print((1.5).to_fixed())"));
  });

  itRunsPe("formats through a helper called in a loop", () => {
    peAgrees(REPORT);
  });

  itRunsPe("reports an out-of-range digit count the way the interpreter does", () => {
    const run = runPe(image("print((1.5).to_fixed(101))"));

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("toFixed() digits argument must be between 0 and 100");
  });

  itNative("formats the same way through the C backend", () => {
    expect(compiled(TIES, "c").skipped).toEqual([]);
  });

  it("formats a number the entry module of a project asks for", () => {
    const program = compileProject({
      "main.tera": src("from rates import markup", "", "print(markup(10.0).to_fixed(2))", ""),
      "rates.tera": src("fn markup(price: float) -> float:", "  return price * 1.075", ""),
    });

    expect(program.skipped).toEqual([]);
  });

  it("stands down where the formatting lives in an imported module", () => {
    const program = compileProject({
      "main.tera": src("from rates import money", "", "print(money(10.0))", ""),
      "rates.tera": src("fn money(price: float) -> string:", '  return "$" + price.to_fixed(2)', ""),
    });

    expect(JSON.stringify(program.skipped)).toContain("unsupported property to_fixed");
  });
});
