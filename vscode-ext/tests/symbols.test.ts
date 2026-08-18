import { SymbolKind, type DocumentSymbol, type Position, type Range } from "vscode-languageserver/node.js";
import { afterEach, describe, expect, it } from "vitest";
import { computeDocumentSymbols } from "../src/server/providers/document-symbols.ts";
import { computeWorkspaceSymbols } from "../src/server/providers/workspace-symbols.ts";
import { GEOMETRY, cleanupProjects, contextFor, projectFor } from "./provider-harness.ts";

afterEach(cleanupProjects);

describe("document symbols", () => {
  it("lists top-level declarations with their kinds", () => {
    const source = [
      "fn area(side: int) -> int:",
      "  return side * side",
      "model Net(size: int):",
      "  layer = Linear(size, size)",
      "total = area(3)",
    ].join("\n");
    const symbols = computeDocumentSymbols(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
    });

    expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ["area", SymbolKind.Function],
      ["Net", SymbolKind.Class],
      ["total", SymbolKind.Variable],
    ]);
  });

  it("nests a declaration's own members underneath it", () => {
    const source = [
      "class Report:",
      "  public title: string = \"\"",
      "  render() -> string:",
      "    return this.title",
    ].join("\n");
    const symbols = computeDocumentSymbols(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
    });

    expect(symbols[0]?.name).toBe("Report");
    expect(symbols[0]?.children?.map((child) => child.name)).toEqual(
      expect.arrayContaining(["title", "render"]),
    );
  });

  it("keeps every selection range inside its own symbol range", () => {
    const source = [
      "class Report:",
      "  public title: string = \"\"",
      "  public constructor(title: string):",
      "    this.title = title",
      "  public text() -> string:",
      "    return this.title",
      "report = Report(\"monthly\")",
    ].join("\n");
    const symbols = computeDocumentSymbols(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
    });

    expect(uncontained(symbols)).toEqual([]);
  });

  it("omits the synthetic this binding of a method", () => {
    const source = [
      "class Report:",
      "  public text() -> string:",
      "    return \"\"",
    ].join("\n");
    const symbols = computeDocumentSymbols(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
    });

    expect(symbols[0]?.children?.[0]?.children ?? []).toEqual([]);
  });

  it("lists a statement following a class once, at the top level", () => {
    const source = [
      "class Report:",
      "  public text() -> string:",
      "    return \"\"",
      "report = Report()",
    ].join("\n");
    const symbols = computeDocumentSymbols(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
    });

    expect(names(symbols).filter((name) => name === "report")).toEqual(["report"]);
  });

  it("still nests a local declared inside a function", () => {
    const source = [
      "fn area(side: int) -> int:",
      "  total = side * side",
      "  return total",
    ].join("\n");
    const symbols = computeDocumentSymbols(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
    });

    expect(symbols[0]?.children?.map((child) => child.name)).toEqual(["total"]);
  });

  it("returns nothing for an unknown document", () => {
    expect(computeDocumentSymbols(contextFor("x = 1"), {
      textDocument: { uri: "file:///other.tera" },
    })).toEqual([]);
  });
});

describe("workspace symbols", () => {
  it("finds exported names in every module of the workspace", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const symbols = computeWorkspaceSymbols(project.context, { query: "area" });

    expect(symbols.map((symbol) => `${symbol.containerName}.${symbol.name}`)).toEqual(
      expect.arrayContaining([
        "shapes.area.square_area",
        "shapes.area.rect_area",
        "shapes.area.border_area",
      ]),
    );
  });

  it("never lists a module-private name", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const symbols = computeWorkspaceSymbols(project.context, { query: "negate" });

    expect(symbols).toEqual([]);
  });

  it("points at the declaration in the owning file", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const symbol = computeWorkspaceSymbols(project.context, { query: "max_int" })[0];

    expect(symbol?.location.uri).toBe(project.uri("mathx.tera"));
    expect(symbol?.location.range.start).toEqual({ line: 11, character: 3 });
    expect(symbol?.kind).toBe(SymbolKind.Function);
  });
});

function names(symbols: readonly DocumentSymbol[]): string[] {
  return symbols.flatMap((symbol) => [symbol.name, ...names(symbol.children ?? [])]);
}

function uncontained(symbols: readonly DocumentSymbol[]): string[] {
  return symbols.flatMap((symbol) => [
    ...(contains(symbol.range, symbol.selectionRange) ? [] : [symbol.name]),
    ...uncontained(symbol.children ?? []),
  ]);
}

function contains(outer: Range, inner: Range): boolean {
  return !before(inner.start, outer.start) && !before(outer.end, inner.end);
}

function before(left: Position, right: Position): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}
