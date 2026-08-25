import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import {
  formatModuleTrace,
  printModuleIR,
  type ModuleTraceRecord,
} from "../../../src/optimizing/drivers/module-trace.js";
import { createBackendRegistry } from "../../../src/optimizing/backends/index.js";

const SOURCE = `fn add(a: int, b: int) -> int:
  return a + b

fn main() -> int:
  total = 0
  i = 0
  while (i < 10):
    total = add(total, i)
    i = (i + 1)
  return total
`;

function tracedStages(): ModuleTraceRecord[] {
  const records: ModuleTraceRecord[] = [];
  const engine = new Engine({ backends: createBackendRegistry(), typecheck: "off" });
  engine.compileAot(SOURCE, {
    backend: "c",
    compilerOptions: compilerOptions("speed", {
      moduleTracer: (record) => void records.push({ ...record, module: { ...record.module } }),
    }),
  });
  return records;
}

describe("tracing the module-level AOT stages", () => {
  it("names each module transform in the order the driver runs them", () => {
    const stages = tracedStages().map((record) => record.stage);

    expect(stages.slice(0, 5)).toEqual([
      "uniquify-graph-names",
      "name-callee-constants",
      "module-captures",
      "drop-function-bindings",
      "error-surface",
    ]);
    expect(stages).toContain("closure-conversion");
    expect(stages).toContain("module-inlining");
  });

  it("numbers the stages continuously from zero", () => {
    const records = tracedStages();

    expect(records.map((record) => record.ordinal)).toEqual(records.map((_unused, at) => at));
  });

  it("hands every stage the module so a sink can print all its graphs", () => {
    const record = tracedStages().find((entry) => entry.stage === "module-inlining")!;
    const printed = printModuleIR(record.module);

    expect(record.module.units.length).toBeGreaterThan(0);
    expect(printed).toContain("fn ");
    expect(printed).toContain("Return");
  });

  it("renders a header naming the stage and how many units the module holds", () => {
    const record = tracedStages()[0]!;

    expect(formatModuleTrace(record).split("\n")[0]).toBe(
      `*** module after #0 uniquify-graph-names [${record.module.units.length} units] ***`,
    );
  });

  it("stays silent when no tracer is installed", () => {
    expect(compilerOptions("speed").moduleTracer).toBeNull();
  });
});
