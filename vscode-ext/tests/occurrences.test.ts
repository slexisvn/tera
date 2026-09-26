import { afterEach, describe, expect, it } from "vitest";
import { computeDefinition } from "../src/server/providers/definition.ts";
import { computeHighlights } from "../src/server/providers/document-highlight.ts";
import { computeReferences } from "../src/server/providers/references.ts";
import { computeRename } from "../src/server/providers/rename.ts";
import { GEOMETRY, cleanupProjects, contextFor, projectFor, type ModuleProject } from "./provider-harness.ts";

afterEach(cleanupProjects);

type Site = { file: string; line: number; character: number };

function sitesOf(project: ModuleProject, locations: readonly { uri: string; range: { start: { line: number; character: number } } }[]): Site[] {
  return locations
    .map((location) => ({
      file: shortName(project, location.uri),
      line: location.range.start.line,
      character: location.range.start.character,
    }))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.character - right.character);
}

function shortName(project: ModuleProject, uri: string): string {
  for (const relative of ["main.tera", "mathx.tera", "shapes/__init__.tera", "shapes/area.tera", "lib.tera", "app.tera"]) {
    if (project.uri(relative) === uri) return relative;
  }
  return uri;
}

function references(project: ModuleProject, relative: string, line: number, character: number, includeDeclaration = true) {
  return computeReferences(project.context, {
    textDocument: { uri: project.uri(relative) },
    position: { line, character },
    context: { includeDeclaration },
  }) ?? [];
}

function rename(project: ModuleProject, relative: string, line: number, character: number, newName: string) {
  return computeRename(project.context, {
    textDocument: { uri: project.uri(relative) },
    position: { line, character },
    newName,
  });
}

describe("document highlight across imports", () => {
  it("links an import specifier to its uses in the body", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const highlights = computeHighlights(project.context, {
      textDocument: { uri: project.uri("main.tera") },
      position: { line: 7, character: "print(floor_area(), abs_int".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 1, character: "from mathx import ".length },
      { line: 7, character: "print(floor_area(), ".length },
    ]);
  });

  it("does not link an object literal key to a same-named parameter value", () => {
    const source = [
      "class StringSchema:",
      "  public max(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"max\", value: size, message: message })",
      "    return this",
    ].join("\n");
    const highlights = computeHighlights(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 2, character: "    this.rules.push({ kind: \"max\", value: size, message: message".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 1, character: "  public max(size: int, ".length },
      { line: 2, character: "    this.rules.push({ kind: \"max\", value: size, message: ".length },
    ]);
  });

  it("does not link named argument keys to a same-named model parameter", () => {
    const source = [
      "model IrisNet(num_classes: int):",
      "  net = Sequential(",
      "    Linear(4, 32),",
      "    BatchNorm1d(32),",
      "    ReLU(),",
      "    Dropout(p=0.1),",
      "    Linear(32, 16),",
      "    ReLU(),",
      "    Linear(16, num_classes)",
      "  )",
      "  loss_fn = CrossEntropyLoss()",
      "  acc = Accuracy(task=\"multiclass\", num_classes=num_classes)",
      "  f1 = F1Score(task=\"multiclass\", num_classes=num_classes)",
    ].join("\n");
    const highlights = computeHighlights(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 0, character: "model IrisNet(num_classes".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 0, character: "model IrisNet(".length },
      { line: 8, character: "    Linear(16, ".length },
      { line: 11, character: "  acc = Accuracy(task=\"multiclass\", num_classes=".length },
      { line: 12, character: "  f1 = F1Score(task=\"multiclass\", num_classes=".length },
    ]);
  });

  it("keeps a named argument key highlight on the key when a parameter has the same name", () => {
    const source = [
      "model IrisNet(num_classes: int):",
      "  acc = Accuracy(task=\"multiclass\", num_classes=num_classes)",
    ].join("\n");
    const highlights = computeHighlights(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 1, character: "  acc = Accuracy(task=\"multiclass\", num_classes".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 1, character: "  acc = Accuracy(task=\"multiclass\", ".length },
    ]);
  });

  it("keeps an object literal key highlight on the key when a parameter has the same name", () => {
    const source = [
      "class StringSchema:",
      "  public length(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"length\", value: size, message: message })",
      "    return this",
    ].join("\n");
    const highlights = computeHighlights(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 2, character: "    this.rules.push({ kind: \"length\", value: size, message".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 2, character: "    this.rules.push({ kind: \"length\", value: size, ".length },
    ]);
  });

  it("highlights every reference for a focused member declaration", () => {
    const source = [
      "class StringSchema:",
      "  private rules: GuardRule[] = []",
      "  public constructor():",
      "    this.rules = []",
      "  public min(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"min\", value: size, message: message })",
      "    return this",
      "  public max(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"max\", value: size, message: message })",
      "    return this",
    ].join("\n");
    const highlights = computeHighlights(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 1, character: "  private ".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 1, character: "  private ".length },
      { line: 3, character: "    this.".length },
      { line: 5, character: "    this.".length },
      { line: 8, character: "    this.".length },
    ]);
  });

  it("highlights every reference for a focused member access", () => {
    const source = [
      "class StringSchema:",
      "  private rules: GuardRule[] = []",
      "  public constructor():",
      "    this.rules = []",
      "  public min(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"min\", value: size, message: message })",
      "    return this",
      "  public max(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"max\", value: size, message: message })",
      "    return this",
    ].join("\n");
    const highlights = computeHighlights(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 8, character: "    this.rules".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 1, character: "  private ".length },
      { line: 3, character: "    this.".length },
      { line: 5, character: "    this.".length },
      { line: 8, character: "    this.".length },
    ]);
  });

  it("keeps document highlights independent from earlier definition requests", () => {
    const source = [
      "class StringSchema:",
      "  private rules: GuardRule[] = []",
      "  public constructor():",
      "    this.rules = []",
      "  public min(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"min\", value: size, message: message })",
      "    return this",
      "  public max(size: int, message: string = \"\") -> StringGuard:",
      "    this.rules.push({ kind: \"max\", value: size, message: message })",
      "    return this",
    ].join("\n");
    const context = contextFor(source);
    const definition = computeDefinition(context, {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 8, character: "    this.rules".length },
    });
    expect(definition?.range.start).toEqual({ line: 1, character: "  private ".length });

    const highlights = computeHighlights(context, {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 1, character: "  private ".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 1, character: "  private ".length },
      { line: 3, character: "    this.".length },
      { line: 5, character: "    this.".length },
      { line: 8, character: "    this.".length },
    ]);
  });

  it("keeps an object literal key local even when an import has the same name", () => {
    const project = projectFor({
      "lib.tera": "fn validate(value: int) -> bool:\n  return true\n",
      "app.tera": [
        "from lib import validate",
        "guard = { validate: validate }",
      ].join("\n"),
    }, ["app.tera"]);
    const highlights = computeHighlights(project.context, {
      textDocument: { uri: project.uri("app.tera") },
      position: { line: 1, character: "guard = { validate".length },
    });

    expect(highlights?.map((entry) => entry.range.start)).toEqual([
      { line: 1, character: "guard = { ".length },
    ]);
  });
});

describe("references across modules", () => {
  it("finds the declaration, the re-export, the alias and the body use", () => {
    const project = projectFor(GEOMETRY, ["main.tera", "shapes/area.tera"]);
    const found = references(project, "shapes/area.tera", 8, "fn border_area".length);

    expect(sitesOf(project, found)).toEqual([
      { file: "main.tera", line: 2, character: "from shapes.area import ".length },
      { file: "main.tera", line: 2, character: "from shapes.area import border_area as ".length },
      { file: "main.tera", line: 5, character: "  return shapes.square_area(4) + ".length },
      { file: "shapes/__init__.tera", line: 0, character: "from .area import square_area, rect_area, ".length },
      { file: "shapes/area.tera", line: 8, character: "fn ".length },
    ]);
  });

  it("finds a use reached through a namespace import of a re-exporting package", () => {
    const project = projectFor(GEOMETRY, ["main.tera", "shapes/area.tera"]);
    const found = references(project, "shapes/area.tera", 2, "fn square_area".length);

    expect(sitesOf(project, found)).toContainEqual({
      file: "main.tera",
      line: 5,
      character: "  return shapes.".length,
    });
  });

  it("omits the declaration when the client does not ask for it", () => {
    const project = projectFor(GEOMETRY, ["shapes/area.tera"]);
    const found = references(project, "shapes/area.tera", 8, "fn border_area".length, false);

    expect(sitesOf(project, found)).not.toContainEqual({ file: "shapes/area.tera", line: 8, character: 3 });
  });

  it("falls back to the current file for a local name", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": "fn add(left: int, right: int) -> int:\n  return left + right\n",
    }, ["main.tera"]);
    const found = references(project, "main.tera", 1, "  return left".length);

    expect(sitesOf(project, found).every((site) => site.file === "main.tera")).toBe(true);
  });

  it("does not count object literal keys as local variable references", () => {
    const project = projectFor({
      "main.tera": [
        "fn send(message: string):",
        "  return { message: message }",
      ].join("\n"),
    }, ["main.tera"]);
    const found = references(project, "main.tera", 1, "  return { message: message".length);

    expect(sitesOf(project, found)).toEqual([
      { file: "main.tera", line: 0, character: "fn send(".length },
      { file: "main.tera", line: 1, character: "  return { message: ".length },
    ]);
  });

  it("does not count named argument keys as local variable references", () => {
    const project = projectFor({
      "main.tera": [
        "model IrisNet(num_classes: int):",
        "  acc = Accuracy(task=\"multiclass\", num_classes=num_classes)",
      ].join("\n"),
    }, ["main.tera"]);
    const found = references(project, "main.tera", 1, "  acc = Accuracy(task=\"multiclass\", num_classes=num_classes".length);

    expect(sitesOf(project, found)).toEqual([
      { file: "main.tera", line: 0, character: "model IrisNet(".length },
      { file: "main.tera", line: 1, character: "  acc = Accuracy(task=\"multiclass\", num_classes=".length },
    ]);
  });
});

describe("rename across modules", () => {
  it("renames the declaration, every import specifier and every use", () => {
    const project = projectFor({
      "lib.tera": ["fn square(n: int) -> int:", "  return n * n"].join("\n"),
      "app.tera": ["from lib import square", "print(square(2))", "print(square(3))"].join("\n"),
    }, ["lib.tera", "app.tera"]);
    const edit = rename(project, "lib.tera", 0, "fn square".length, "sq");

    expect(edit?.changes?.[project.uri("lib.tera")]?.map((entry) => entry.range.start)).toEqual([
      { line: 0, character: 3 },
    ]);
    expect(edit?.changes?.[project.uri("app.tera")]?.map((entry) => entry.range.start)).toEqual([
      { line: 0, character: "from lib import ".length },
      { line: 1, character: "print(".length },
      { line: 2, character: "print(".length },
    ]);
    for (const edits of Object.values(edit?.changes ?? {})) {
      for (const entry of edits) expect(entry.newText).toBe("sq");
    }
  });

  it("rewrites the imported name but not an alias that keeps its own spelling", () => {
    const project = projectFor(GEOMETRY, ["shapes/area.tera"]);
    const edit = rename(project, "shapes/area.tera", 8, "fn border_area".length, "edge_area");
    const main = edit?.changes?.[project.uri("main.tera")] ?? [];

    expect(main.map((entry) => entry.range.start)).toEqual([
      { line: 2, character: "from shapes.area import ".length },
    ]);
    expect(edit?.changes?.[project.uri("shapes/__init__.tera")]).toHaveLength(1);
  });

  it("renames only the alias when the cursor is on the alias", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const edit = rename(project, "main.tera", 5, "  return shapes.square_area(4) + border".length, "edge");

    expect(Object.keys(edit?.changes ?? {})).toEqual([project.uri("main.tera")]);
    expect(edit?.changes?.[project.uri("main.tera")]?.map((entry) => entry.range.start)).toEqual([
      { line: 2, character: "from shapes.area import border_area as ".length },
      { line: 5, character: "  return shapes.square_area(4) + ".length },
    ]);
  });

  it("refuses a rename that is not a valid identifier", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    expect(rename(project, "main.tera", 1, "from mathx import abs_int".length, "not a name")).toBeNull();
  });

  it("renames a local value without changing an object literal key", () => {
    const project = projectFor({
      "main.tera": [
        "fn send(message: string):",
        "  return { message: message }",
      ].join("\n"),
    }, ["main.tera"]);
    const edit = rename(project, "main.tera", 1, "  return { message: message".length, "text");

    expect(edit?.changes?.[project.uri("main.tera")]?.map((entry) => entry.range.start)).toEqual([
      { line: 0, character: "fn send(".length },
      { line: 1, character: "  return { message: ".length },
    ]);
  });

  it("renames a local value without changing a named argument key", () => {
    const project = projectFor({
      "main.tera": [
        "model IrisNet(num_classes: int):",
        "  acc = Accuracy(task=\"multiclass\", num_classes=num_classes)",
      ].join("\n"),
    }, ["main.tera"]);
    const edit = rename(project, "main.tera", 1, "  acc = Accuracy(task=\"multiclass\", num_classes=num_classes".length, "classes");

    expect(edit?.changes?.[project.uri("main.tera")]?.map((entry) => entry.range.start)).toEqual([
      { line: 0, character: "model IrisNet(".length },
      { line: 1, character: "  acc = Accuracy(task=\"multiclass\", num_classes=".length },
    ]);
  });
});
