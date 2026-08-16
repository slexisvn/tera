import type { FixupKind } from "../../../mc/fixup.js";
import { X64_BRANCH_32, X64_PC_RELATIVE_32, X64_PC_RELATIVE_8 } from "./fixups.js";

export interface OpcodeForm {
  readonly bytes: readonly number[];
  readonly mandatory?: number;
  readonly rexW?: boolean;
  readonly extension?: number;
  readonly immediateBytes?: number;
}

export interface BranchForm {
  readonly bytes: readonly number[];
  readonly displacementBytes: number;
  readonly fixupKind: FixupKind;
}

export interface OpcodeGroup {
  readonly rm?: OpcodeForm;
  readonly mr?: OpcodeForm;
  readonly mi?: OpcodeForm;
  readonly mi8?: OpcodeForm;
  readonly m1?: OpcodeForm;
  readonly ai?: OpcodeForm;
  readonly m?: OpcodeForm;
  readonly mc?: OpcodeForm;
  readonly o?: OpcodeForm;
  readonly oi?: OpcodeForm;
  readonly rmi?: OpcodeForm;
  readonly none?: OpcodeForm;
  readonly branch?: readonly BranchForm[];
}

const CONDITION_CODES = new Map<string, number>([
  ["o", 0x0],
  ["no", 0x1],
  ["b", 0x2],
  ["ae", 0x3],
  ["e", 0x4],
  ["ne", 0x5],
  ["be", 0x6],
  ["a", 0x7],
  ["s", 0x8],
  ["ns", 0x9],
  ["p", 0xa],
  ["np", 0xb],
  ["l", 0xc],
  ["ge", 0xd],
  ["le", 0xe],
  ["g", 0xf],
]);

const ARITHMETIC: readonly (readonly [string, number, number])[] = [
  ["add", 0x00, 0],
  ["or", 0x08, 1],
  ["and", 0x20, 4],
  ["sub", 0x28, 5],
  ["xor", 0x30, 6],
  ["cmp", 0x38, 7],
];

const SHIFTS: readonly (readonly [string, number])[] = [
  ["sal", 4],
  ["shl", 4],
  ["shr", 5],
  ["sar", 7],
];

const UNARY: readonly (readonly [string, number])[] = [
  ["not", 2],
  ["neg", 3],
  ["mul", 4],
  ["imul", 5],
  ["div", 6],
  ["idiv", 7],
];

const SSE_BINARY: readonly (readonly [string, number, number])[] = [
  ["addsd", 0xf2, 0x58],
  ["subsd", 0xf2, 0x5c],
  ["mulsd", 0xf2, 0x59],
  ["divsd", 0xf2, 0x5e],
  ["sqrtsd", 0xf2, 0x51],
  ["minsd", 0xf2, 0x5d],
  ["maxsd", 0xf2, 0x5f],
  ["addss", 0xf3, 0x58],
  ["subss", 0xf3, 0x5c],
  ["mulss", 0xf3, 0x59],
  ["divss", 0xf3, 0x5e],
  ["ucomisd", 0x66, 0x2e],
  ["comisd", 0x66, 0x2f],
  ["xorpd", 0x66, 0x57],
  ["andpd", 0x66, 0x54],
  ["orpd", 0x66, 0x56],
  ["andnpd", 0x66, 0x55],
];

const WIDTHS: readonly (readonly [string, boolean, boolean])[] = [
  ["b", false, true],
  ["l", false, false],
  ["q", true, false],
];

function put(table: Map<string, OpcodeGroup>, name: string, group: OpcodeGroup): void {
  table.set(name, { ...table.get(name), ...group });
}

function addArithmetic(table: Map<string, OpcodeGroup>): void {
  for (const [name, base, extension] of ARITHMETIC) {
    for (const [suffix, rexW, byteForm] of WIDTHS) {
      put(table, `${name}${suffix}`, {
        mr: { bytes: [base + (byteForm ? 0 : 1)], rexW },
        rm: { bytes: [base + (byteForm ? 2 : 3)], rexW },
        mi: {
          bytes: [byteForm ? 0x80 : 0x81],
          rexW,
          extension,
          immediateBytes: byteForm ? 1 : 4,
        },
        ai: {
          bytes: [base + (byteForm ? 4 : 5)],
          rexW,
          immediateBytes: byteForm ? 1 : 4,
        },
        ...(byteForm
          ? {}
          : { mi8: { bytes: [0x83], rexW, extension, immediateBytes: 1 } }),
      });
    }
  }
}

function addShifts(table: Map<string, OpcodeGroup>): void {
  for (const [name, extension] of SHIFTS) {
    for (const [suffix, rexW, byteForm] of WIDTHS) {
      put(table, `${name}${suffix}`, {
        mi: {
          bytes: [byteForm ? 0xc0 : 0xc1],
          rexW,
          extension,
          immediateBytes: 1,
        },
        m1: { bytes: [byteForm ? 0xd0 : 0xd1], rexW, extension },
        mc: { bytes: [byteForm ? 0xd2 : 0xd3], rexW, extension },
      });
    }
  }
}

function addUnary(table: Map<string, OpcodeGroup>): void {
  for (const [name, extension] of UNARY) {
    for (const [suffix, rexW, byteForm] of WIDTHS) {
      put(table, `${name}${suffix}`, {
        m: { bytes: [byteForm ? 0xf6 : 0xf7], rexW, extension },
      });
    }
  }
  for (const [suffix, rexW, byteForm] of WIDTHS) {
    put(table, `inc${suffix}`, {
      m: { bytes: [byteForm ? 0xfe : 0xff], rexW, extension: 0 },
    });
    put(table, `dec${suffix}`, {
      m: { bytes: [byteForm ? 0xfe : 0xff], rexW, extension: 1 },
    });
  }
}

function addMoves(table: Map<string, OpcodeGroup>): void {
  for (const [suffix, rexW, byteForm] of WIDTHS) {
    put(table, `mov${suffix}`, {
      mr: { bytes: [byteForm ? 0x88 : 0x89], rexW },
      rm: { bytes: [byteForm ? 0x8a : 0x8b], rexW },
      mi: {
        bytes: [byteForm ? 0xc6 : 0xc7],
        rexW,
        extension: 0,
        immediateBytes: byteForm ? 1 : 4,
      },
    });
    put(table, `test${suffix}`, {
      mr: { bytes: [byteForm ? 0x84 : 0x85], rexW },
      mi: {
        bytes: [byteForm ? 0xf6 : 0xf7],
        rexW,
        extension: 0,
        immediateBytes: byteForm ? 1 : 4,
      },
      ai: {
        bytes: [byteForm ? 0xa8 : 0xa9],
        rexW,
        immediateBytes: byteForm ? 1 : 4,
      },
    });
  }
  put(table, "movabsq", {
    oi: { bytes: [0xb8], rexW: true, immediateBytes: 8 },
  });
  put(table, "movl", { oi: { bytes: [0xb8], immediateBytes: 4 } });
  put(table, "movslq", { rm: { bytes: [0x63], rexW: true } });
  put(table, "movzbl", { rm: { bytes: [0x0f, 0xb6] } });
  put(table, "movzbq", { rm: { bytes: [0x0f, 0xb6], rexW: true } });
  put(table, "movzwl", { rm: { bytes: [0x0f, 0xb7] } });
  put(table, "movsbl", { rm: { bytes: [0x0f, 0xbe] } });
  put(table, "movswl", { rm: { bytes: [0x0f, 0xbf] } });
  put(table, "leal", { rm: { bytes: [0x8d] } });
  put(table, "leaq", { rm: { bytes: [0x8d], rexW: true } });
  put(table, "imull", {
    rm: { bytes: [0x0f, 0xaf] },
    rmi: { bytes: [0x69], immediateBytes: 4 },
  });
  put(table, "imulq", {
    rm: { bytes: [0x0f, 0xaf], rexW: true },
    rmi: { bytes: [0x69], rexW: true, immediateBytes: 4 },
  });
}

function addSse(table: Map<string, OpcodeGroup>): void {
  for (const [name, mandatory, opcode] of SSE_BINARY) {
    put(table, name, { rm: { bytes: [0x0f, opcode], mandatory } });
  }
  put(table, "movsd", {
    rm: { bytes: [0x0f, 0x10], mandatory: 0xf2 },
    mr: { bytes: [0x0f, 0x11], mandatory: 0xf2 },
  });
  put(table, "movss", {
    rm: { bytes: [0x0f, 0x10], mandatory: 0xf3 },
    mr: { bytes: [0x0f, 0x11], mandatory: 0xf3 },
  });
  put(table, "movapd", {
    rm: { bytes: [0x0f, 0x28], mandatory: 0x66 },
    mr: { bytes: [0x0f, 0x29], mandatory: 0x66 },
  });
  put(table, "movups", {
    rm: { bytes: [0x0f, 0x10] },
    mr: { bytes: [0x0f, 0x11] },
  });
  put(table, "movaps", {
    rm: { bytes: [0x0f, 0x28] },
    mr: { bytes: [0x0f, 0x29] },
  });
  put(table, "cvtsi2sdl", { rm: { bytes: [0x0f, 0x2a], mandatory: 0xf2 } });
  put(table, "cvtsi2sdq", { rm: { bytes: [0x0f, 0x2a], mandatory: 0xf2, rexW: true } });
  put(table, "cvttsd2sil", { rm: { bytes: [0x0f, 0x2c], mandatory: 0xf2 } });
  put(table, "cvttsd2siq", { rm: { bytes: [0x0f, 0x2c], mandatory: 0xf2, rexW: true } });
  put(table, "cvtsd2ss", { rm: { bytes: [0x0f, 0x5a], mandatory: 0xf2 } });
  put(table, "cvtss2sd", { rm: { bytes: [0x0f, 0x5a], mandatory: 0xf3 } });
  put(table, "roundsd", {
    rmi: { bytes: [0x0f, 0x3a, 0x0b], mandatory: 0x66, immediateBytes: 1 },
  });
  put(table, "movq:fpr,gpr", {
    rm: { bytes: [0x0f, 0x6e], mandatory: 0x66, rexW: true },
  });
  put(table, "movq:gpr,fpr", {
    mr: { bytes: [0x0f, 0x7e], mandatory: 0x66, rexW: true },
  });
  put(table, "movd:fpr,gpr", { rm: { bytes: [0x0f, 0x6e], mandatory: 0x66 } });
  put(table, "movd:gpr,fpr", { mr: { bytes: [0x0f, 0x7e], mandatory: 0x66 } });
}

function addControl(table: Map<string, OpcodeGroup>): void {
  for (const [code, number] of CONDITION_CODES) {
    put(table, `j${code}`, {
      branch: [
        { bytes: [0x70 + number], displacementBytes: 1, fixupKind: X64_PC_RELATIVE_8 },
        {
          bytes: [0x0f, 0x80 + number],
          displacementBytes: 4,
          fixupKind: X64_PC_RELATIVE_32,
        },
      ],
    });
    put(table, `set${code}`, {
      m: { bytes: [0x0f, 0x90 + number], extension: 0 },
    });
    put(table, `cmov${code}l`, { rm: { bytes: [0x0f, 0x40 + number] } });
    put(table, `cmov${code}q`, { rm: { bytes: [0x0f, 0x40 + number], rexW: true } });
  }
  put(table, "jmp", {
    branch: [
      { bytes: [0xeb], displacementBytes: 1, fixupKind: X64_PC_RELATIVE_8 },
      { bytes: [0xe9], displacementBytes: 4, fixupKind: X64_PC_RELATIVE_32 },
    ],
    m: { bytes: [0xff], extension: 4 },
  });
  put(table, "call", {
    branch: [{ bytes: [0xe8], displacementBytes: 4, fixupKind: X64_BRANCH_32 }],
    m: { bytes: [0xff], extension: 2 },
  });
  put(table, "ret", { none: { bytes: [0xc3] } });
  put(table, "leave", { none: { bytes: [0xc9] } });
  put(table, "nop", { none: { bytes: [0x90] } });
  put(table, "ud2", { none: { bytes: [0x0f, 0x0b] } });
  put(table, "cltd", { none: { bytes: [0x99] } });
  put(table, "cqto", { none: { bytes: [0x99], rexW: true } });
  put(table, "cwtl", { none: { bytes: [0x98] } });
  put(table, "cltq", { none: { bytes: [0x98], rexW: true } });
  put(table, "syscall", { none: { bytes: [0x0f, 0x05] } });
  put(table, "pushq", { o: { bytes: [0x50] }, m: { bytes: [0xff], extension: 6 } });
  put(table, "popq", { o: { bytes: [0x58] }, m: { bytes: [0x8f], extension: 0 } });
}

function buildTable(): ReadonlyMap<string, OpcodeGroup> {
  const table = new Map<string, OpcodeGroup>();
  addArithmetic(table);
  addShifts(table);
  addUnary(table);
  addMoves(table);
  addSse(table);
  addControl(table);
  return table;
}

const OPCODES = buildTable();

export function opcodeGroup(mnemonic: string, signature: string): OpcodeGroup | undefined {
  return OPCODES.get(`${mnemonic}:${signature}`) ?? OPCODES.get(mnemonic);
}

export function conditionCodeOf(name: string): number | undefined {
  return CONDITION_CODES.get(name);
}
