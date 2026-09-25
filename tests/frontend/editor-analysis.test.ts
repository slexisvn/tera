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
});
