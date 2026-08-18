import { describe, expect, it } from "vitest";
import { buildSourceSymbolTable, inferSymbolTypes } from "../../../src/frontend/checker/index.js";

const BOX = [
  "class Box:",
  "  private secret: int = 1",
  "  public open() -> int:",
  "    return this.secret",
  "value = Box()",
  "other = 2",
].join("\n");

const tableOf = (source) => buildSourceSymbolTable(source, inferSymbolTypes(source));

const scopeNameAt = (source, line) => {
  const scope = tableOf(source).findScopeAt({ line, character: 0 });
  return `${scope.name}/${scope.kind}`;
};

describe("buildSourceSymbolTable", () => {
  describe("scopes", () => {
    it("ends a class scope at its last indented line", () => {
      expect(scopeNameAt(BOX, 4)).toBe("<root>/scope");
      expect(scopeNameAt(BOX, 5)).toBe("<root>/scope");
    });

    it("keeps a method body inside the method scope", () => {
      expect(scopeNameAt(BOX, 3)).toBe("open/function");
    });

    it("stays inside a body on a blank line so completion keeps its locals", () => {
      const source = ["fn area(side: int) -> int:", "  total = side * side", "", "  return total"].join("\n");
      expect(scopeNameAt(source, 2)).toBe("area/function");
    });

    it("declares a statement after a class body in the root scope only", () => {
      const owners = tableOf(BOX).scopes
        .filter((scope) => scope.symbols.some((symbol) => symbol.name === "value"))
        .map((scope) => scope.name);

      expect(owners).toEqual(["<root>"]);
    });
  });

  describe("visibility", () => {
    it("hides a private member from outside the class", () => {
      const members = tableOf(BOX).membersOf("Box", { line: 4, character: 0 });

      expect(members.map((member) => member.name)).toEqual(["open"]);
    });

    it("offers a private member inside its own class", () => {
      const members = tableOf(BOX).membersOf("Box", { line: 3, character: 4 });

      expect(members.map((member) => member.name)).toEqual(expect.arrayContaining(["secret", "open"]));
    });
  });

  describe("synthetic bindings", () => {
    it("gives this no source position of its own", () => {
      const self = tableOf(BOX).flat.find((symbol) => symbol.name === "this");

      expect(self).toMatchObject({ typeName: "Box", line: 0, column: 0 });
    });

    it("still resolves this to the owning class", () => {
      const resolved = tableOf(BOX).resolve("this", { line: 3, character: 11 });

      expect(resolved?.typeName).toBe("Box");
    });

    it("gives super no source position of its own", () => {
      const source = [
        "class Base:",
        "  public tag() -> string:",
        "    return \"base\"",
        "class Child extends Base:",
        "  public tag() -> string:",
        "    return super.tag()",
      ].join("\n");
      const parent = tableOf(source).flat.find((symbol) => symbol.name === "super");

      expect(parent).toMatchObject({ typeName: "Base", line: 0, column: 0 });
    });
  });
});
