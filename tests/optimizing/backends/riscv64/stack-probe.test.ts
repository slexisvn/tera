import { describe, expect, it } from "vitest";
import { RiscvAssemblyWriter } from "../../../../src/optimizing/backends/riscv64/assembly.js";
import { riscvTarget } from "../../../../src/optimizing/backends/riscv64/target.js";
import { TERA_PROBE_STACK_SYMBOL } from "../../../../src/optimizing/target/runtime-layout.js";

const target = riscvTarget();

function probeText(): string {
  const routine = target.runtime.get(TERA_PROBE_STACK_SYMBOL);
  if (routine === undefined) throw new Error("riscv64 has no stack probe routine");
  return new RiscvAssemblyWriter().functionText(routine.fn);
}

describe("the riscv64 stack probe routine", () => {
  it("walks down from the stack pointer to the frame it was asked for", () => {
    const text = probeText();

    expect(text).toMatch(/sub\s+(\w+), sp, (\w+)/);
    expect(text).toMatch(/mv\s+\w+, sp/);
  });

  it("steps by the granule the ABI says a guard page covers", () => {
    expect(probeText()).toMatch(new RegExp(`li\\s+\\w+, ${target.abi.stackProbeBytes}\\b`));
  });

  it("touches every page it steps over and the deepest address itself", () => {
    const stores = probeText().match(/^\tsd\s+zero, 0\(\w+\)$/gm) ?? [];

    expect(stores.length).toBe(2);
  });

  it("stops once the cursor has passed the limit", () => {
    const text = probeText();

    expect(text).toMatch(/bgeu\s+\w+, \w+, \./);
    expect(text).toContain("\tret");
  });

  it("never writes the register the caller keeps its return address in", () => {
    const link = target.abi.savedOnCall[0]!.name;
    const written = probeText().match(/^\t\w[\w.]*\s+([a-z]\w*),/gm) ?? [];

    expect(written.some((line) => line.includes(` ${link},`))).toBe(false);
  });
});
