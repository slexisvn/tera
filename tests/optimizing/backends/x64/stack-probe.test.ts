import { describe, expect, it } from "vitest";
import { X64AssemblyWriter } from "../../../../src/optimizing/backends/x64/assembly.js";
import { x64Target, type X64TargetOptions } from "../../../../src/optimizing/backends/x64/target.js";
import { x64IntegerArgumentNames } from "../../../../src/optimizing/backends/x64/abi.js";
import { PROBE_SIZE_REGISTER } from "../../../../src/optimizing/backends/x64/heap.js";
import { TERA_PROBE_STACK_SYMBOL } from "../../../../src/optimizing/target/runtime-layout.js";

const ABIS: readonly (readonly [string, X64TargetOptions])[] = [
  ["sysv", { abi: "sysv", format: "elf" }],
  ["win64", { abi: "win64", format: "coff" }],
];

function probeText(options: X64TargetOptions): string {
  const target = x64Target(options);
  const routine = target.runtime.get(TERA_PROBE_STACK_SYMBOL);
  if (routine === undefined) throw new Error("x64 has no stack probe routine");
  return new X64AssemblyWriter(target).functionText(routine.fn);
}

describe("the x64 stack probe routine", () => {
  for (const [name, options] of ABIS) {
    it(`${name} walks down from the stack pointer to the frame it was asked for`, () => {
      const text = probeText(options);

      expect(text).toMatch(/movq\s+%rsp, %\w+/);
      expect(text).toMatch(/subq\s+%\w+, %\w+/);
    });

    it(`${name} steps by the granule the ABI says a guard page covers`, () => {
      const granule = x64Target(options).abi.stackProbeBytes;

      expect(probeText(options)).toMatch(new RegExp(`subq\\s+\\$${granule}, %\\w+`));
    });

    it(`${name} touches every page it steps over and the deepest address itself`, () => {
      const stores = probeText(options).match(/^\tmovq\s+\$0, 0\(%\w+\)$/gm) ?? [];

      expect(stores.length).toBe(2);
    });

    it(`${name} stops once the cursor has passed the limit`, () => {
      const text = probeText(options);

      expect(text).toMatch(/jae\s+\./);
      expect(text).toContain("\tret");
    });

    it(`${name} never writes a register the caller passes arguments in`, () => {
      const text = probeText(options);
      const written = text.match(/^\t\w+\s+[^,\n]+, %(\w+)$/gm) ?? [];
      const destinations = written.map((line) => line.slice(line.lastIndexOf("%") + 1));
      const passed = x64IntegerArgumentNames(x64Target(options).abi);

      expect(destinations.length).toBeGreaterThan(0);
      expect(destinations.filter((register) => passed.includes(register))).toEqual([]);
    });
  }

  it("reads the frame size out of the register the prologue loads it into", () => {
    for (const [, options] of ABIS) {
      expect(probeText(options)).toContain(`%${PROBE_SIZE_REGISTER}`);
    }
  });
});
