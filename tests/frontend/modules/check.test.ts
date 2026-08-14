import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleGraph } from "../../../src/frontend/modules/graph.js";
import { checkModuleGraph, type ModuleDiagnostic } from "../../../src/frontend/modules/check.js";
import { nodeModuleFileSystem } from "../../../src/frontend/modules/node-file-system.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function check(files: Record<string, string>, entry = "main.tera"): ModuleDiagnostic[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-check-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  const graph = buildModuleGraph(path.join(root, entry), {
    fileSystem: nodeModuleFileSystem,
    root,
  });
  return [...checkModuleGraph(graph, { mode: "strict" }).diagnostics];
}

function messages(diagnostics: readonly ModuleDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.message);
}

describe("import diagnostics", () => {
  it("accepts an import of an exported name", () => {
    expect(check({
      "main.tera": "from helper import twice\nprint(twice(2))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual([]);
  });

  it("reports an unknown export", () => {
    const diagnostics = check({
      "main.tera": "from helper import missing\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    });
    expect(messages(diagnostics)).toEqual([
      "Module 'helper' has no export 'missing'",
    ]);
    expect(diagnostics[0]!.module).toBe("__main__");
  });

  it("suggests a near miss", () => {
    expect(messages(check({
      "main.tera": "from helper import twise\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    }))).toEqual(["Module 'helper' has no export 'twise'; did you mean 'twice'?"]);
  });

  it("reports an import of a private name", () => {
    expect(messages(check({
      "main.tera": "from helper import _secret\n",
      "helper.tera": "_secret = 1\n",
    }))).toEqual(["'_secret' is private to module 'helper'"]);
  });

  it("points the diagnostic at the specifier", () => {
    const [diagnostic] = check({
      "main.tera": "from helper import twice, missing\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    });
    expect(diagnostic!.line).toBe(1);
    expect(diagnostic!.column).toBe(27);
  });

  it("reports assignment to an imported binding", () => {
    expect(messages(check({
      "main.tera": "from helper import value\nvalue = 2\n",
      "helper.tera": "value = 1\n",
    }))).toEqual(["Cannot assign to imported binding 'value'"]);
  });

  it("reports assignment to an aliased module binding", () => {
    expect(messages(check({
      "main.tera": "import helper as h\nh = 2\n",
      "helper.tera": "value = 1\n",
    }))).toEqual(["Cannot assign to imported binding 'h'"]);
  });

  it("allows a submodule import that is not an exported name", () => {
    expect(check({
      "main.tera": "from pkg import leaf\n",
      "pkg/__init__.tera": "marker = 1\n",
      "pkg/leaf.tera": "value = 1\n",
    })).toEqual([]);
  });
});

describe("cross-module types", () => {
  it("checks a call against the imported signature", () => {
    expect(messages(check({
      "main.tera": "from helper import twice\nprint(twice(\"nope\"))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    }))).toEqual(["Type 'string' is not assignable to parameter 'n: int'"]);
  });

  it("accepts a call that matches the imported signature", () => {
    expect(check({
      "main.tera": "from helper import twice\nprint(twice(2))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual([]);
  });

  it("carries an imported type alias into the importing module", () => {
    expect(check({
      "main.tera": "from shapes import Size\nfn area(s: Size) -> int:\n  return s\n",
      "shapes.tera": "type Size = int\n",
    })).toEqual([]);
  });

  it("renames an aliased import in the importing module", () => {
    expect(check({
      "main.tera": "from helper import twice as double\nprint(double(2))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual([]);
  });

  it("does not leak a private name into the importing module", () => {
    const diagnostics = check({
      "main.tera": "from helper import shown\nprint(shown())\n",
      "helper.tera": "fn _hidden() -> int:\n  return 1\nfn shown() -> int:\n  return _hidden()\n",
    });
    expect(diagnostics).toEqual([]);
  });
});

describe("import cycles", () => {
  it("checks a cycle without hanging", () => {
    const diagnostics = check({
      "main.tera": "from a import x\nprint(x)\n",
      "a.tera": "from b import y\nx = 1\n",
      "b.tera": "from a import x\ny = 2\n",
    });
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("still reports an unknown export inside a cycle", () => {
    expect(messages(check({
      "main.tera": "from a import x\n",
      "a.tera": "from b import nope\nx = 1\n",
      "b.tera": "from a import x\ny = 2\n",
    }))).toContain("Module 'b' has no export 'nope'");
  });
});

describe("namespace import typing", () => {
  it("types a call made through a namespace import", () => {
    expect(messages(check({
      "main.tera": "import helper\nprint(helper.twice(\"nope\"))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    }))).toEqual(["Type 'string' is not assignable to parameter 'n: int'"]);
  });

  it("accepts a well-typed namespace call", () => {
    expect(check({
      "main.tera": "import helper\nfn use() -> int:\n  return helper.twice(2)\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual([]);
  });

  it("types a re-exported name reached through a package namespace", () => {
    expect(check({
      "main.tera": "import pkg\nfn use() -> int:\n  return pkg.twice(2)\n",
      "pkg/__init__.tera": "from .impl import twice\n",
      "pkg/impl.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual([]);
  });

  it("checks a package after the submodules it re-exports", () => {
    expect(messages(check({
      "main.tera": "import pkg\nfn use() -> int:\n  return pkg.twice(\"x\")\n",
      "pkg/__init__.tera": "from .impl import twice\n",
      "pkg/impl.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    }))).toEqual(["Type 'string' is not assignable to parameter 'n: int'"]);
  });
});
