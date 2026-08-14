import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENTRY_SPEC,
  ModuleResolutionError,
  ModuleResolver,
  projectRootFor,
} from "../../../src/frontend/modules/resolver.js";
import { buildModuleGraph } from "../../../src/frontend/modules/graph.js";
import { nodeModuleFileSystem } from "../../../src/frontend/modules/node-file-system.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-resolver-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function resolverFor(root: string, searchPaths: string[] = [], natives: string[] = []) {
  return new ModuleResolver({
    fileSystem: nodeModuleFileSystem,
    root,
    searchPaths,
    nativeModules: natives,
  });
}

describe("project root", () => {
  it("walks up to the directory holding tera.json", () => {
    const root = project({ "tera.json": "{}\n", "app/main.tera": "x = 1\n" });
    expect(projectRootFor(nodeModuleFileSystem, path.join(root, "app", "main.tera"))).toBe(root);
  });

  it("falls back to the entry directory when no manifest exists", () => {
    const root = project({ "app/main.tera": "x = 1\n" });
    expect(projectRootFor(nodeModuleFileSystem, path.join(root, "app", "main.tera"))).toBe(path.join(root, "app"));
  });
});

describe("resolution order", () => {
  it("resolves a registered native module", () => {
    const root = project({ "main.tera": "x = 1\n" });
    const resolver = resolverFor(root, [], ["chart"]);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    expect(resolver.resolve({ level: 0, path: ["chart"] }, entry).kind).toBe("native");
  });

  it("refuses a file that shadows a native module", () => {
    const root = project({ "main.tera": "x = 1\n", "chart.tera": "y = 1\n" });
    const resolver = resolverFor(root, [], ["chart"]);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    expect(() => resolver.resolve({ level: 0, path: ["chart"] }, entry)).toThrow(
      /Cannot shadow native module 'chart'/,
    );
  });

  it("prefers the project root over a search path", () => {
    const root = project({ "main.tera": "x = 1\n", "shared.tera": "a = 1\n" });
    const extra = project({ "shared.tera": "a = 2\n" });
    const resolver = resolverFor(root, [extra]);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    const resolved = resolver.resolve({ level: 0, path: ["shared"] }, entry);
    expect(resolved.path).toBe(path.join(root, "shared.tera"));
  });

  it("falls through to a search path when the root has no match", () => {
    const root = project({ "main.tera": "x = 1\n" });
    const extra = project({ "lib/util.tera": "a = 1\n" });
    const resolver = resolverFor(root, [extra]);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    const resolved = resolver.resolve({ level: 0, path: ["lib", "util"] }, entry);
    expect(resolved.spec).toBe("lib.util");
    expect(resolved.path).toBe(path.join(extra, "lib", "util.tera"));
  });

  it("prefers a module file over a package directory of the same name", () => {
    const root = project({
      "main.tera": "x = 1\n",
      "thing.tera": "a = 1\n",
      "thing/__init__.tera": "b = 1\n",
    });
    const resolver = resolverFor(root);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    expect(resolver.resolve({ level: 0, path: ["thing"] }, entry).kind).toBe("file");
  });

  it("rejects an unknown module", () => {
    const root = project({ "main.tera": "x = 1\n" });
    const resolver = resolverFor(root);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    expect(() => resolver.resolve({ level: 0, path: ["nope"] }, entry)).toThrow(
      ModuleResolutionError,
    );
  });

  it("rejects a relative import from a native module", () => {
    const root = project({ "main.tera": "x = 1\n" });
    const resolver = resolverFor(root, [], ["chart"]);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    const native = resolver.resolve({ level: 0, path: ["chart"] }, entry);
    expect(() => resolver.resolve({ level: 1, path: ["x"] }, native)).toThrow(
      /relative import from native module/,
    );
  });
});

describe("module identity", () => {
  it("gives the entry file the __main__ spec", () => {
    const root = project({ "main.tera": "x = 1\n" });
    const resolver = resolverFor(root);
    expect(resolver.resolveEntry(path.join(root, "main.tera")).spec).toBe(ENTRY_SPEC);
  });

  it("loads the entry file once even when another module imports it by name", () => {
    const root = project({
      "main.tera": "from other import y\nx = 1\n",
      "other.tera": "from main import x\ny = 1\n",
    });
    const graph = buildModuleGraph(path.join(root, "main.tera"), { fileSystem: nodeModuleFileSystem, root });
    expect([...graph.modules.keys()].sort()).toEqual([ENTRY_SPEC, "other"]);
  });

  it("resolves a path with mixed separators to one record", () => {
    const root = project({ "main.tera": "from pkg.leaf import v\n", "pkg/leaf.tera": "v = 1\n" });
    const graph = buildModuleGraph(path.join(root, "main.tera").replace(/\\/g, "/"), { fileSystem: nodeModuleFileSystem, root });
    expect(graph.modules.has("pkg.leaf")).toBe(true);
  });
});

describe("relative imports name modules after the importing package", () => {
  const nested = () =>
    project({
      "main.tera": "from http import fetch\n",
      "vendor/http/__init__.tera": "from .client import request\n\nfetch = request\n",
      "vendor/http/client.tera": "request = 1\n",
      "vendor/mathx.tera": "square = 1\n",
    });

  const nestedResolver = (root: string) => resolverFor(root, [path.join(root, "vendor")]);

  it("follows the package the importer was reached as", () => {
    const root = nested();
    const resolver = nestedResolver(root);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    const owner = resolver.resolve({ level: 0, path: ["http"] }, entry);

    expect(owner.spec).toBe("http");
    expect(resolver.resolve({ level: 1, path: ["client"] }, owner).spec).toBe("http.client");
  });

  it("keeps the outer name when the importer was reached through the outer base", () => {
    const root = nested();
    const resolver = nestedResolver(root);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    const owner = resolver.resolve({ level: 0, path: ["vendor", "http"] }, entry);

    expect(owner.spec).toBe("vendor.http");
    expect(resolver.resolve({ level: 1, path: ["client"] }, owner).spec).toBe("vendor.http.client");
  });

  it("climbs out of the package for a parent import", () => {
    const root = nested();
    const resolver = nestedResolver(root);
    const entry = resolver.resolveEntry(path.join(root, "main.tera"));
    const owner = resolver.resolve({ level: 0, path: ["http"] }, entry);
    const inner = resolver.resolve({ level: 1, path: ["client"] }, owner);

    expect(resolver.resolve({ level: 2, path: ["mathx"] }, inner).spec).toBe("mathx");
  });

  it("names a file by the innermost base that holds it", () => {
    const root = nested();
    const resolver = nestedResolver(root);

    expect(resolver.specOf(path.join(root, "main.tera"))).toBe("main");
    expect(resolver.specOf(path.join(root, "vendor", "http", "client.tera"))).toBe("http.client");
    expect(resolver.specOf(path.join(root, "..", "outside.tera"))).toBeNull();
  });

  it("gives a package and its relative submodule one namespace in the graph", () => {
    const root = nested();
    const graph = buildModuleGraph(path.join(root, "main.tera"), {
      fileSystem: nodeModuleFileSystem,
      root,
      searchPaths: [path.join(root, "vendor")],
    });

    expect([...graph.modules.keys()].sort()).toEqual([ENTRY_SPEC, "http", "http.client"]);
  });
});
