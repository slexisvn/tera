import { describe, expect, it } from "vitest";
import { MachineFunction, type MachineInstruction } from "../../../src/optimizing/machine/ir.js";
import { layoutFrame } from "../../../src/optimizing/machine/frame.js";
import { insertFrameCode } from "../../../src/optimizing/machine/frame-code.js";
import type { MachineLowering } from "../../../src/optimizing/machine/lowering.js";
import type { MachineTargetModel } from "../../../src/optimizing/target/model.js";
import {
  TERA_ENTER_ROOTS_SYMBOL,
  TERA_PROBE_STACK_SYMBOL,
  TERA_ROOT_ENTRY_BYTES,
} from "../../../src/optimizing/target/runtime-layout.js";
import { X64Lowering } from "../../../src/optimizing/backends/x64/lowering.js";
import { x64Target } from "../../../src/optimizing/backends/x64/target.js";
import { RiscvLowering } from "../../../src/optimizing/backends/riscv64/lowering.js";
import { riscvTarget } from "../../../src/optimizing/backends/riscv64/target.js";

const BACKENDS: readonly (readonly [string, () => MachineLowering])[] = [
  ["x64 sysv", () => new X64Lowering(x64Target({ abi: "sysv", format: "elf" }))],
  ["x64 win64", () => new X64Lowering(x64Target({ abi: "win64", format: "coff" }))],
  ["riscv64", () => new RiscvLowering(riscvTarget())],
];

function withLocalBytes(bytes: number): MachineFunction {
  const fn = new MachineFunction("frame", "frame");
  fn.createBlock("entry");
  fn.createSlot(bytes, 8);
  return fn;
}

function entryCodeOf(fn: MachineFunction, lowering: MachineLowering): MachineInstruction[] {
  const frame = layoutFrame(fn, lowering.target, []);
  insertFrameCode(fn, frame, lowering);
  return fn.entry!.instructions;
}

function probeCallAt(code: readonly MachineInstruction[]): number {
  return code.findIndex(
    (node) =>
      node.flags.call === true &&
      node.operands.some(
        (operand) => operand.kind === "symbol" && operand.name === TERA_PROBE_STACK_SYMBOL,
      ),
  );
}

function allocationAt(code: readonly MachineInstruction[]): number {
  return code.findIndex((node) => node.flags.prologue === true);
}

function granuleOf(target: MachineTargetModel): number {
  return target.abi.stackProbeBytes;
}

describe("stack probing in the prologue", () => {
  for (const [name, build] of BACKENDS) {
    it(`${name} leaves a frame that cannot skip the guard page unprobed`, () => {
      const lowering = build();
      const granule = granuleOf(lowering.target);
      const fn = withLocalBytes(granule - lowering.target.abi.pointerWidthBytes * 4);

      expect(probeCallAt(entryCodeOf(fn, lowering))).toBe(-1);
      expect(fn.externals.has(TERA_PROBE_STACK_SYMBOL)).toBe(false);
    });

    it(`${name} probes a frame that reaches past one guard page`, () => {
      const lowering = build();
      const fn = withLocalBytes(granuleOf(lowering.target) * 6);
      const code = entryCodeOf(fn, lowering);

      expect(probeCallAt(code)).toBeGreaterThanOrEqual(0);
      expect(fn.externals.has(TERA_PROBE_STACK_SYMBOL)).toBe(true);
    });

    it(`${name} probes before it lowers the stack pointer`, () => {
      const lowering = build();
      const fn = withLocalBytes(granuleOf(lowering.target) * 6);
      const code = entryCodeOf(fn, lowering);

      expect(probeCallAt(code)).toBeLessThan(allocationAt(code));
    });

    it(`${name} probes a frame the return address alone pushes past the page`, () => {
      const lowering = build();
      const abi = lowering.target.abi;
      const fn = withLocalBytes(granuleOf(lowering.target));
      const frame = layoutFrame(fn, lowering.target, []);
      const code = entryCodeOf(fn, lowering);

      expect(frame.frameSize + abi.pointerWidthBytes).toBeGreaterThan(granuleOf(lowering.target));
      expect(probeCallAt(code)).toBeGreaterThanOrEqual(0);
    });

    it(`${name} keeps the probe out of the unwind description`, () => {
      const lowering = build();
      const fn = withLocalBytes(granuleOf(lowering.target) * 6);
      const code = entryCodeOf(fn, lowering);

      expect(code.slice(0, allocationAt(code)).some((node) => node.flags.prologue === true)).toBe(
        false,
      );
    });
  }

  for (const [name, build] of BACKENDS.filter(([backend]) => backend.startsWith("x64"))) {
    it(`${name} keeps the frame allocation a single unwind step`, () => {
      const lowering = build();
      const small = withLocalBytes(64);
      const large = withLocalBytes(granuleOf(lowering.target) * 6);

      const described = (fn: MachineFunction): number =>
        entryCodeOf(fn, lowering).filter((node) => node.flags.prologue === true).length;

      expect(described(large)).toBe(described(small));
    });
  }

  it("hands the probe routine the frame it is about to allocate", () => {
    const lowering = new X64Lowering(x64Target({ abi: "win64", format: "coff" }));
    const fn = withLocalBytes(granuleOf(lowering.target) * 6);
    const frame = layoutFrame(fn, lowering.target, []);
    insertFrameCode(fn, frame, lowering);
    const code = fn.entry!.instructions;
    const sized = code[probeCallAt(code) - 1]!;

    expect(sized.operands.some((operand) => operand.kind === "immediate")).toBe(true);
    expect(
      sized.operands.find((operand) => operand.kind === "immediate")?.value,
    ).toBe(frame.frameSize);
  });

  it("riscv64 carries the return address across the probe call", () => {
    const lowering = new RiscvLowering(riscvTarget());
    const link = lowering.target.abi.savedOnCall[0]!;
    const fn = withLocalBytes(granuleOf(lowering.target) * 6);
    const code = entryCodeOf(fn, lowering);
    const call = probeCallAt(code);

    const reads = (node: MachineInstruction, role: "def" | "use"): boolean =>
      node.operands.some(
        (operand) =>
          operand.kind === "register" &&
          operand.register.kind === "physical" &&
          operand.register.name === link.name &&
          operand.role === role,
      );

    expect(code.slice(0, call).some((node) => reads(node, "use"))).toBe(true);
    expect(code.slice(call + 1).some((node) => reads(node, "def"))).toBe(true);
  });

  for (const [name, build] of BACKENDS) {
    it(`${name} registers every runtime routine its prologue calls`, () => {
      const lowering = build();
      const fn = withLocalBytes(64);
      fn.roots = 1;
      fn.rootFrame = fn.createSlot(TERA_ROOT_ENTRY_BYTES, TERA_ROOT_ENTRY_BYTES);
      const code = entryCodeOf(fn, lowering);
      const called = code
        .filter((node) => node.flags.call === true)
        .flatMap((node) => node.operands)
        .filter((operand) => operand.kind === "symbol")
        .map((operand) => operand.name);

      expect(called).toContain(TERA_ENTER_ROOTS_SYMBOL);
      for (const symbol of called) expect(fn.externals.has(symbol)).toBe(true);
    });
  }

  it("offers a probe routine on every machine target that asks for one", () => {
    for (const target of [
      x64Target({ abi: "sysv", format: "elf" }),
      x64Target({ abi: "win64", format: "coff" }),
      riscvTarget(),
    ]) {
      expect(target.runtime.has(TERA_PROBE_STACK_SYMBOL)).toBe(true);
    }
  });
});
