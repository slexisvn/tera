import { describe, expect, it } from "vitest";
import {
  buildSourceSymbolTable,
  memberReceiverExpression,
  resolveMemberReceiverType,
} from "../../src/frontend/index.js";

const SOURCE = [
  "interface ObjectGuard:",
  "  strict: () -> ObjectGuard",
  "interface GuardApi:",
  "  object: (shape: any) -> ObjectGuard",
  "guard: GuardApi = {}",
  "user_schema = guard.object({",
  "  name: 1,",
  "}).strict()",
].join("\n");

describe("member receiver analysis", () => {
  it("resolves a call closed on the line before a chained member", () => {
    const position = { line: 7, character: "}).strict".length };
    const symbols = buildSourceSymbolTable(SOURCE);

    expect(memberReceiverExpression(SOURCE, position)).toBe("guard.object({\n  name: 1,\n})");
    expect(resolveMemberReceiverType(SOURCE, position, symbols)).toBe("ObjectGuard");
  });

  it("preserves code receivers inside template interpolation", () => {
    const source = [
      "class Account:",
      "  get summary():",
      "    return `${this.owner}`",
    ].join("\n");
    const position = { line: 2, character: "    return `${this.owner".length };
    const symbols = buildSourceSymbolTable(source);

    expect(memberReceiverExpression(source, position)).toBe("this");
    expect(resolveMemberReceiverType(source, position, symbols)).toBe("Account");
  });

  it("resolves string literal receivers without borrowing the previous binding type", () => {
    const source = [
      "complete: Set<int> = Set()",
      "\"\".",
    ].join("\n");
    const position = { line: 1, character: "\"\".".length };
    const symbols = buildSourceSymbolTable(source);

    expect(memberReceiverExpression(source, position)).toBe("\"\"");
    expect(resolveMemberReceiverType(source, position, symbols)).toBe("string");
  });

  it("resolves single quoted string literal receivers", () => {
    const source = "''.";
    const position = { line: 0, character: source.length };
    const symbols = buildSourceSymbolTable(source);

    expect(memberReceiverExpression(source, position)).toBe("''");
    expect(resolveMemberReceiverType(source, position, symbols)).toBe("string");
  });
});
