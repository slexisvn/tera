import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { positionAt } from "tera/frontend";
import { computeDefinition } from "../src/server/providers/definition.ts";
import { computeHover } from "../src/server/providers/hover.ts";
import { canonicalPath } from "../src/server/analyzer/paths.ts";
import { cleanupProjects, projectFor, type ModuleProject } from "./provider-harness.ts";

const ENTRY = "src/main.tera";
const GUARD_TYPES = "tera_packages/slexisvn/guard/types.tera";
const GUARD_SOURCE = [
  "from slexisvn.guard import guard",
  "user_schema = guard.object({",
  "  name: guard.string().min(2),",
  "  email: guard.string().email(),",
  "  age: guard.number().int().min(18),",
  "  tags: guard.array(guard.string().min(1)).max(5),",
  "}).strict()",
  "",
].join("\n");

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

const INSTALLED_GUARD = {
  "tera.json": JSON.stringify({ modules: "src", dependencies: { "slexisvn.guard": "*" } }),
  "tera_packages/slexisvn/guard/__init__.tera": [
    "from .object import make_object as _make_object",
    "from .string import make_string as _make_string",
    "from .types import ArrayGuard, GuardApi, GuardShape, NumberGuard, ObjectGuard, StringGuard",
    "guard: GuardApi = { object: _make_object, string: _make_string }",
    "",
  ].join("\n"),
  "tera_packages/slexisvn/guard/object.tera": [
    "from .types import GuardShape, ObjectGuard",
    "class ObjectSchema implements ObjectGuard:",
    "  public strict() -> ObjectGuard:",
    "    return this",
    "fn make_object(shape: GuardShape) -> ObjectGuard:",
    "  return ObjectSchema()",
    "",
  ].join("\n"),
  "tera_packages/slexisvn/guard/string.tera": [
    "from .types import StringGuard",
    "class StringSchema implements StringGuard:",
    "  public min(size: int) -> StringGuard:",
    "    return this",
    "fn make_string() -> StringGuard:",
    "  return StringSchema()",
    "",
  ].join("\n"),
  [GUARD_TYPES]: [
    "type GuardShape = { [key: string]: unknown }",
    "interface StringGuard:",
    "  min: (size: int) -> StringGuard",
    "  email: () -> StringGuard",
    "interface NumberGuard:",
    "  int: () -> NumberGuard",
    "  min: (size: float) -> NumberGuard",
    "interface ArrayGuard:",
    "  max: (size: int) -> ArrayGuard",
    "interface ObjectGuard:",
    "  strict: () -> ObjectGuard",
    "interface GuardApi:",
    "  object: (shape: GuardShape) -> ObjectGuard",
    "  string: () -> StringGuard",
    "  number: () -> NumberGuard",
    "  array: (item: unknown) -> ArrayGuard",
    "",
  ].join("\n"),
  "tera_packages/.peta/state.json": JSON.stringify({
    stateVersion: 1,
    packages: {
      "slexisvn.guard": { version: "0.1.1", source: "petahub", files: 4 },
    },
  }),
};

afterEach(() => cleanupProjects());

function entryPathOf(project: ModuleProject): string {
  return canonicalPath(join(project.root, ENTRY));
}

function after(source: string, text: string) {
  const offset = source.indexOf(text);
  if (offset < 0) throw new Error(`Missing source text: ${text}`);
  return positionAt(source, offset + text.length);
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

  it("hovers members reached through an imported package value", () => {
    const project = projectFor({ "src/main.tera": GUARD_SOURCE, ...INSTALLED_GUARD }, ["src/main.tera"]);
    const hoverAt = (text: string): string => {
      const hover = computeHover(project.context, {
        textDocument: { uri: project.uri("src/main.tera") },
        position: after(GUARD_SOURCE, text),
      });
      const contents = hover?.contents;
      return typeof contents === "string" ? contents : String(contents?.value ?? "");
    };

    const object = hoverAt("user_schema = guard.object");
    const min = hoverAt("name: guard.string().min");
    const strict = hoverAt("}).strict");

    expect(object).toContain("GuardApi.object");
    expect(object).toContain("(shape: GuardShape) -> ObjectGuard");
    expect(min).toContain("StringGuard.min");
    expect(min).toContain("(size: int) -> StringGuard");
    expect(strict).toContain("ObjectGuard.strict");
    expect(strict).toContain("() -> ObjectGuard");
  });

  it("jumps to members reached through an imported package value", () => {
    const project = projectFor({ "src/main.tera": GUARD_SOURCE, ...INSTALLED_GUARD }, ["src/main.tera"]);
    const definitionAt = (text: string) => computeDefinition(project.context, {
      textDocument: { uri: project.uri("src/main.tera") },
      position: after(GUARD_SOURCE, text),
    });
    const object = definitionAt("user_schema = guard.object");
    const min = definitionAt("name: guard.string().min");
    const strict = definitionAt("}).strict");
    const types = INSTALLED_GUARD[GUARD_TYPES];

    expect(object?.uri).toBe(project.uri(GUARD_TYPES));
    expect(object?.range.start).toEqual(positionAt(types, types.indexOf("object:")));
    expect(min?.uri).toBe(project.uri(GUARD_TYPES));
    expect(min?.range.start).toEqual(positionAt(types, types.indexOf("min:")));
    expect(strict?.uri).toBe(project.uri(GUARD_TYPES));
    expect(strict?.range.start).toEqual(positionAt(types, types.indexOf("strict:")));
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
