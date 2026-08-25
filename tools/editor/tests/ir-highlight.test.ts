import { describe, expect, it } from "vitest";
import { highlightIr } from "../src/ir/highlight";

function classOf(line: string, token: string): string {
  return highlightIr(line).find((entry) => entry.text === token)?.cls ?? "missing";
}

function joined(line: string): string {
  return highlightIr(line)
    .map((entry) => entry.text)
    .join("");
}

describe("colouring a printed IR line", () => {
  it("gives values and blocks their own colour so a reference is followable", () => {
    const line = "    v11 = Int32Add v5, v24";

    expect(classOf(line, "v11")).toBe("ir-value");
    expect(classOf(line, "v5")).toBe("ir-value");
    expect(classOf("  B3 loop-header succs=B2,B1 preds=B0,B2:", "B3")).toBe("ir-block");
  });

  it("marks the two flags a reader is meant to notice", () => {
    expect(classOf("    v12 = CheckMap v11 !fs", "!fs")).toBe("ir-frame-state");
    expect(classOf("  B3 loop-header succs=B2:", "loop-header")).toBe("ir-flag");
  });

  it("calls the word right after the equals sign the opcode", () => {
    expect(classOf("    v11 = Int32Add v5, v24", "Int32Add")).toBe("ir-opcode");
    expect(classOf("    v3 = Jump [targetBlock=3]", "Jump")).toBe("ir-opcode");
  });

  it("does not promote a later capitalised word to a second opcode", () => {
    const line = '    v8 = Branch v7 [trueBlock=2, hotSuccessor="true"]';
    const opcodes = highlightIr(line).filter((entry) => entry.cls === "ir-opcode");

    expect(opcodes.map((entry) => entry.text)).toEqual(["Branch"]);
  });

  it("separates a property name from its value", () => {
    const line = "    v1 = Constant [value=3]";

    expect(classOf(line, "value")).toBe("ir-prop");
    expect(classOf(line, "3")).toBe("ir-number");
  });

  it("keeps the header keywords apart from the names beside them", () => {
    const line = "fn work params=1 {";

    expect(classOf(line, "fn")).toBe("ir-keyword");
    expect(classOf(line, "params")).toBe("ir-keyword");
    expect(classOf(line, "work")).toBe("ir-prop");
  });

  it("reads a quoted property value as a string, negatives as numbers", () => {
    expect(classOf('    v7 = Int32Compare v6, v0 [op="<"]', '"<"')).toBe("ir-string");
    expect(classOf("    v9 = Constant [value=-42]", "-42")).toBe("ir-number");
  });

  it("emits every character of the line, so the painted line still reads as itself", () => {
    for (const line of [
      "fn work params=1 {",
      "  B3 loop-header succs=B2,B1 preds=B0,B2:",
      '    v8 = Branch v7 [trueBlock=2, hotSuccessor="true"] !fs',
      "}",
      "",
    ]) {
      expect(joined(line)).toBe(line);
    }
  });

  it("gives whitespace no class, so indentation is never painted", () => {
    const spaces = highlightIr("    v1 = Constant").filter((entry) => entry.text.trim() === "");

    expect(spaces.length).toBeGreaterThan(0);
    expect(spaces.every((entry) => entry.cls === "")).toBe(true);
  });

  it("starts each line clean, so one line cannot colour the next", () => {
    const first = highlightIr("    v11 = Int32Add v5, v24");
    const again = highlightIr("    v11 = Int32Add v5, v24");

    expect(again).toEqual(first);
    expect(classOf("    Int32Add v5", "Int32Add")).toBe("ir-prop");
  });
});
