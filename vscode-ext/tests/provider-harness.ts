import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LanguageData } from "../src/shared/language-data.ts";
import { DocumentAnalyzer } from "../src/server/analyzer/index.ts";
import { ModuleWorkspace } from "../src/server/analyzer/modules.ts";
import { canonicalPath } from "../src/server/analyzer/paths.ts";
import { EventBus, type AnalyzerEvents } from "../src/server/bus.ts";
import { TypeResolver } from "../src/server/language/type-resolver.ts";
import type { ProviderContext } from "../src/server/providers/types.ts";

export const languageData = JSON.parse(readFileSync(join(import.meta.dirname, "..", "language-data.json"), "utf8")) as LanguageData;

const projects: string[] = [];

export const GEOMETRY = {
  "main.tera": [
    "import shapes",
    "from mathx import abs_int, max_int",
    "from shapes.area import border_area as border",
    "",
    "fn floor_area() -> int:",
    "  return shapes.square_area(4) + border(6, 4)",
    "",
    "print(floor_area(), abs_int(0 - 2), max_int(1, 2))",
  ].join("\n"),
  "mathx.tera": [
    "fn _negate(n: int) -> int:",
    "  return 0 - n",
    "",
    "fn abs_int(n: int) -> int:",
    "  if n < 0:",
    "    return _negate(n)",
    "  return n",
    "",
    "fn square(n: int) -> int:",
    "  return n * n",
    "",
    "fn max_int(a: int, b: int) -> int:",
    "  if a < b:",
    "    return b",
    "  return a",
  ].join("\n"),
  "shapes/__init__.tera": "from .area import square_area, rect_area, border_area\n",
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
    "  return square(outer) - square(inner)",
  ].join("\n"),
};

export function contextFor(source: string): ProviderContext {
  const analyzer = new DocumentAnalyzer(languageData);
  analyzer.update("file:///test.tera", source);
  return {
    analyzer,
    modules: new ModuleWorkspace(),
    languageData,
    types: new TypeResolver(languageData),
    bus: new EventBus<AnalyzerEvents>(),
  };
}

export type ModuleProject = {
  root: string;
  context: ProviderContext;
  uri(relative: string): string;
  open(relative: string, source?: string): string;
  write(relative: string, source: string): void;
};

export function projectFor(files: Record<string, string>, opened: readonly string[] = []): ModuleProject {
  const root = mkdtempSync(join(tmpdir(), "tera-lsp-"));
  projects.push(root);
  for (const [name, source] of Object.entries(files)) writeFile(root, name, source);

  const analyzer = new DocumentAnalyzer(languageData);
  const modules = new ModuleWorkspace();
  const context: ProviderContext = {
    analyzer,
    modules,
    languageData,
    types: new TypeResolver(languageData),
    bus: new EventBus<AnalyzerEvents>(),
  };

  const uriOf = (relative: string): string =>
    pathToFileURL(canonicalPath(join(root, relative))).toString();

  const project: ModuleProject = {
    root,
    context,
    uri: uriOf,
    open(relative, source) {
      const text = source ?? files[relative] ?? "";
      if (source !== undefined) writeFile(root, relative, source);
      const uri = uriOf(relative);
      analyzer.update(uri, text);
      modules.update(uri, text);
      return uri;
    },
    write(relative, source) {
      writeFile(root, relative, source);
      modules.invalidate();
    },
  };
  for (const relative of opened) project.open(relative);
  return project;
}

export function cleanupProjects(): void {
  while (projects.length > 0) rmSync(projects.pop()!, { recursive: true, force: true });
}

function writeFile(root: string, relative: string, source: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}
