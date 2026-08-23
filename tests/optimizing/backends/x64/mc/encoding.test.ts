import { describe, expect, it } from "vitest";
import {
  def,
  imm,
  instruction,
  mem,
  sym,
  use,
  type MachineInstruction,
} from "../../../../../src/optimizing/machine/ir.js";
import { X64AssemblyWriter } from "../../../../../src/optimizing/backends/x64/assembly.js";
import { x64Target } from "../../../../../src/optimizing/backends/x64/target.js";
import { x64McTarget } from "../../../../../src/optimizing/backends/x64/mc/target.js";
import { assembleFunction } from "../../../../../src/optimizing/mc/assembler.js";
import { layoutModule } from "../../../../../src/optimizing/mc/layout.js";
import { McModule } from "../../../../../src/optimizing/mc/module.js";
import { assembleText, hex, itAssembles } from "../../../../helpers/gnu-assembler.js";

const target = x64Target({ abi: "sysv", format: "elf" });
const writer = new X64AssemblyWriter(target);
const reg = (name: string) => target.registers.register(name);

function bytesOf(node: MachineInstruction): number[] {
  return [...x64McTarget.encode(node, 0).bytes];
}

function textOf(node: MachineInstruction): string {
  return writer.instructionText(node).join("\n");
}

const CASES: readonly (readonly [string, MachineInstruction])[] = [
  ["register move", instruction("movl", [def(reg("rbx"), 4), use(reg("rax"), 4)])],
  ["extended register move", instruction("movq", [def(reg("r12"), 8), use(reg("r9"), 8)])],
  [
    "short immediate add",
    instruction("addl", [def(reg("rcx"), 4), use(reg("rcx"), 4), imm(5)], { tied: true }),
  ],
  [
    "wide immediate add",
    instruction("addl", [def(reg("rax"), 4), use(reg("rax"), 4), imm(100000)], {
      tied: true,
    }),
  ],
  [
    "wide immediate add to non accumulator",
    instruction("addl", [def(reg("rbx"), 4), use(reg("rbx"), 4), imm(100000)], {
      tied: true,
    }),
  ],
  ["immediate load", instruction("movl", [def(reg("rdi"), 4), imm(42)])],
  [
    "scalar double add",
    instruction("addsd", [def(reg("xmm0"), 8), use(reg("xmm0"), 8), use(reg("xmm1"), 8)], {
      tied: true,
    }),
  ],
  [
    "stack reload with displacement",
    instruction("movq", [
      def(reg("r12"), 8),
      mem(8, { base: use(reg("rsp"), 8), displacement: -8 }),
    ]),
  ],
  [
    "stack spill at zero offset",
    instruction("movl", [
      mem(4, { base: use(reg("rsp"), 8) }),
      use(reg("rsi"), 4),
    ]),
  ],
  [
    "frame pointer base needs explicit displacement",
    instruction("movl", [def(reg("rax"), 4), mem(4, { base: use(reg("rbp"), 8) })]),
  ],
  [
    "scaled index address",
    instruction("movsd", [
      def(reg("xmm3"), 8),
      mem(8, { base: use(reg("rsp"), 8), index: use(reg("r13"), 8), scale: 8 }),
    ]),
  ],
  ["byte condition set", instruction("setne", [def(reg("rsi"), 1)])],
  ["byte zero extension", instruction("movzbl", [def(reg("rsi"), 4), use(reg("rsi"), 1)])],
  [
    "shift by immediate",
    instruction("sarl", [def(reg("rdx"), 4), use(reg("rdx"), 4), imm(3)], { tied: true }),
  ],
  [
    "shift by count register",
    instruction("shrl", [def(reg("rdx"), 4), use(reg("rdx"), 4), use(reg("rcx"), 1)], {
      tied: true,
    }),
  ],
  ["compare registers", instruction("cmpl", [use(reg("rdi"), 4), use(reg("rsi"), 4)])],
  [
    "scaled index address",
    instruction("leal", [
      def(reg("rax"), 4),
      mem(4, { base: use(reg("rdx"), 8), index: use(reg("rcx"), 8), scale: 4 }),
    ]),
  ],
  [
    "scaled index without a base",
    instruction("leal", [
      def(reg("rax"), 4),
      mem(4, { index: use(reg("rcx"), 8), scale: 4, displacement: 7 }),
    ]),
  ],
  [
    "scaled index on extended registers",
    instruction("leal", [
      def(reg("r9"), 4),
      mem(4, { base: use(reg("r13"), 8), index: use(reg("r12"), 8), scale: 8 }),
    ]),
  ],
  ["compare against a small immediate", instruction("cmpl", [use(reg("rax"), 4), imm(0)])],
  ["compare against a wide immediate", instruction("cmpl", [use(reg("r13"), 4), imm(70000)])],
  ["compare against a negative immediate", instruction("cmpl", [use(reg("rcx"), 4), imm(-9)])],
  ["negate", instruction("negl", [def(reg("r10"), 4), use(reg("r10"), 4)], { tied: true })],
  [
    "signed multiply",
    instruction("imull", [def(reg("rax"), 4), use(reg("rax"), 4), use(reg("r15"), 4)], {
      tied: true,
    }),
  ],
  [
    "load effective address",
    instruction("leaq", [
      def(reg("rax"), 8),
      mem(8, { base: use(reg("rbx"), 8), index: use(reg("rcx"), 8), scale: 4, displacement: 16 }),
    ]),
  ],
  ["sign extend", instruction("movslq", [def(reg("rax"), 8), use(reg("rdi"), 4)])],
  ["no operand", instruction("cltd", [])],
];

const IMPORT_SLOT = "__imp_WriteFile";

const indirectCall = instruction("call", [mem(8, { symbol: IMPORT_SLOT })], {
  call: true,
  implicitFrom: 1,
});

describe("x64 instruction encoding", () => {
  it("encodes a register move in the store direction", () => {
    expect(hex(bytesOf(CASES[0]![1]))).toBe("89 c3");
  });

  it("emits a bare rex prefix for legacy byte registers", () => {
    expect(hex(bytesOf(instruction("setne", [def(reg("rsi"), 1)])))).toBe("40 0f 95 c6");
  });

  it("omits the rex prefix for byte registers that do not need one", () => {
    expect(hex(bytesOf(instruction("setne", [def(reg("rax"), 1)])))).toBe("0f 95 c0");
  });

  it("forces a displacement when the frame pointer is the base", () => {
    const node = instruction("movl", [def(reg("rax"), 4), mem(4, { base: use(reg("rbp"), 8) })]);
    expect(hex(bytesOf(node))).toBe("8b 45 00");
  });

  it("inserts a sib byte when the stack pointer is the base", () => {
    const node = instruction("movl", [def(reg("rax"), 4), mem(4, { base: use(reg("rsp"), 8) })]);
    expect(hex(bytesOf(node))).toBe("8b 04 24");
  });

  it("prefers the sign extended immediate form when the value fits a byte", () => {
    const node = instruction("addl", [def(reg("rcx"), 4), use(reg("rcx"), 4), imm(5)], {
      tied: true,
    });
    expect(hex(bytesOf(node))).toBe("83 c1 05");
  });

  it("prefers the accumulator form for wide immediates on rax", () => {
    const node = instruction("addl", [def(reg("rax"), 4), use(reg("rax"), 4), imm(100000)], {
      tied: true,
    });
    expect(hex(bytesOf(node))).toBe("05 a0 86 01 00");
  });

  it("encodes a call through a rip relative slot as an indirect call", () => {
    const encoding = x64McTarget.encode(indirectCall, 0);

    expect(hex(encoding.bytes)).toBe("ff 15 00 00 00 00");
    expect(encoding.fixups).toHaveLength(1);
    expect(encoding.fixups[0]!.symbol).toBe(IMPORT_SLOT);
    expect(encoding.fixups[0]!.offset).toBe(2);
  });

  it("keeps a call to a symbol a relative branch", () => {
    const node = instruction("call", [sym("triple")], { call: true, implicitFrom: 1 });

    expect(hex(bytesOf(node))).toBe("e8 00 00 00 00");
  });

  it("prints an indirect call with the indirection marker", () => {
    expect(textOf(indirectCall)).toBe(`\tcall *${IMPORT_SLOT}(%rip)`);
  });

  it("emits a rip relative operand for symbol addresses", () => {
    const node = instruction("movsd", [def(reg("xmm0"), 8), mem(8, { symbol: ".LC0" })]);
    const encoding = x64McTarget.encode(node, 0);
    expect(hex(encoding.bytes)).toBe("f2 0f 10 05 00 00 00 00");
    expect(encoding.fixups).toHaveLength(1);
    expect(encoding.fixups[0]!.symbol).toBe(".LC0");
    expect(encoding.fixups[0]!.offset).toBe(4);
  });
});

describe("x64 encoder against the gnu assembler", () => {
  for (const [name, node] of CASES) {
    itAssembles(`agrees on ${name}`, () => {
      const mine = bytesOf(node);
      const theirs = assembleText(textOf(node));
      expect(hex(theirs.subarray(0, mine.length))).toBe(hex(mine));
    });
  }

  for (const [symbol, routine] of target.runtime) {
    itAssembles(`agrees on the whole body of ${symbol}`, () => {
      const module = new McModule();
      assembleFunction(module, x64McTarget, routine.fn, "local");
      layoutModule(module, x64McTarget, { mode: "object" });
      const mine = module.sections[0]!.contents();
      const theirs = assembleText(writer.functionText(routine.fn, false));

      expect(hex(theirs.subarray(0, mine.length))).toBe(hex(mine));
    });
  }

  itAssembles("agrees on every case emitted as one block", () => {
    const mine = CASES.flatMap(([, node]) => bytesOf(node));
    const theirs = assembleText(CASES.map(([, node]) => textOf(node)).join("\n"));
    expect(hex(theirs.subarray(0, mine.length))).toBe(hex(mine));
  });
});
