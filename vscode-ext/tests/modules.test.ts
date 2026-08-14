import { afterEach, describe, expect, it } from "vitest";
import { collect } from "../src/server/providers/diagnostics.ts";
import { GEOMETRY, cleanupProjects, projectFor, type ModuleProject } from "./provider-harness.ts";

afterEach(cleanupProjects);

function messagesFor(project: ModuleProject, relative: string): string[] {
  const batches = collect(project.context.analyzer, project.context.modules);
  return (batches.get(project.uri(relative)) ?? []).map((diagnostic) => diagnostic.message);
}

describe("module diagnostics", () => {
  it("reports no errors for a working package graph", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    expect(messagesFor(project, "main.tera")).toEqual([]);
    expect(messagesFor(project, "shapes/area.tera")).toEqual([]);
  });

  it("publishes a dependency's error on the dependency, not on the entry", () => {
    const project = projectFor({
      ...GEOMETRY,
      "shapes/area.tera": [
        "from ..mathx import square",
        "",
        "fn square_area(side: int) -> int:",
        "  return square(side)",
        "",
        "fn rect_area(width: int, height: int) -> int:",
        "  return width * height",
        "",
        "fn border_area(outer: int, inner: int) -> int:",
        "  return square(\"outer\") - square(inner)",
      ].join("\n"),
    }, ["main.tera"]);

    expect(messagesFor(project, "main.tera")).toEqual([]);
    expect(messagesFor(project, "shapes/area.tera")).toEqual([
      "Type 'string' is not assignable to parameter 'n: int'",
    ]);
  });

  it("reports an unknown export on the importing file", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": "from mathx import abs_int, abs_float\nprint(abs_int(1), abs_float(1))\n",
    }, ["main.tera"]);

    expect(messagesFor(project, "main.tera")).toEqual([
      "Module 'mathx' has no export 'abs_float'",
    ]);
  });

  it("reports importing a module-private name", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": "from mathx import _negate\nprint(_negate(1))\n",
    }, ["main.tera"]);

    expect(messagesFor(project, "main.tera")).toEqual([
      "'_negate' is private to module 'mathx'",
    ]);
  });

  it("analyses the unsaved buffer rather than the file on disk", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    expect(messagesFor(project, "main.tera")).toEqual([]);

    project.open("shapes/area.tera");
    project.context.analyzer.update(
      project.uri("shapes/area.tera"),
      "from ..mathx import square\nfn square_area(side: int) -> int:\n  return square(side)\n",
    );
    project.context.modules.update(
      project.uri("shapes/area.tera"),
      "from ..mathx import square\nfn square_area(side: int) -> int:\n  return square(side)\n",
    );

    expect(messagesFor(project, "main.tera")).toEqual([
      "Module 'shapes.area' has no export 'border_area'",
    ]);
  });

  it("clears a dependency's diagnostics once the import is removed", () => {
    const project = projectFor({
      ...GEOMETRY,
      "mathx.tera": "fn abs_int(n: int) -> int:\n  return n\nbad: int = \"x\"\n",
      "main.tera": "from mathx import abs_int\nprint(abs_int(1))\n",
      "shapes/__init__.tera": "from .area import square_area\n",
      "shapes/area.tera": "fn square_area(side: int) -> int:\n  return side * side\n",
    }, ["main.tera"]);

    const before = collect(project.context.analyzer, project.context.modules);
    expect(before.has(project.uri("mathx.tera"))).toBe(true);

    project.open("main.tera", "print(1)\n");
    const after = collect(project.context.analyzer, project.context.modules);
    expect(after.has(project.uri("mathx.tera"))).toBe(false);
    expect(after.get(project.uri("main.tera"))).toEqual([]);
  });

  it("reports an import that resolves to no module", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": ["from nowhere import thing", "print(thing(1))"].join("\n"),
    }, ["main.tera"]);

    expect(messagesFor(project, "main.tera")).toEqual(["Cannot resolve module 'nowhere'"]);
  });

  it("reports an unresolvable relative import with its leading dots", () => {
    const project = projectFor({
      ...GEOMETRY,
      "shapes/area.tera": ["from ..missing import thing", "print(thing(1))"].join("\n"),
    }, ["shapes/area.tera"]);

    expect(messagesFor(project, "shapes/area.tera")).toEqual(["Cannot resolve module '..missing'"]);
  });

  it("does not claim an unresolvable module while the statement is still being typed", () => {
    const project = projectFor(GEOMETRY, []);
    project.open("main.tera", "from mat\n");

    expect(messagesFor(project, "main.tera")).not.toContain("Cannot resolve module 'mat'");
  });

  it("hides the undefined-name noise a broken import would otherwise cause", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": ["from nowhere import thing, other", "print(thing(1), other(2))"].join("\n"),
    }, ["main.tera"]);

    expect(messagesFor(project, "main.tera")).toEqual(["Cannot resolve module 'nowhere'"]);
  });

  it("keeps single-file diagnostics when the graph cannot be built", () => {
    const project = projectFor({ "broken.tera": "fn broken(\n" }, ["broken.tera"]);
    const messages = messagesFor(project, "broken.tera");
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe("module analysis caching", () => {
  it("reuses the analysis while nothing in the graph changes", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const first = project.context.modules.analyze(project.uri("main.tera"));
    const second = project.context.modules.analyze(project.uri("main.tera"));
    expect(second).toBe(first);
  });

  it("keeps an analysis alive when an unrelated document is edited", () => {
    const project = projectFor({ ...GEOMETRY, "other.tera": "x = 1\n" }, ["main.tera", "other.tera"]);
    const first = project.context.modules.analyze(project.uri("main.tera"));
    project.open("other.tera", "x = 2\n");
    expect(project.context.modules.analyze(project.uri("main.tera"))).toBe(first);
  });

  it("rebuilds when a module inside the graph is edited", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const first = project.context.modules.analyze(project.uri("main.tera"));
    project.open("shapes/area.tera", "fn square_area(side: int) -> int:\n  return side\n");
    expect(project.context.modules.analyze(project.uri("main.tera"))).not.toBe(first);
  });
});
