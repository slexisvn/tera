import { afterEach, describe, expect, it } from "vitest";
import { computeHighlights } from "../src/server/providers/document-highlight.ts";
import { computeReferences } from "../src/server/providers/references.ts";
import { computeRename } from "../src/server/providers/rename.ts";
import { GEOMETRY, cleanupProjects, projectFor, type ModuleProject } from "./provider-harness.ts";

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
});
