import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleGraph, ModuleGraphError } from "../../../src/frontend/modules/graph.js";
import { ENTRY_SPEC } from "../../../src/frontend/modules/resolver.js";
import { nodeModuleFileSystem } from "../../../src/frontend/modules/node-file-system.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-modules-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function graphOf(files: Record<string, string>, entry = "main.tera", nativeModules: string[] = []) {
  const root = project(files);
  return buildModuleGraph(path.join(root, entry), {
    fileSystem: nodeModuleFileSystem,
    root,
    nativeModules,
  });
}

function order(files: Record<string, string>, entry = "main.tera"): string[] {
  return graphOf(files, entry).initOrder.map((record) => record.spec);
}

describe("module graph loading", () => {
  it("loads a single entry module", () => {
    const graph = graphOf({ "main.tera": "x = 1\n" });
    expect(graph.entry.spec).toBe(ENTRY_SPEC);
    expect([...graph.modules.keys()]).toEqual([ENTRY_SPEC]);
    expect(graph.initOrder.map((record) => record.spec)).toEqual([ENTRY_SPEC]);
  });

  it("loads an imported sibling module", () => {
    const graph = graphOf({
      "main.tera": "from helper import twice\nprint(twice(2))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    });
    expect([...graph.modules.keys()].sort()).toEqual([ENTRY_SPEC, "helper"]);
    expect(graph.initOrder.map((record) => record.spec)).toEqual(["helper", ENTRY_SPEC]);
  });

  it("initialises dependencies before dependents", () => {
    expect(
      order({
        "main.tera": "from a import x\n",
        "a.tera": "from b import y\nx = y + 1\n",
        "b.tera": "y = 1\n",
      }),
    ).toEqual(["b", "a", ENTRY_SPEC]);
  });

  it("loads a package through its __init__", () => {
    const graph = graphOf({
      "main.tera": "from pkg import shared\n",
      "pkg/__init__.tera": "shared = 1\n",
    });
    expect(graph.modules.get("pkg")?.kind).toBe("package");
    expect(graph.initOrder.map((record) => record.spec)).toEqual(["pkg", ENTRY_SPEC]);
  });

  it("reaches a submodule through a namespace package", () => {
    const graph = graphOf({
      "main.tera": "from pkg.deep import value\n",
      "pkg/deep.tera": "value = 7\n",
    });
    expect(graph.modules.get("pkg")?.kind).toBe("namespace");
    expect(graph.initOrder.map((record) => record.spec)).toEqual(["pkg.deep", ENTRY_SPEC]);
  });

  it("binds a submodule named in a from-import", () => {
    const graph = graphOf({
      "main.tera": "from pkg import deep\n",
      "pkg/__init__.tera": "marker = 1\n",
      "pkg/deep.tera": "value = 7\n",
    });
    const [entryImport] = graph.entry.imports;
    expect(entryImport!.bindings[0]!.submodule).toBe("pkg.deep");
    expect(graph.initOrder.map((record) => record.spec)).toEqual(["pkg", "pkg.deep", ENTRY_SPEC]);
  });

  it("initialises a package before any of its submodules", () => {
    const graph = graphOf({
      "main.tera": "from pkg.deep import value\n",
      "pkg/__init__.tera": "marker = 1\n",
      "pkg/deep.tera": "value = 7\n",
    });
    expect(graph.initOrder.map((record) => record.spec)).toEqual(["pkg", "pkg.deep", ENTRY_SPEC]);
  });

  it("prefers an exported name over a same-named submodule", () => {
    const graph = graphOf({
      "main.tera": "from pkg import deep\n",
      "pkg/__init__.tera": "deep = 1\n",
      "pkg/deep.tera": "value = 7\n",
    });
    expect(graph.entry.imports[0]!.bindings[0]!.submodule).toBeNull();
    expect(graph.modules.has("pkg.deep")).toBe(false);
  });

  it("resolves relative imports from inside a package", () => {
    const graph = graphOf({
      "main.tera": "from pkg.one import a\n",
      "pkg/one.tera": "from .two import b\na = b + 1\n",
      "pkg/two.tera": "b = 1\n",
    });
    expect(graph.initOrder.map((record) => record.spec)).toEqual([
      "pkg.two",
      "pkg.one",
      ENTRY_SPEC,
    ]);
  });

  it("resolves a parent-relative import", () => {
    const graph = graphOf({
      "main.tera": "from pkg.nested.leaf import v\n",
      "pkg/shared.tera": "s = 1\n",
      "pkg/nested/leaf.tera": "from ..shared import s\nv = s\n",
    });
    expect(graph.modules.has("pkg.shared")).toBe(true);
    expect(graph.initOrder.map((record) => record.spec)).toEqual([
      "pkg.shared",
      "pkg.nested.leaf",
      ENTRY_SPEC,
    ]);
  });

  it("loads a file only once when two modules import it", () => {
    const graph = graphOf({
      "main.tera": "from a import x\nfrom b import y\n",
      "a.tera": "from shared import s\nx = s\n",
      "b.tera": "from shared import s\ny = s\n",
      "shared.tera": "s = 1\n",
    });
    expect(graph.initOrder.filter((record) => record.spec === "shared")).toHaveLength(1);
    expect(graph.initOrder.map((record) => record.spec)).toEqual([
      "shared",
      "a",
      "b",
      ENTRY_SPEC,
    ]);
  });

  it("resolves dotted namespace imports and binds the root package", () => {
    const graph = graphOf({
      "main.tera": "import pkg.util.text\n",
      "pkg/util/text.tera": "value = 1\n",
    });
    const [entryImport] = graph.entry.imports;
    expect(entryImport!.module).toBe("pkg.util.text");
    expect(entryImport!.local).toBe("pkg");
    expect(entryImport!.boundSpec).toBe("pkg");
  });

  it("binds the full module when an alias is given", () => {
    const graph = graphOf({
      "main.tera": "import pkg.util.text as text\n",
      "pkg/util/text.tera": "value = 1\n",
    });
    const [entryImport] = graph.entry.imports;
    expect(entryImport!.local).toBe("text");
    expect(entryImport!.boundSpec).toBe("pkg.util.text");
  });
});

describe("module graph cycles", () => {
  it("keeps a two-module cycle in one component", () => {
    const graph = graphOf({
      "main.tera": "from a import x\n",
      "a.tera": "from b import y\nx = 1\n",
      "b.tera": "from a import x\ny = 1\n",
    });
    expect(graph.cycles).toHaveLength(1);
    expect([...graph.cycles[0]!].sort()).toEqual(["a", "b"]);
    expect(graph.initOrder).toHaveLength(3);
  });

  it("reports a self import as a cycle", () => {
    const graph = graphOf({ "main.tera": "from main import x\nx = 1\n" });
    expect(graph.cycles.map((cycle) => [...cycle])).toEqual([[ENTRY_SPEC]]);
  });

  it("has no cycles for an acyclic graph", () => {
    const graph = graphOf({
      "main.tera": "from a import x\n",
      "a.tera": "x = 1\n",
    });
    expect(graph.cycles).toEqual([]);
  });
});

describe("module graph determinism", () => {
  it("produces the same init order across builds", () => {
    const files = {
      "main.tera": "from a import x\nfrom b import y\nfrom c import z\n",
      "a.tera": "from shared import s\nx = s\n",
      "b.tera": "from shared import s\ny = s\n",
      "c.tera": "from a import x\nz = x\n",
      "shared.tera": "s = 1\n",
    };
    const root = project(files);
    const first = buildModuleGraph(path.join(root, "main.tera"), {
      fileSystem: nodeModuleFileSystem,
      root,
    });
    const second = buildModuleGraph(path.join(root, "main.tera"), {
      fileSystem: nodeModuleFileSystem,
      root,
    });
    expect(second.initOrder.map((record) => record.spec)).toEqual(
      first.initOrder.map((record) => record.spec),
    );
    expect(first.initOrder.map((record) => record.spec)).toEqual([
      "shared",
      "a",
      "b",
      "c",
      ENTRY_SPEC,
    ]);
  });
});

describe("module graph errors", () => {
  it("reports an unresolved module with the import chain", () => {
    expect(() =>
      graphOf({
        "main.tera": "from a import x\n",
        "a.tera": "from missing import y\nx = y\n",
      }),
    ).toThrow(ModuleGraphError);
    expect(() =>
      graphOf({
        "main.tera": "from a import x\n",
        "a.tera": "from missing import y\nx = y\n",
      }),
    ).toThrow(/Cannot resolve module 'missing'.*imported by __main__ -> a/s);
  });

  it("reports a relative import that escapes the project root", () => {
    expect(() =>
      graphOf({ "main.tera": "from ..outside import x\n" }),
    ).toThrow(/Cannot resolve module '\.\.outside'|escapes the project root/);
  });
});

describe("module bindings", () => {
  it("marks underscore-prefixed names as not exported", () => {
    const graph = graphOf({
      "main.tera": "from helper import public_fn\n",
      "helper.tera": "_hidden = 1\nfn _secret():\n  return 1\nfn public_fn():\n  return 1\n",
    });
    const helper = graph.modules.get("helper")!;
    expect(helper.bindings.get("_hidden")?.exported).toBe(false);
    expect(helper.bindings.get("_secret")?.exported).toBe(false);
    expect(helper.bindings.get("public_fn")?.exported).toBe(true);
  });

  it("records top-level bare assignments as bindings", () => {
    const graph = graphOf({ "main.tera": "total = 1 + 2\n" });
    expect(graph.entry.bindings.get("total")?.kind).toBe("value");
  });

  it("records declarations of every top-level kind", () => {
    const graph = graphOf({
      "main.tera": [
        "fn f():",
        "  return 1",
        "class C:",
        "  public m():",
        "    return 1",
        "interface I:",
        "  a: int",
        "type T = int",
        "v = 1",
        "",
      ].join("\n"),
    });
    const kinds = new Map(
      [...graph.entry.bindings.values()].map((binding) => [binding.name, binding.kind]),
    );
    expect(kinds.get("f")).toBe("function");
    expect(kinds.get("C")).toBe("class");
    expect(kinds.get("I")).toBe("interface");
    expect(kinds.get("T")).toBe("type");
    expect(kinds.get("v")).toBe("value");
  });

  it("re-exports names brought in by an import", () => {
    const graph = graphOf({
      "main.tera": "from pkg import shared\n",
      "pkg/__init__.tera": "from .inner import shared\n",
      "pkg/inner.tera": "shared = 1\n",
    });
    expect(graph.modules.get("pkg")!.bindings.get("shared")?.exported).toBe(true);
  });
});

describe("native modules", () => {
  it("resolves a registered native module without touching the disk", () => {
    const graph = graphOf({ "main.tera": "from math2 import sin\n" }, "main.tera", ["math2"]);
    expect(graph.modules.get("native:math2")?.kind).toBe("native");
    expect(graph.initOrder.map((record) => record.spec)).toEqual([ENTRY_SPEC]);
  });

  it("refuses to let a file shadow a native module", () => {
    expect(() =>
      graphOf(
        { "main.tera": "from math2 import sin\n", "math2.tera": "sin = 1\n" },
        "main.tera",
        ["math2"],
      ),
    ).toThrow(/Cannot shadow native module 'math2'/);
  });
});

describe("check order", () => {
  it("checks a package after the submodules it imports", () => {
    const graph = graphOf({
      "main.tera": "from pkg import shared\n",
      "pkg/__init__.tera": "from .inner import shared\n",
      "pkg/inner.tera": "shared = 1\n",
    });
    expect(graph.checkOrder.map((record) => record.spec)).toEqual([
      "pkg.inner",
      "pkg",
      ENTRY_SPEC,
    ]);
  });

  it("still initialises the package before its submodule", () => {
    const graph = graphOf({
      "main.tera": "from pkg import shared\n",
      "pkg/__init__.tera": "from .inner import shared\n",
      "pkg/inner.tera": "shared = 1\n",
    });
    expect(graph.initOrder.map((record) => record.spec)).toEqual([
      "pkg",
      "pkg.inner",
      ENTRY_SPEC,
    ]);
  });
});
