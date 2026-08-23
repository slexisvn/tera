import { describe, expect, it } from "vitest";
import { opcodeEffectOf } from "../../../../src/optimizing/backends/x64/mc/opcodes.js";
import { mnemonicsOf } from "../../../helpers/x64-assembly.js";

const src = (...lines: string[]) => lines.join("\n");

function lastFlagWriterBefore(mnemonics: readonly string[], at: number): string | undefined {
  for (let index = at - 1; index >= 0; index--) {
    if (opcodeEffectOf(mnemonics[index]!).writesFlags === true) return mnemonics[index];
  }
  return undefined;
}

describe("x64 instruction effects", () => {
  it.each([
    ["addl", { writesFlags: true }],
    ["subq", { writesFlags: true }],
    ["cmpl", { writesFlags: true }],
    ["testl", { writesFlags: true }],
    ["sarl", { writesFlags: true }],
    ["negl", { writesFlags: true }],
    ["ucomisd", { writesFlags: true }],
  ])("reports that %s writes the condition flags", (opcode, expected) => {
    expect(opcodeEffectOf(opcode)).toMatchObject(expected);
  });

  it.each(["movl", "movq", "leal", "leaq", "notl", "movslq", "movzbl", "addsd", "mulsd"])(
    "reports that %s leaves the condition flags alone",
    (opcode) => {
      const effect = opcodeEffectOf(opcode);
      expect(effect.writesFlags).not.toBe(true);
      expect(effect.readsFlags).not.toBe(true);
    },
  );

  it.each(["jl", "jne", "jp", "cmovlel", "cmovneq", "sete"])(
    "reports that %s reads the condition flags",
    (opcode) => {
      expect(opcodeEffectOf(opcode)).toMatchObject({ readsFlags: true });
    },
  );

  it.each(["jmp", "ret", "cltq"])("reports that %s neither reads nor writes them", (opcode) => {
    const effect = opcodeEffectOf(opcode);
    expect(effect.writesFlags).not.toBe(true);
    expect(effect.readsFlags).not.toBe(true);
  });

  it.each(["call", "pushq", "popq", "syscall"])("treats %s as a barrier", (opcode) => {
    expect(opcodeEffectOf(opcode)).toMatchObject({ barrier: true });
  });

  it("treats an opcode it does not model as reading, writing and blocking", () => {
    expect(opcodeEffectOf("xadd")).toEqual({
      readsFlags: true,
      writesFlags: true,
      barrier: true,
    });
  });

  it("prices a divide above a multiply and a multiply above a move", () => {
    const move = opcodeEffectOf("movl").latency ?? 1;
    const multiply = opcodeEffectOf("imull").latency ?? 1;
    const divide = opcodeEffectOf("divsd").latency ?? 1;

    expect(multiply).toBeGreaterThan(move);
    expect(divide).toBeGreaterThan(multiply);
  });
});

describe("x64 scheduling keeps the flags a branch reads", () => {
  const CLAMPS = src(
    "fn clamp(n: int) -> int:",
    "  acc: int = n",
    "  if n < 0:",
    "    acc = 0 - n",
    "  return acc",
    "",
    "print(clamp(-3))",
  );

  const COUNTS = src(
    "fn total(n: int) -> int:",
    "  acc: int = 0",
    "  i: int = 0",
    "  while i < n:",
    "    acc = acc + i * 3 - 1",
    "    i = i + 1",
    "  return acc",
    "",
    "print(total(4))",
  );

  it.each([
    ["clamp", CLAMPS],
    ["total", COUNTS],
  ])("leaves a compare as the last thing to write the flags %s reads", (name, source) => {
    const mnemonics = mnemonicsOf(source, name);
    const readers = mnemonics.filter((opcode) => opcodeEffectOf(opcode).readsFlags === true);

    expect(readers).not.toEqual([]);
    for (let at = 0; at < mnemonics.length; at++) {
      if (opcodeEffectOf(mnemonics[at]!).readsFlags !== true) continue;
      expect({
        reader: mnemonics[at],
        writer: lastFlagWriterBefore(mnemonics, at),
      }).toMatchObject({
        writer: expect.stringMatching(/^(cmp|test|ucomisd)/) as unknown as string,
      });
    }
  });

  it("still folds the compare into the conditional move", () => {
    expect(mnemonicsOf(CLAMPS, "clamp").some((opcode) => opcode.startsWith("cmov"))).toBe(true);
  });
});
