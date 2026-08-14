import { afterEach, describe, expect, it } from "vitest";
import { computeCodeActions } from "../src/server/providers/code-action.ts";
import { GEOMETRY, cleanupProjects, projectFor, type ModuleProject } from "./provider-harness.ts";

afterEach(cleanupProjects);

function quickFixes(project: ModuleProject, relative: string, name: string, line: number) {
  const range = { start: { line, character: 0 }, end: { line, character: 0 } };
  return computeCodeActions(project.context, {
    textDocument: { uri: project.uri(relative) },
    range,
    context: { diagnostics: [{ range, message: `undefined name '${name}'` }] },
  });
}

describe("add missing import", () => {
  it("offers an import for a name exported by a workspace module", () => {
    const project = projectFor({ ...GEOMETRY, "main.tera": "print(max_int(1, 2))\n" }, ["main.tera"]);
    const actions = quickFixes(project, "main.tera", "max_int", 0);

    expect(actions.map((action) => action.title)).toEqual(["Add 'from mathx import max_int'"]);
    expect(actions[0]?.edit?.changes?.[project.uri("main.tera")]).toEqual([{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: "from mathx import max_int\n",
    }]);
  });

  it("inserts below the existing imports", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": "import shapes\nprint(max_int(1, 2))\n",
    }, ["main.tera"]);
    const actions = quickFixes(project, "main.tera", "max_int", 1);

    expect(actions[0]?.edit?.changes?.[project.uri("main.tera")]?.[0]?.range.start).toEqual({
      line: 1,
      character: 0,
    });
  });

  it("merges into an existing import from the same module", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": "from mathx import abs_int\nprint(max_int(1, 2))\n",
    }, ["main.tera"]);
    const actions = quickFixes(project, "main.tera", "max_int", 1);

    expect(actions[0]?.edit?.changes?.[project.uri("main.tera")]).toEqual([{
      range: {
        start: { line: 0, character: "from mathx import abs_int".length },
        end: { line: 0, character: "from mathx import abs_int".length },
      },
      newText: ", max_int",
    }]);
  });

  it("never offers a module-private name", () => {
    const project = projectFor({ ...GEOMETRY, "main.tera": "print(_negate(1))\n" }, ["main.tera"]);
    expect(quickFixes(project, "main.tera", "_negate", 0)).toEqual([]);
  });

  it("offers nothing for a name no module exports", () => {
    const project = projectFor({ ...GEOMETRY, "main.tera": "print(nowhere(1))\n" }, ["main.tera"]);
    expect(quickFixes(project, "main.tera", "nowhere", 0)).toEqual([]);
  });
});
