import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installedPackagesIn,
  searchPathsForEntry,
  searchPathsIn,
  searchPathsUnder,
} from "../../src/frontend/packages.js";
import { ModuleResolver } from "../../src/frontend/modules/resolver.js";
import { nodeModuleFileSystem as files } from "../../src/frontend/modules/node-file-system.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(contents: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-packages-"));
  roots.push(root);
  for (const [name, text] of Object.entries(contents)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  }
  return root;
}

function state(packages: Record<string, unknown>, stateVersion = 1): string {
  return `${JSON.stringify({ stateVersion, packages }, null, 2)}\n`;
}

const HTTP = "fn fetch() -> string:\n  return \"installed\"\n";

function resolvedSource(
  root: string,
  entry: string,
  searchPaths: readonly string[],
  request: readonly string[],
): string {
  const resolver = new ModuleResolver({ fileSystem: files, root, searchPaths });
  const from = resolver.resolveEntry(entry);
  const module = resolver.resolve({ level: 0, path: [...request] }, from);
  return fs.readFileSync(module.path!, "utf8");
}

describe("package search path", () => {
  it("appends the packages directory of the project holding the entry", () => {
    const root = project({
      "tera.json": "{}\n",
      "src/main.tera": "x = 1\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });

    expect(searchPathsForEntry(files, path.join(root, "src", "main.tera"), [])).toEqual([
      path.join(root, "tera_packages"),
    ]);
  });

  it("appends nothing when the project has no packages directory", () => {
    const root = project({ "tera.json": "{}\n", "src/main.tera": "x = 1\n" });

    expect(searchPathsForEntry(files, path.join(root, "src", "main.tera"), [])).toEqual([]);
  });

  it("appends nothing when there is no project manifest above the entry", () => {
    const root = project({
      "src/main.tera": "x = 1\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });

    expect(searchPathsForEntry(files, path.join(root, "src", "main.tera"), [])).toEqual([]);
  });

  it("keeps every module path ahead of the packages directory", () => {
    const root = project({
      "tera.json": "{}\n",
      "src/main.tera": "x = 1\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });

    expect(searchPathsForEntry(files, path.join(root, "src", "main.tera"), ["one", "two"])).toEqual([
      "one",
      "two",
      path.join(root, "tera_packages"),
    ]);
  });

  it("walks up to the project root from a nested working directory", () => {
    const root = project({
      "tera.json": "{}\n",
      "src/deep/keep.tera": "x = 1\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });

    expect(searchPathsIn(files, path.join(root, "src", "deep"), [])).toEqual([
      path.join(root, "tera_packages"),
    ]);
  });

  it("uses a known root as given instead of walking for a manifest", () => {
    const root = project({
      "tera.json": "{}\n",
      "src/deep/keep.tera": "x = 1\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });

    expect(searchPathsUnder(files, root)).toEqual([path.join(root, "tera_packages")]);
    expect(searchPathsUnder(files, path.join(root, "src", "deep"))).toEqual([]);
  });
});

describe("resolution order", () => {
  it("resolves a project module ahead of an installed package of the same name", () => {
    const root = project({
      "tera.json": "{}\n",
      "src/main.tera": "x = 1\n",
      "slexis/http/__init__.tera": "fn fetch() -> string:\n  return \"project\"\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });
    const entry = path.join(root, "src", "main.tera");

    expect(resolvedSource(root, entry, searchPathsForEntry(files, entry, []), ["slexis", "http"]))
      .toContain("project");
  });

  it("resolves a module path ahead of an installed package of the same name", () => {
    const root = project({
      "tera.json": "{}\n",
      "src/main.tera": "x = 1\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });
    const override = project({
      "slexis/http/__init__.tera": "fn fetch() -> string:\n  return \"override\"\n",
    });
    const entry = path.join(root, "src", "main.tera");

    expect(
      resolvedSource(root, entry, searchPathsForEntry(files, entry, [override]), ["slexis", "http"]),
    ).toContain("override");
  });

  it("resolves an installed package when nothing shadows it", () => {
    const root = project({
      "tera.json": "{}\n",
      "src/main.tera": "x = 1\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });
    const entry = path.join(root, "src", "main.tera");

    expect(resolvedSource(root, entry, searchPathsForEntry(files, entry, []), ["slexis", "http"]))
      .toContain("installed");
  });
});

describe("installed packages", () => {
  it("reads the installed set peta recorded", () => {
    const root = project({
      "tera.json": "{}\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
      "tera_packages/.peta/state.json": state({
        "slexis.json": { version: "0.4.1", source: "path:../json", files: 1 },
        "slexis.http": { version: "1.2.0", source: "petahub", files: 2 },
      }),
    });

    expect(installedPackagesIn(files, root)).toEqual({
      directory: path.join(root, "tera_packages"),
      packages: [
        { name: "slexis.http", version: "1.2.0", source: "petahub", files: 2 },
        { name: "slexis.json", version: "0.4.1", source: "path:../json", files: 1 },
      ],
    });
  });

  it("reports no tree at all when the project has no packages directory", () => {
    expect(installedPackagesIn(files, project({ "tera.json": "{}\n" }))).toBeNull();
  });

  it("reports an empty tree when peta has recorded nothing", () => {
    const root = project({
      "tera.json": "{}\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
    });

    expect(installedPackagesIn(files, root)?.packages).toEqual([]);
  });

  it("ignores a state file written by a different state version", () => {
    const root = project({
      "tera.json": "{}\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
      "tera_packages/.peta/state.json": state(
        { "slexis.http": { version: "1.2.0", source: "petahub", files: 2 } },
        2,
      ),
    });

    expect(installedPackagesIn(files, root)?.packages).toEqual([]);
  });

  it("ignores an entry that does not describe an install", () => {
    const root = project({
      "tera.json": "{}\n",
      "tera_packages/slexis/http/__init__.tera": HTTP,
      "tera_packages/.peta/state.json": state({
        "slexis.http": { version: "1.2.0", source: "petahub", files: 2 },
        "slexis.broken": { version: "1.0.0" },
      }),
    });

    expect(installedPackagesIn(files, root)?.packages).toEqual([
      { name: "slexis.http", version: "1.2.0", source: "petahub", files: 2 },
    ]);
  });
});
