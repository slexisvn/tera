import type { NativeRuntimeRoutine } from "../../target/artifact.js";
import type { RuntimeAbi } from "../../target/abi.js";
import { X64_GPR, x64RegisterName } from "./registers.js";
import { INT32_DECIMAL_BYTES } from "../../machine/data.js";

export const X64_RUNTIME_SYMBOLS = {
  toInt32: "tera_x64_to_i32",
  divide: "tera_x64_i32_div",
  modulo: "tera_x64_i32_mod",
  minimum: "tera_x64_math_min",
  maximum: "tera_x64_math_max",
  charCodeAt: "tera_x64_char_code_at",
  stringSet: "tera_x64_str_set",
  stringAppend: "tera_x64_str_append",
  charAt: "tera_x64_char_at",
  int32ToString: "tera_x64_i32_to_str",
} as const;

export const SIGN_MASK_KEY = "x64:sign-mask";
export const ABS_MASK_KEY = "x64:abs-mask";

const MASKS = new Map<string, readonly string[]>([
  [SIGN_MASK_KEY, ["\t.quad 0x8000000000000000", "\t.quad 0"]],
  [ABS_MASK_KEY, ["\t.quad 0x7fffffffffffffff", "\t.quad 0"]],
]);

export function x64MaskDirectives(key: string): readonly string[] {
  const directives = MASKS.get(key);
  if (directives === undefined) throw new Error(`no x64 mask named ${key}`);
  return directives;
}

function integerArguments(abi: RuntimeAbi): readonly string[][] {
  const registers = abi.callingConvention.argumentRegisters.get(X64_GPR) ?? [];
  return registers.map((register) => [
    x64RegisterName(register, 8),
    x64RegisterName(register, 4),
  ]);
}

function divideRoutine(symbol: string, abi: RuntimeAbi, remainder: boolean): string {
  const [first, second] = integerArguments(abi);
  const result = remainder ? ["\tmovl %edx, %eax"] : [];
  return [
    `\tmovl %${first![1]}, %eax`,
    `\tmovl %${second![1]}, %r8d`,
    "\ttestl %r8d, %r8d",
    `\tje .L${symbol}_zero`,
    "\tcmpl $-1, %r8d",
    `\tjne .L${symbol}_divide`,
    "\tcmpl $-2147483648, %eax",
    `\tje .L${symbol}_zero`,
    `.L${symbol}_divide:`,
    "\tcltd",
    "\tidivl %r8d",
    ...result,
    "\tret",
    `.L${symbol}_zero:`,
    "\txorl %eax, %eax",
    "\tret",
  ].join("\n");
}

function extremumRoutine(symbol: string, keepFirst: string): string {
  return [
    "\tucomisd %xmm1, %xmm0",
    `\tjp .L${symbol}_nan`,
    `\t${keepFirst} .L${symbol}_done`,
    "\tmovapd %xmm1, %xmm0",
    `.L${symbol}_done:`,
    "\tret",
    `.L${symbol}_nan:`,
    "\tsubsd %xmm0, %xmm0",
    "\tsubsd %xmm1, %xmm1",
    "\taddsd %xmm1, %xmm0",
    "\tret",
  ].join("\n");
}

function toInt32Routine(symbol: string): string {
  return [
    "\tcvttsd2si %xmm0, %rax",
    "\tmovabsq $0x8000000000000000, %rdx",
    "\tcmpq %rdx, %rax",
    `\tjne .L${symbol}_done`,
    "\tmovq %xmm0, %rdx",
    "\tmovq %rdx, %rcx",
    "\tshrq $52, %rcx",
    "\tandl $2047, %ecx",
    "\tsubl $1075, %ecx",
    "\tcmpl $32, %ecx",
    `\tjge .L${symbol}_zero`,
    "\tmovabsq $0xfffffffffffff, %rax",
    "\tandq %rdx, %rax",
    "\tmovabsq $0x10000000000000, %r8",
    "\torq %r8, %rax",
    "\tshlq %cl, %rax",
    "\ttestq %rdx, %rdx",
    `\tjns .L${symbol}_done`,
    "\tnegl %eax",
    `.L${symbol}_done:`,
    "\tret",
    `.L${symbol}_zero:`,
    "\txorl %eax, %eax",
    "\tret",
  ].join("\n");
}

function charCodeAtRoutine(symbol: string, abi: RuntimeAbi): string {
  const [text, position] = integerArguments(abi);
  return [
    `\tmovl %${position![1]}, %eax`,
    "\ttestl %eax, %eax",
    `\tjs .L${symbol}_zero`,
    "\tmovslq %eax, %rax",
    `\tmovzbl (%${text![0]},%rax,1), %eax`,
    "\tret",
    `.L${symbol}_zero:`,
    "\txorl %eax, %eax",
    "\tret",
  ].join("\n");
}

function copyRoutine(symbol: string, abi: RuntimeAbi, append: boolean): string {
  const [destination, capacity, source] = integerArguments(abi);
  const seek = append
    ? [
        `.L${symbol}_seek:`,
        "\ttestl %r11d, %r11d",
        `\tjle .L${symbol}_terminate`,
        "\tcmpb $0, (%r9)",
        `\tje .L${symbol}_copy`,
        "\tincq %r9",
        "\tdecl %r11d",
        `\tjmp .L${symbol}_seek`,
      ]
    : [];
  return [
    `\tmovq %${destination![0]}, %r10`,
    `\tmovl %${capacity![1]}, %r11d`,
    `\tmovq %${source![0]}, %rax`,
    "\tmovq %r10, %r9",
    "\ttestl %r11d, %r11d",
    `\tjle .L${symbol}_done`,
    "\tdecl %r11d",
    ...seek,
    `.L${symbol}_copy:`,
    "\ttestl %r11d, %r11d",
    `\tjle .L${symbol}_terminate`,
    "\tmovzbl (%rax), %ecx",
    "\ttestb %cl, %cl",
    `\tje .L${symbol}_terminate`,
    "\tmovb %cl, (%r9)",
    "\tincq %r9",
    "\tincq %rax",
    "\tdecl %r11d",
    `\tjmp .L${symbol}_copy`,
    `.L${symbol}_terminate:`,
    "\tmovb $0, (%r9)",
    `.L${symbol}_done:`,
    "\tmovq %r10, %rax",
    "\tret",
  ].join("\n");
}

function charAtRoutine(symbol: string, abi: RuntimeAbi): string {
  const [destination, capacity, source, position] = integerArguments(abi);
  return [
    `\tmovq %${destination![0]}, %r10`,
    `\tmovl %${capacity![1]}, %r11d`,
    `\tmovq %${source![0]}, %rax`,
    `\tmovl %${position![1]}, %ecx`,
    "\tcmpl $2, %r11d",
    `\tjl .L${symbol}_empty`,
    "\ttestl %ecx, %ecx",
    `\tjs .L${symbol}_empty`,
    "\tmovslq %ecx, %rcx",
    `.L${symbol}_walk:`,
    "\ttestq %rcx, %rcx",
    `\tjz .L${symbol}_at`,
    "\tcmpb $0, (%rax)",
    `\tje .L${symbol}_empty`,
    "\tincq %rax",
    "\tdecq %rcx",
    `\tjmp .L${symbol}_walk`,
    `.L${symbol}_at:`,
    "\tmovzbl (%rax), %ecx",
    "\ttestb %cl, %cl",
    `\tje .L${symbol}_empty`,
    "\tmovb %cl, (%r10)",
    "\tmovb $0, 1(%r10)",
    `\tjmp .L${symbol}_done`,
    `.L${symbol}_empty:`,
    "\ttestl %r11d, %r11d",
    `\tjle .L${symbol}_done`,
    "\tmovb $0, (%r10)",
    `.L${symbol}_done:`,
    "\tmovq %r10, %rax",
    "\tret",
  ].join("\n");
}

function int32ToStringRoutine(symbol: string, abi: RuntimeAbi): string {
  const [destination, capacity, value] = integerArguments(abi);
  return [
    `\tmovq %${destination![0]}, %r10`,
    `\tmovl %${capacity![1]}, %r11d`,
    `\tmovl %${value![1]}, %eax`,
    `\tcmpl $${INT32_DECIMAL_BYTES}, %r11d`,
    `\tjl .L${symbol}_empty`,
    "\tmovq %r10, %r9",
    "\ttestl %eax, %eax",
    `\tjns .L${symbol}_magnitude`,
    "\tmovb $45, (%r9)",
    "\tincq %r9",
    "\tmovslq %eax, %rax",
    "\tnegq %rax",
    `\tjmp .L${symbol}_digits`,
    `.L${symbol}_magnitude:`,
    "\tmovslq %eax, %rax",
    `.L${symbol}_digits:`,
    "\tmovq %r9, %r8",
    "\tmovl $10, %ecx",
    `.L${symbol}_divide:`,
    "\txorl %edx, %edx",
    "\tdivq %rcx",
    "\taddl $48, %edx",
    "\tmovb %dl, (%r9)",
    "\tincq %r9",
    "\ttestq %rax, %rax",
    `\tjnz .L${symbol}_divide`,
    "\tmovb $0, (%r9)",
    "\tleaq -1(%r9), %rcx",
    `.L${symbol}_reverse:`,
    "\tcmpq %r8, %rcx",
    `\tjbe .L${symbol}_done`,
    "\tmovzbl (%r8), %eax",
    "\tmovzbl (%rcx), %edx",
    "\tmovb %dl, (%r8)",
    "\tmovb %al, (%rcx)",
    "\tincq %r8",
    "\tdecq %rcx",
    `\tjmp .L${symbol}_reverse`,
    `.L${symbol}_empty:`,
    "\ttestl %r11d, %r11d",
    `\tjle .L${symbol}_done`,
    "\tmovb $0, (%r10)",
    `.L${symbol}_done:`,
    "\tmovq %r10, %rax",
    "\tret",
  ].join("\n");
}

export function x64RuntimeRoutines(abi: RuntimeAbi): ReadonlyMap<string, NativeRuntimeRoutine> {
  const routines: NativeRuntimeRoutine[] = [
    { symbol: X64_RUNTIME_SYMBOLS.toInt32, text: toInt32Routine(X64_RUNTIME_SYMBOLS.toInt32) },
    {
      symbol: X64_RUNTIME_SYMBOLS.divide,
      text: divideRoutine(X64_RUNTIME_SYMBOLS.divide, abi, false),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.modulo,
      text: divideRoutine(X64_RUNTIME_SYMBOLS.modulo, abi, true),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.minimum,
      text: extremumRoutine(X64_RUNTIME_SYMBOLS.minimum, "jb"),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.maximum,
      text: extremumRoutine(X64_RUNTIME_SYMBOLS.maximum, "ja"),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.charCodeAt,
      text: charCodeAtRoutine(X64_RUNTIME_SYMBOLS.charCodeAt, abi),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.stringSet,
      text: copyRoutine(X64_RUNTIME_SYMBOLS.stringSet, abi, false),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.stringAppend,
      text: copyRoutine(X64_RUNTIME_SYMBOLS.stringAppend, abi, true),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.charAt,
      text: charAtRoutine(X64_RUNTIME_SYMBOLS.charAt, abi),
    },
    {
      symbol: X64_RUNTIME_SYMBOLS.int32ToString,
      text: int32ToStringRoutine(X64_RUNTIME_SYMBOLS.int32ToString, abi),
    },
  ];
  return new Map(routines.map((routine) => [routine.symbol, routine]));
}
