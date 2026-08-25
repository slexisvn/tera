import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import { formatMachineTrace, type MachineTraceRecord } from "../../../src/optimizing/machine/trace.js";
import { hostBackendId } from "../../../src/optimizing/backends/host.js";
import { createBackendRegistry } from "../../../src/optimizing/backends/index.js";

const SOURCE = `fn add(a: int, b: int) -> int:
  return a + b

fn main() -> int:
  return add(2, 3)
`;

function tracedCompile(): MachineTraceRecord[] {
  const records: MachineTraceRecord[] = [];
  const engine = new Engine({ backends: createBackendRegistry(), typecheck: "off" });
  engine.compileAot(SOURCE, {
    backend: hostBackendId() ?? "x64-linux",
    compilerOptions: compilerOptions("speed", {
      machineTracer: (record) => void records.push(record),
    }),
  });
  return records;
}

describe("tracing the machine pipeline", () => {
  it("reports every stage boundary in the order the pipeline runs them", () => {
    const stages = [...new Set(tracedCompile().map((record) => record.after))];

    expect(stages).toEqual([
      "instruction-selection",
      "scheduling",
      "two-address-lowering",
      "register-allocation",
      "frame-code",
      "peephole",
    ]);
  });

  it("labels each record with the symbol it belongs to and its allocation phase", () => {
    const records = tracedCompile();
    const forAdd = records.filter((record) => record.symbol.includes("add"));

    expect(forAdd.length).toBeGreaterThan(0);
    expect(forAdd.map((record) => record.stage)).toContain("pre-allocation");
    expect(forAdd.map((record) => record.stage)).toContain("post-allocation");
  });

  it("numbers records from zero again for each function", () => {
    const records = tracedCompile();
    const bySymbol = new Map<string, number[]>();
    for (const record of records) {
      const seen = bySymbol.get(record.symbol) ?? [];
      seen.push(record.ordinal);
      bySymbol.set(record.symbol, seen);
    }

    for (const ordinals of bySymbol.values()) {
      expect(ordinals).toEqual(ordinals.map((_unused, at) => at));
    }
  });

  it("renders a header naming the stage and a body of real instructions", () => {
    const record = tracedCompile().find((entry) => entry.after === "peephole")!;
    const rendered = formatMachineTrace(record);

    expect(rendered.split("\n")[0]).toBe(
      `*** machine after #${record.ordinal} peephole [${record.symbol}, post-allocation] ***`,
    );
    expect(rendered).toContain(`machine ${record.symbol}:`);
  });

  it("stays silent when no tracer is installed", () => {
    const engine = new Engine({ backends: createBackendRegistry(), typecheck: "off" });

    expect(compilerOptions("speed").machineTracer).toBeNull();
    expect(() =>
      engine.compileAot(SOURCE, { backend: hostBackendId() ?? "x64-linux" }),
    ).not.toThrow();
  });
});
