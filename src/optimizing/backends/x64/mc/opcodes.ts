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

export interface OpcodeEffect {
  readonly readsFlags?: boolean;
  readonly writesFlags?: boolean;
  readonly barrier?: boolean;
  readonly latency?: number;
}

export interface OpcodeGroup {
  readonly effect?: OpcodeEffect;
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
  readonly rmi8?: OpcodeForm;
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

const WRITES_FLAGS: OpcodeEffect = { writesFlags: true };
const READS_FLAGS: OpcodeEffect = { readsFlags: true };
const BARRIER: OpcodeEffect = { readsFlags: true, writesFlags: true, barrier: true };

const MULTIPLY_LATENCY = 3;
const DIVIDE_LATENCY = 20;
const FLOAT_LATENCY = 4;
const FLOAT_DIVIDE_LATENCY = 14;

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

const UNARY: readonly (readonly [string, number, OpcodeEffect])[] = [
  ["not", 2, {}],
  ["neg", 3, WRITES_FLAGS],
  ["mul", 4, { writesFlags: true, latency: MULTIPLY_LATENCY }],
  ["imul", 5, { writesFlags: true, latency: MULTIPLY_LATENCY }],
  ["div", 6, { writesFlags: true, latency: DIVIDE_LATENCY }],
  ["idiv", 7, { writesFlags: true, latency: DIVIDE_LATENCY }],
];

const FLOAT_ARITHMETIC: OpcodeEffect = { latency: FLOAT_LATENCY };
const FLOAT_DIVISION: OpcodeEffect = { latency: FLOAT_DIVIDE_LATENCY };
const FLOAT_COMPARE: OpcodeEffect = { writesFlags: true, latency: FLOAT_LATENCY };

const SSE_BINARY: readonly (readonly [string, number, number, OpcodeEffect])[] = [
  ["addsd", 0xf2, 0x58, FLOAT_ARITHMETIC],
  ["subsd", 0xf2, 0x5c, FLOAT_ARITHMETIC],
  ["mulsd", 0xf2, 0x59, FLOAT_ARITHMETIC],
  ["divsd", 0xf2, 0x5e, FLOAT_DIVISION],
  ["sqrtsd", 0xf2, 0x51, FLOAT_DIVISION],
  ["minsd", 0xf2, 0x5d, FLOAT_ARITHMETIC],
  ["maxsd", 0xf2, 0x5f, FLOAT_ARITHMETIC],
  ["addss", 0xf3, 0x58, FLOAT_ARITHMETIC],
  ["subss", 0xf3, 0x5c, FLOAT_ARITHMETIC],
  ["mulss", 0xf3, 0x59, FLOAT_ARITHMETIC],
  ["divss", 0xf3, 0x5e, FLOAT_DIVISION],
  ["ucomisd", 0x66, 0x2e, FLOAT_COMPARE],
  ["comisd", 0x66, 0x2f, FLOAT_COMPARE],
  ["xorpd", 0x66, 0x57, FLOAT_ARITHMETIC],
  ["andpd", 0x66, 0x54, FLOAT_ARITHMETIC],
  ["orpd", 0x66, 0x56, FLOAT_ARITHMETIC],
  ["andnpd", 0x66, 0x55, FLOAT_ARITHMETIC],
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
        effect: WRITES_FLAGS,
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
        effect: WRITES_FLAGS,
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
  for (const [name, extension, effect] of UNARY) {
    for (const [suffix, rexW, byteForm] of WIDTHS) {
      put(table, `${name}${suffix}`, {
        effect,
        m: { bytes: [byteForm ? 0xf6 : 0xf7], rexW, extension },
      });
    }
  }
  for (const [suffix, rexW, byteForm] of WIDTHS) {
    put(table, `inc${suffix}`, {
      effect: WRITES_FLAGS,
      m: { bytes: [byteForm ? 0xfe : 0xff], rexW, extension: 0 },
    });
    put(table, `dec${suffix}`, {
      effect: WRITES_FLAGS,
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
      effect: WRITES_FLAGS,
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
    effect: { writesFlags: true, latency: MULTIPLY_LATENCY },
    rm: { bytes: [0x0f, 0xaf] },
    rmi: { bytes: [0x69], immediateBytes: 4 },
    rmi8: { bytes: [0x6b], immediateBytes: 1 },
  });
  put(table, "imulq", {
    effect: { writesFlags: true, latency: MULTIPLY_LATENCY },
    rm: { bytes: [0x0f, 0xaf], rexW: true },
    rmi: { bytes: [0x69], rexW: true, immediateBytes: 4 },
    rmi8: { bytes: [0x6b], rexW: true, immediateBytes: 1 },
  });
}

function addSse(table: Map<string, OpcodeGroup>): void {
  for (const [name, mandatory, opcode, effect] of SSE_BINARY) {
    put(table, name, { effect, rm: { bytes: [0x0f, opcode], mandatory } });
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
  put(table, "cvtsi2sdl", { effect: FLOAT_ARITHMETIC, rm: { bytes: [0x0f, 0x2a], mandatory: 0xf2 } });
  put(table, "cvtsi2sdq", {
    effect: FLOAT_ARITHMETIC,
    rm: { bytes: [0x0f, 0x2a], mandatory: 0xf2, rexW: true },
  });
  put(table, "cvttsd2sil", { effect: FLOAT_ARITHMETIC, rm: { bytes: [0x0f, 0x2c], mandatory: 0xf2 } });
  put(table, "cvttsd2siq", {
    effect: FLOAT_ARITHMETIC,
    rm: { bytes: [0x0f, 0x2c], mandatory: 0xf2, rexW: true },
  });
  put(table, "cvtsd2ss", { effect: FLOAT_ARITHMETIC, rm: { bytes: [0x0f, 0x5a], mandatory: 0xf2 } });
  put(table, "cvtss2sd", { effect: FLOAT_ARITHMETIC, rm: { bytes: [0x0f, 0x5a], mandatory: 0xf3 } });
  put(table, "roundsd", {
    effect: FLOAT_ARITHMETIC,
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
      effect: READS_FLAGS,
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
      effect: READS_FLAGS,
      m: { bytes: [0x0f, 0x90 + number], extension: 0 },
    });
    put(table, `cmov${code}l`, {
      effect: READS_FLAGS,
      rm: { bytes: [0x0f, 0x40 + number] },
    });
    put(table, `cmov${code}q`, {
      effect: READS_FLAGS,
      rm: { bytes: [0x0f, 0x40 + number], rexW: true },
    });
  }
  put(table, "jmp", {
    branch: [
      { bytes: [0xeb], displacementBytes: 1, fixupKind: X64_PC_RELATIVE_8 },
      { bytes: [0xe9], displacementBytes: 4, fixupKind: X64_PC_RELATIVE_32 },
    ],
    m: { bytes: [0xff], extension: 4 },
  });
  put(table, "call", {
    effect: BARRIER,
    branch: [{ bytes: [0xe8], displacementBytes: 4, fixupKind: X64_BRANCH_32 }],
    m: { bytes: [0xff], extension: 2 },
  });
  put(table, "ret", { none: { bytes: [0xc3] } });
  put(table, "leave", {
    effect: BARRIER, none: { bytes: [0xc9] } });
  put(table, "nop", { none: { bytes: [0x90] } });
  put(table, "ud2", {
    effect: BARRIER, none: { bytes: [0x0f, 0x0b] } });
  put(table, "cltd", { none: { bytes: [0x99] } });
  put(table, "cqto", { none: { bytes: [0x99], rexW: true } });
  put(table, "cwtl", { none: { bytes: [0x98] } });
  put(table, "cltq", { none: { bytes: [0x98], rexW: true } });
  put(table, "syscall", {
    effect: BARRIER, none: { bytes: [0x0f, 0x05] } });
  put(table, "pushq", {
    effect: BARRIER,
    o: { bytes: [0x50] },
    m: { bytes: [0xff], extension: 6 },
  });
  put(table, "popq", {
    effect: BARRIER,
    o: { bytes: [0x58] },
    m: { bytes: [0x8f], extension: 0 },
  });
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

const UNMODELLED: OpcodeEffect = { readsFlags: true, writesFlags: true, barrier: true };

export function opcodeEffectOf(mnemonic: string): OpcodeEffect {
  const group = OPCODES.get(mnemonic);
  if (group === undefined) return UNMODELLED;
  return group.effect ?? {};
}

export function conditionCodeOf(name: string): number | undefined {
  return CONDITION_CODES.get(name);
}
