import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeEngine } from "../../helpers/engine.js";

const EXAMPLES = join(process.cwd(), "docs", "example");

const PRINT_BUDGET = 256;

const run = (file: string): string[] => {
  const printed: string[] = [];
  const engine = nodeEngine({
    output: (text) => {
      if (printed.length >= PRINT_BUDGET) {
        throw new Error(`${file} printed over ${PRINT_BUDGET} lines without terminating`);
      }
      printed.push(text);
    },
  });
  engine.runModule(join(EXAMPLES, file));
  engine.runMicrotasks();
  return printed;
};

const compileRefusal = (file: string): string => {
  const engine = nodeEngine();
  try {
    const program = engine.compileAotModule(join(EXAMPLES, file));
    return program.skipped.map((fn) => `${fn.name}: ${fn.reason}`).join("\n");
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
};

const EXPECTED: Record<string, readonly string[]> = {
  "labeled.tera": ["1", "2", "3", "5", "6", "7"],
  "stats.tera": ["latency mean=15.70", "throughput mean=898.19"],
  "stats-poly.tera": ["latency mean=15.70", "baseline mean=10.00", "throughput mean=898.19"],
  "stats-async.tera": ["latency mean=15.70", "throughput mean=898.19"],
  "stats-closure.tera": ["scaled mean=31.40"],
  "stats-deopt.tera": ["warm  total=78.50", "taint total=21.531.257.7518"],
  "stats-refused.tera": ["latency mean=15.70", "15.7"],
  "queue.tera": ["10"],
};

describe("the book's running example", () => {
  it("covers every example file, so a new one cannot be added untested", () => {
    const present = readdirSync(EXAMPLES).filter((name) => name.endsWith(".tera"));
    expect(present.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [file, lines] of Object.entries(EXPECTED)) {
    it(`${file} prints what the book says it prints`, () => {
      expect(run(file)).toEqual([...lines]);
    });
  }

  it("stats.tera is the twenty-four lines the book claims", () => {
    const source = readFileSync(join(EXAMPLES, "stats.tera"), "utf8");
    expect(source.trimEnd().split("\n")).toHaveLength(24);
  });
});

describe("the two answers the book opens on", () => {
  it("queue.tera runs in the interpreter but is refused ahead of time", () => {
    expect(run("queue.tera")).toEqual(["10"]);
    expect(compileRefusal("queue.tera")).toContain(
      "Operator '+' cannot be applied to 'int' and 'int | undefined'",
    );
  });

  it("stats-refused.tera runs in the interpreter but is declined by the backend", () => {
    expect(run("stats-refused.tera")).toEqual(["latency mean=15.70", "15.7"]);
    expect(compileRefusal("stats-refused.tera")).toContain(
      "function returns a string but its return type is not a string",
    );
  });
});

describe("labeled continue", () => {
  it("labeled.tera resumes the outer loop instead of restarting the program", () => {
    const source = readFileSync(join(EXAMPLES, "labeled.tera"), "utf8");
    expect(source).toContain("continue outer");
    expect(run("labeled.tera")).toEqual(["1", "2", "3", "5", "6", "7"]);
  });
});
