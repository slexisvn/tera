import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeDefinition } from "../src/server/providers/definition.ts";
import { canonicalPath } from "../src/server/analyzer/paths.ts";
import { cleanupProjects, projectFor, type ModuleProject } from "./provider-harness.ts";

const ENTRY = "src/main.tera";

const APPLICATION = {
  "tera.json": '{\n  "name": "app",\n  "version": "0.1.0",\n  "modules": "src"\n}\n',
  [ENTRY]: 'from slexis.http import fetch\n\nprint(fetch("/status"))\n',
};

const INSTALLED = {
  "tera_packages/slexis/http/__init__.tera": [
    "from slexis.json import encode",
    "",
    "fn fetch(path: string) -> string:",
    '  return encode("GET " + path)',
    "",
  ].join("\n"),
  "tera_packages/slexis/json/__init__.tera": [
    "fn encode(body: string) -> string:",
    '  return "{body: " + body + "}"',
    "",
  ].join("\n"),
  "tera_packages/.peta/state.json": JSON.stringify(
    {
      stateVersion: 1,
      packages: {
        "slexis.http": { version: "1.0.0", source: "petahub", files: 1 },
        "slexis.json": { version: "0.4.1", source: "petahub", files: 1 },
      },
    },
    null,
    2,
  ),
};

afterEach(() => cleanupProjects());

function entryPathOf(project: ModuleProject): string {
  return canonicalPath(join(project.root, ENTRY));
}

function importErrors(project: ModuleProject): string[] {
  const source = project.context.modules.sourceAt(entryPathOf(project));
  return project.context.modules
    .unresolvedImports(entryPathOf(project), source.split("\n"))
    .map((error) => error.message);
}

describe("installed packages in the editor", () => {
  it("resolves an import that peta installed", () => {
    const project = projectFor({ ...APPLICATION, ...INSTALLED }, [ENTRY]);

    expect(importErrors(project)).toEqual([]);
  });

  it("still reports an import no package provides", () => {
    const project = projectFor(APPLICATION, [ENTRY]);

    expect(importErrors(project)).toEqual(["Cannot resolve module 'slexis.http'"]);
  });

  it("checks the entry against the package and its transitive dependency", () => {
    const project = projectFor({ ...APPLICATION, ...INSTALLED }, [ENTRY]);
    const analysis = project.context.modules.analyze(project.uri(ENTRY));

    expect(analysis).not.toBeNull();
    expect([...analysis!.graph.modules.keys()]).toEqual(
      expect.arrayContaining(["slexis.http", "slexis.json"]),
    );
    expect([...analysis!.diagnostics.values()].flat()).toEqual([]);
  });

  it("reports a name the installed package does not export", () => {
    const project = projectFor(
      { ...APPLICATION, ...INSTALLED, [ENTRY]: "from slexis.http import missing\n" },
      [ENTRY],
    );
    const analysis = project.context.modules.analyze(project.uri(ENTRY));

    expect([...analysis!.diagnostics.values()].flat().map((error) => error.message)).toEqual([
      "Module 'slexis.http' has no export 'missing'",
    ]);
  });

  it("jumps from an imported name into the package that defines it", () => {
    const project = projectFor({ ...APPLICATION, ...INSTALLED }, [ENTRY]);
    const location = computeDefinition(project.context, {
      textDocument: { uri: project.uri(ENTRY) },
      position: { line: 0, character: "from slexis.http import fetch".length },
    });

    expect(location?.uri).toBe(project.uri("tera_packages/slexis/http/__init__.tera"));
  });

  it("offers an installed scope while completing a module path", () => {
    const project = projectFor({ ...APPLICATION, ...INSTALLED }, [ENTRY]);
    const candidates = project.context.modules.listModules(entryPathOf(project), 0, []);

    expect(candidates.map((candidate) => candidate.name)).toContain("slexis");
  });

  it("keeps installed sources out of the workspace module index", () => {
    const project = projectFor({ ...APPLICATION, ...INSTALLED }, [ENTRY]);

    expect(project.context.modules.moduleFiles(entryPathOf(project))).toEqual([
      entryPathOf(project),
    ]);
  });
});
