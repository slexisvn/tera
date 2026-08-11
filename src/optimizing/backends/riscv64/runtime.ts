import type { NativeRuntimeRoutine } from "../../target/artifact.js";
import { INT32_DECIMAL_BYTES } from "../../machine/data.js";

export const RISCV_RUNTIME_SYMBOLS = {
  toInt32: "tera_rv64_to_i32",
  divide: "tera_rv64_i32_div",
  modulo: "tera_rv64_i32_mod",
  minimum: "tera_rv64_math_min",
  maximum: "tera_rv64_math_max",
  charCodeAt: "tera_rv64_char_code_at",
  stringSet: "tera_rv64_str_set",
  stringAppend: "tera_rv64_str_append",
  charAt: "tera_rv64_char_at",
  int32ToString: "tera_rv64_i32_to_str",
} as const;

function toInt32Routine(symbol: string): string {
  return [
    "\tfmv.x.d t0, fa0",
    "\tsrli t1, t0, 52",
    "\tandi t1, t1, 2047",
    "\taddi t1, t1, -1075",
    "\tli t2, 32",
    `\tbge t1, t2, .L${symbol}_zero`,
    "\tslli t3, t0, 12",
    "\tsrli t3, t3, 12",
    "\tli t4, 1",
    "\tslli t4, t4, 52",
    "\tor t3, t3, t4",
    `\tbltz t1, .L${symbol}_right`,
    "\tsll t3, t3, t1",
    `\tj .L${symbol}_sign`,
    `.L${symbol}_right:`,
    "\tsub t2, zero, t1",
    "\tli t4, 64",
    `\tbge t2, t4, .L${symbol}_zero`,
    "\tsrl t3, t3, t2",
    `.L${symbol}_sign:`,
    "\tsext.w a0, t3",
    `\tbgez t0, .L${symbol}_done`,
    "\tsubw a0, zero, a0",
    `.L${symbol}_done:`,
    "\tret",
    `.L${symbol}_zero:`,
    "\tli a0, 0",
    "\tret",
  ].join("\n");
}

function divideRoutine(symbol: string, remainder: boolean): string {
  return [
    `\tbeqz a1, .L${symbol}_zero`,
    "\tli t0, -1",
    `\tbne a1, t0, .L${symbol}_divide`,
    "\tli t1, -2147483648",
    `\tbeq a0, t1, .L${symbol}_zero`,
    `.L${symbol}_divide:`,
    `\t${remainder ? "remw" : "divw"} a0, a0, a1`,
    "\tret",
    `.L${symbol}_zero:`,
    "\tli a0, 0",
    "\tret",
  ].join("\n");
}

function extremumRoutine(symbol: string, keepFirst: string): string {
  return [
    "\tfeq.d t0, fa0, fa0",
    `\tbeqz t0, .L${symbol}_nan`,
    "\tfeq.d t0, fa1, fa1",
    `\tbeqz t0, .L${symbol}_nan`,
    `\t${keepFirst}`,
    `\tbnez t0, .L${symbol}_done`,
    "\tfmv.d fa0, fa1",
    `.L${symbol}_done:`,
    "\tret",
    `.L${symbol}_nan:`,
    "\tfsub.d fa0, fa0, fa0",
    "\tfsub.d fa1, fa1, fa1",
    "\tfadd.d fa0, fa0, fa1",
    "\tret",
  ].join("\n");
}

function charCodeAtRoutine(symbol: string): string {
  return [
    `\tbltz a1, .L${symbol}_zero`,
    "\tadd t0, a0, a1",
    "\tlbu a0, 0(t0)",
    "\tret",
    `.L${symbol}_zero:`,
    "\tli a0, 0",
    "\tret",
  ].join("\n");
}

function copyRoutine(symbol: string, append: boolean): string {
  const seek = append
    ? [
        `.L${symbol}_seek:`,
        `\tblez t1, .L${symbol}_terminate`,
        "\tlbu t2, 0(t0)",
        `\tbeqz t2, .L${symbol}_copy`,
        "\taddi t0, t0, 1",
        "\taddiw t1, t1, -1",
        `\tj .L${symbol}_seek`,
      ]
    : [];
  return [
    `\tblez a1, .L${symbol}_done`,
    "\tmv t0, a0",
    "\taddiw t1, a1, -1",
    ...seek,
    `.L${symbol}_copy:`,
    `\tblez t1, .L${symbol}_terminate`,
    "\tlbu t2, 0(a2)",
    `\tbeqz t2, .L${symbol}_terminate`,
    "\tsb t2, 0(t0)",
    "\taddi t0, t0, 1",
    "\taddi a2, a2, 1",
    "\taddiw t1, t1, -1",
    `\tj .L${symbol}_copy`,
    `.L${symbol}_terminate:`,
    "\tsb zero, 0(t0)",
    `.L${symbol}_done:`,
    "\tret",
  ].join("\n");
}

function charAtRoutine(symbol: string): string {
  return [
    "\tli t0, 2",
    `\tblt a1, t0, .L${symbol}_empty`,
    `\tbltz a3, .L${symbol}_empty`,
    "\tmv t1, a3",
    "\tmv t2, a2",
    `.L${symbol}_walk:`,
    `\tbeqz t1, .L${symbol}_at`,
    "\tlbu t3, 0(t2)",
    `\tbeqz t3, .L${symbol}_empty`,
    "\taddi t2, t2, 1",
    "\taddi t1, t1, -1",
    `\tj .L${symbol}_walk`,
    `.L${symbol}_at:`,
    "\tlbu t3, 0(t2)",
    `\tbeqz t3, .L${symbol}_empty`,
    "\tsb t3, 0(a0)",
    "\tsb zero, 1(a0)",
    "\tret",
    `.L${symbol}_empty:`,
    `\tblez a1, .L${symbol}_done`,
    "\tsb zero, 0(a0)",
    `.L${symbol}_done:`,
    "\tret",
  ].join("\n");
}

function int32ToStringRoutine(symbol: string): string {
  return [
    `\tli t0, ${INT32_DECIMAL_BYTES}`,
    `\tblt a1, t0, .L${symbol}_empty`,
    "\tmv t0, a0",
    "\tsext.w t1, a2",
    `\tbgez t1, .L${symbol}_digits`,
    "\tli t2, 45",
    "\tsb t2, 0(t0)",
    "\taddi t0, t0, 1",
    "\tsub t1, zero, t1",
    `.L${symbol}_digits:`,
    "\tmv t2, t0",
    "\tli t3, 10",
    `.L${symbol}_divide:`,
    "\tremu t4, t1, t3",
    "\tdivu t1, t1, t3",
    "\taddi t4, t4, 48",
    "\tsb t4, 0(t0)",
    "\taddi t0, t0, 1",
    `\tbnez t1, .L${symbol}_divide`,
    "\tsb zero, 0(t0)",
    "\taddi t5, t0, -1",
    `.L${symbol}_reverse:`,
    `\tbgeu t2, t5, .L${symbol}_done`,
    "\tlbu t6, 0(t2)",
    "\tlbu t4, 0(t5)",
    "\tsb t4, 0(t2)",
    "\tsb t6, 0(t5)",
    "\taddi t2, t2, 1",
    "\taddi t5, t5, -1",
    `\tj .L${symbol}_reverse`,
    `.L${symbol}_empty:`,
    `\tblez a1, .L${symbol}_done`,
    "\tsb zero, 0(a0)",
    `.L${symbol}_done:`,
    "\tret",
  ].join("\n");
}

export function riscvRuntimeRoutines(): ReadonlyMap<string, NativeRuntimeRoutine> {
  const routines: NativeRuntimeRoutine[] = [
    {
      symbol: RISCV_RUNTIME_SYMBOLS.toInt32,
      text: toInt32Routine(RISCV_RUNTIME_SYMBOLS.toInt32),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.divide,
      text: divideRoutine(RISCV_RUNTIME_SYMBOLS.divide, false),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.modulo,
      text: divideRoutine(RISCV_RUNTIME_SYMBOLS.modulo, true),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.minimum,
      text: extremumRoutine(RISCV_RUNTIME_SYMBOLS.minimum, "flt.d t0, fa0, fa1"),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.maximum,
      text: extremumRoutine(RISCV_RUNTIME_SYMBOLS.maximum, "flt.d t0, fa1, fa0"),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.charCodeAt,
      text: charCodeAtRoutine(RISCV_RUNTIME_SYMBOLS.charCodeAt),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.stringSet,
      text: copyRoutine(RISCV_RUNTIME_SYMBOLS.stringSet, false),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.stringAppend,
      text: copyRoutine(RISCV_RUNTIME_SYMBOLS.stringAppend, true),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.charAt,
      text: charAtRoutine(RISCV_RUNTIME_SYMBOLS.charAt),
    },
    {
      symbol: RISCV_RUNTIME_SYMBOLS.int32ToString,
      text: int32ToStringRoutine(RISCV_RUNTIME_SYMBOLS.int32ToString),
    },
  ];
  return new Map(routines.map((routine) => [routine.symbol, routine]));
}
