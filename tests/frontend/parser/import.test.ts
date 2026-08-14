import { describe, it, expect } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { NodeType, type ASTNode, type ImportSpecifierNode } from "../../../src/frontend/ast/index.js";
import { lowerToSemanticProgram } from "../../../src/frontend/checker/semantic-lowering.js";
import type { ImportNode } from "../../../src/frontend/checker/semantic-ast.js";

type Positioned = { __line?: number; __column?: number };

function statements(source: string): ASTNode[] {
  return (parse(source) as ASTNode & { body: ASTNode[] }).body;
}

function only(source: string): ASTNode {
  const body = statements(source);
  expect(body).toHaveLength(1);
  return body[0]!;
}

function specifiers(node: ASTNode): ImportSpecifierNode[] {
  return node.specifiers as ImportSpecifierNode[];
}

function imports(source: string): ImportNode[] {
  return lowerToSemanticProgram(source).body.filter(
    (node): node is ImportNode => node.kind === "Import",
  );
}

describe("import declarations", () => {
  it("parses a bare module import", () => {
    const node = only("import math\n");
    expect(node.type).toBe(NodeType.ImportDeclaration);
    expect(node.path).toEqual(["math"]);
    expect(node.alias).toBeNull();
  });

  it("parses an aliased import", () => {
    const node = only("import math as m\n");
    expect(node.path).toEqual(["math"]);
    expect(node.alias).toBe("m");
  });

  it("parses a dotted module path", () => {
    const node = only("import app.util.text\n");
    expect(node.path).toEqual(["app", "util", "text"]);
  });

  it("parses a dotted module path with an alias", () => {
    const node = only("import app.util.text as text\n");
    expect(node.path).toEqual(["app", "util", "text"]);
    expect(node.alias).toBe("text");
  });

  it("splits comma separated imports into one node each", () => {
    const body = statements("import a, b as c\n");
    expect(body).toHaveLength(2);
    expect(body[0]!.path).toEqual(["a"]);
    expect(body[0]!.alias).toBeNull();
    expect(body[1]!.path).toEqual(["b"]);
    expect(body[1]!.alias).toBe("c");
  });
});

describe("from-import declarations", () => {
  it("parses a single name", () => {
    const node = only("from math import sin\n");
    expect(node.type).toBe(NodeType.ImportFromDeclaration);
    expect(node.level).toBe(0);
    expect(node.path).toEqual(["math"]);
    expect(specifiers(node)).toEqual([{ imported: "sin", local: "sin" }]);
  });

  it("parses several names with aliases", () => {
    const node = only("from math import sin, cos as c\n");
    expect(specifiers(node)).toEqual([
      { imported: "sin", local: "sin" },
      { imported: "cos", local: "c" },
    ]);
  });

  it("parses a parenthesized list spanning lines with a trailing comma", () => {
    const node = only("from app.util.text import (\n  slugify,\n  normalize as norm,\n)\n");
    expect(node.path).toEqual(["app", "util", "text"]);
    expect(specifiers(node)).toEqual([
      { imported: "slugify", local: "slugify" },
      { imported: "normalize", local: "norm" },
    ]);
  });

  it("counts one leading dot as a sibling import", () => {
    const node = only("from .sibling import thing\n");
    expect(node.level).toBe(1);
    expect(node.path).toEqual(["sibling"]);
  });

  it("counts two leading dots as a parent import", () => {
    const node = only("from ..core.shapes import Circle\n");
    expect(node.level).toBe(2);
    expect(node.path).toEqual(["core", "shapes"]);
  });

  it("counts three leading dots even though they lex as a spread token", () => {
    const node = only("from ...root import thing\n");
    expect(node.level).toBe(3);
    expect(node.path).toEqual(["root"]);
  });

  it("parses a package-only relative import", () => {
    const node = only("from . import sibling\n");
    expect(node.level).toBe(1);
    expect(node.path).toEqual([]);
  });
});

describe("import spans", () => {
  it("records a span on the statement", () => {
    const node = only("\nimport math\n") as ASTNode & Positioned;
    expect(node.__line).toBe(2);
  });

  it("records a span on each specifier", () => {
    const node = only("from math import sin, cos\n");
    const [sin, cos] = specifiers(node) as Array<ImportSpecifierNode & Positioned>;
    expect(sin!.__column).toBe(18);
    expect(cos!.__column).toBe(23);
  });
});

describe("import placement", () => {
  it("rejects an import inside a function body", () => {
    expect(() => parse("fn f():\n  import math\n")).toThrow(
      /import is only allowed at module top level/,
    );
  });

  it("rejects an import inside an if body", () => {
    expect(() => parse("if true:\n  import math\n")).toThrow(
      /import is only allowed at module top level/,
    );
  });

  it("rejects an import inside a loop body", () => {
    expect(() => parse("for i of items:\n  import math\n")).toThrow(
      /import is only allowed at module top level/,
    );
  });

  it("rejects an import inside a class method", () => {
    expect(() => parse("class C:\n  public m():\n    import math\n")).toThrow(
      /import is only allowed at module top level/,
    );
  });

  it("rejects a star import with a usable suggestion", () => {
    expect(() => parse("from math import *\n")).toThrow(/is not supported/);
  });

  it("rejects a from clause with no module", () => {
    expect(() => parse("from import sin\n")).toThrow(/Expected a module name after 'from'/);
  });
});

describe("import lowering", () => {
  it("lowers a namespace import with no bindings", () => {
    const [node] = imports("import app.util.text as text\n");
    expect(node).toMatchObject({
      kind: "Import",
      level: 0,
      path: ["app", "util", "text"],
      alias: "text",
      bindings: [],
    });
  });

  it("lowers a from-import with bindings carrying spans", () => {
    const [node] = imports("from .text import slugify as slug\n");
    expect(node!.level).toBe(1);
    expect(node!.alias).toBeNull();
    expect(node!.bindings).toEqual([
      { imported: "slugify", local: "slug", span: { line: 1, column: 19 } },
    ]);
  });
});

describe("import compilation", () => {
  it("keeps import statements out of generated bytecode", () => {
    const body = statements("import math\nx = 1\n");
    expect(body[0]!.type).toBe(NodeType.ImportDeclaration);
    expect(body).toHaveLength(2);
  });
});
