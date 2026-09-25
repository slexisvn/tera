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

  describe("interfaces", () => {
    it("keeps interface member declarations inside the interface scope", () => {
      const source = [
        "interface ArrayGuard:",
        "  of: (schema: GuardSchema) -> ArrayGuard",
        "  min: (size: int) -> ArrayGuard",
      ].join("\n");
      const table = tableOf(source);

      expect(table.resolve("of", { line: 1, character: 2 })?.typeName).toBe("(schema: GuardSchema) -> ArrayGuard");
      expect(table.resolve("min", { line: 2, character: 2 })?.typeName).toBe("(size: int) -> ArrayGuard");
    });

    it("uses imported interface surfaces for member lookup", () => {
      const table = buildSourceSymbolTable("guard: GuardApi = {}\nguard.", [], {
        imports: {
          interfaces: [{
            name: "GuardApi",
            fields: {
              object: { type: "(shape: GuardShape) -> ObjectGuard" },
              string: { type: "() -> StringGuard" },
            },
          }],
        },
      });

      expect(table.membersOf("GuardApi").map((member) => member.name)).toEqual(["object", "string"]);
    });

    it("binds an imported value to its external interface", () => {
      const table = buildSourceSymbolTable("from pkg import guard\nguard.string", [], {
        imports: {
          values: [{ name: "guard", type: "GuardApi" }],
          interfaces: [{
            name: "GuardApi",
            fields: { string: { type: "() -> StringGuard" } },
          }],
        },
      });
      const position = { line: 1, character: "guard".length };

      expect(table.resolve("guard", position)?.typeName).toBe("GuardApi");
      expect(table.resolveField("GuardApi", "string", position)?.typeName).toBe("() -> StringGuard");
    });

    it("resolves later function declarations without hoisting variables", () => {
      const source = [
        "value = later(1)",
        "next_value = pending",
        "fn later(item: int) -> int:",
        "  return item",
        "pending = 1",
      ].join("\n");
      const table = tableOf(source);

      expect(table.resolve("later", { line: 0, character: "value = later".length })?.line).toBe(3);
      expect(table.resolve("pending", { line: 1, character: "next_value = pending".length })).toBeNull();
    });
  });

  describe("type parameters", () => {
    it("keeps type alias parameters scoped through the alias body", () => {
      const source = [
        "type GuardResultOf<T> = {",
        "  ok: bool,",
        "  value: T | null,",
        "}",
      ].join("\n");
      const table = tableOf(source);

      expect(table.resolve("T", { line: 0, character: "type GuardResultOf<".length })?.kind).toBe("type");
      expect(table.resolve("T", { line: 2, character: "  value: ".length })?.line).toBe(1);
      expect(table.resolve("T", { line: 2, character: "  value: ".length })?.column).toBe("type GuardResultOf<".length + 1);
    });

    it("declares object type literal fields and index parameters in alias scope", () => {
      const source = [
        "type GuardObjectValue = { [key: string]: unknown }",
        "type GuardRule = { kind: string, value?: any, message: string }",
      ].join("\n");
      const table = tableOf(source);

      expect(table.resolve("key", { line: 0, character: "type GuardObjectValue = { [key".length })?.typeName).toBe("string");
      expect(table.resolve("kind", { line: 1, character: "type GuardRule = { kind".length })?.typeName).toBe("string");
      expect(table.resolve("value", { line: 1, character: "type GuardRule = { kind: string, value".length })?.typeName).toBe("any");
      expect(table.resolve("message", { line: 1, character: "type GuardRule = { kind: string, value?: any, message".length })?.typeName).toBe("string");
      expect(table.resolveField("GuardRule", "message")?.line).toBe(2);
    });

    it("ignores delimiters inside type literal comments", () => {
      const source = [
        "type GuardRule = {",
        "  kind: string, # }",
        "  value: int,",
        "}",
      ].join("\n");
      const table = tableOf(source);

      expect(table.resolveField("GuardRule", "kind")?.typeName).toBe("string");
      expect(table.resolveField("GuardRule", "value")?.typeName).toBe("int");
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

  describe("arrow functions", () => {
    it("declares typed parameters inside assignment expressions", () => {
      const source = [
        "class NumberSchema:",
        "  constructor():",
        "    this.int = (message: string = \"\") => _number_int(this, message)",
        "",
        "fn _number_int(schema: NumberSchema, message: string) -> NumberGuard:",
        "  return schema",
      ].join("\n");
      const table = tableOf(source);

      expect(table.resolve("message", { line: 2, character: "    this.int = (message".length })?.typeName).toBe("string");
      expect(table.resolve("_number_int", { line: 2, character: "    this.int = (message: string = \"\") => _number_int".length })?.line).toBe(5);
    });
  });

  describe("structural types written with an arrow", () => {
    const structural = tableOf("value = 1");
    const memberNames = (type) => structural.membersOf(type).map((member) => member.name);

    it("reads the field that follows a function-typed one", () => {
      expect(memberNames("{ run: (int) -> int, n: int }")).toEqual(["run", "n"]);
    });

    it("reads both fields when the function-typed one comes last", () => {
      expect(memberNames("{ n: int, run: (int) -> int }")).toEqual(["n", "run"]);
    });

    it("keeps a comma inside a generic field type out of the field split", () => {
      expect(memberNames("{ index: Map<string, int>, n: int }")).toEqual(["index", "n"]);
    });

    it("types a field declared after a function-typed one", () => {
      const field = structural.resolveField("{ run: (int) -> int, n: int }", "n");

      expect(field?.typeName).toBe("int");
    });

    it("keeps the arms of a union apart when one holds a function-typed field", () => {
      expect(memberNames("{ run: (int) -> int, a: int } | { a: int }")).toEqual(["a"]);
    });

    it("still answers only what every arm of a plain union shares", () => {
      expect(memberNames("{ a: int, b: int } | { a: int }")).toEqual(["a"]);
    });
  });
});
