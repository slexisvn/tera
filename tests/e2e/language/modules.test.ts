import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-run-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function run(files: Record<string, string>, entry = "main.tera"): string[] {
  const root = project(files);
  const output: string[] = [];
  const engine = nodeEngine({ output: (text) => output.push(text) });
  engine.runModule(path.join(root, entry), { root });
  return output;
}

function runValue(files: Record<string, string>, entry = "main.tera"): unknown {
  const root = project(files);
  return nodeEngine().runModuleNative(path.join(root, entry), { root });
}

describe("running a module graph", () => {
  it("runs a single-module program", () => {
    expect(run({ "main.tera": 'print("hello")\n' })).toEqual(["hello"]);
  });

  it("calls a function imported from a sibling module", () => {
    expect(run({
      "main.tera": "from helper import twice\nprint(twice(21))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual(["42"]);
  });

  it("reads a value imported from a sibling module", () => {
    expect(run({
      "main.tera": "from config import limit\nprint(limit)\n",
      "config.tera": "limit = 10\n",
    })).toEqual(["10"]);
  });

  it("honours an import alias", () => {
    expect(run({
      "main.tera": "from helper import twice as double\nprint(double(4))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual(["8"]);
  });

  it("runs each module body exactly once", () => {
    expect(run({
      "main.tera": "from a import x\nfrom b import y\nprint(x + y)\n",
      "a.tera": 'from shared import bump\nx = bump()\n',
      "b.tera": 'from shared import bump\ny = bump()\n',
      "shared.tera": "count = 0\nprint(\"loading shared\")\nfn bump() -> int:\n  return 1\n",
    })).toEqual(["loading shared", "2"]);
  });

  it("initialises dependencies before dependents", () => {
    expect(run({
      "main.tera": 'from a import ready\nprint("main")\n',
      "a.tera": 'from b import base\nprint("a")\nready = base + 1\n',
      "b.tera": 'print("b")\nbase = 1\n',
    })).toEqual(["b", "a", "main"]);
  });

  it("keeps module-level names in separate namespaces", () => {
    expect(run({
      "main.tera": "from a import a_value\nfrom b import b_value\nvalue = 1\nprint(value, a_value, b_value)\n",
      "a.tera": "value = 2\na_value = value\n",
      "b.tera": "value = 3\nb_value = value\n",
    })).toEqual(["1 2 3"]);
  });

  it("lets a module keep private state that the importer cannot see", () => {
    expect(run({
      "main.tera": "from counter import next_id\nprint(next_id(), next_id(), next_id())\n",
      "counter.tera": "_current = 0\nfn next_id() -> int:\n  _current = _current + 1\n  return _current\n",
    })).toEqual(["1 2 3"]);
  });
});

describe("namespace imports", () => {
  it("reaches a function through the module name", () => {
    expect(run({
      "main.tera": "import helper\nprint(helper.twice(5))\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toEqual(["10"]);
  });

  it("reaches a value through an aliased module name", () => {
    expect(run({
      "main.tera": "import config as c\nprint(c.limit)\n",
      "config.tera": "limit = 7\n",
    })).toEqual(["7"]);
  });

  it("reaches a nested module through its dotted path", () => {
    expect(run({
      "main.tera": "import pkg.util.text\nprint(pkg.util.text.shout(\"hi\"))\n",
      "pkg/util/text.tera": 'fn shout(s: string) -> string:\n  return s + "!"\n',
    })).toEqual(["hi!"]);
  });

  it("reaches a member of a value exported by a module", () => {
    expect(run({
      "main.tera": "import data\nprint(data.record.name)\n",
      "data.tera": 'record = { name: "tera" }\n',
    })).toEqual(["tera"]);
  });

  it("exposes the module itself as a value", () => {
    expect(run({
      "main.tera": "import config\nprint(config.limit)\nns = config\nprint(ns.limit)\n",
      "config.tera": "limit = 3\n",
    })).toEqual(["3", "3"]);
  });

  it("does not fold a member access when a local shadows the module name", () => {
    expect(run({
      "main.tera": [
        "import config",
        "fn read(config):",
        "  return config.limit",
        'print(read({ limit: 99 }))',
        "",
      ].join("\n"),
      "config.tera": "limit = 3\n",
    })).toEqual(["99"]);
  });
});

describe("packages", () => {
  it("runs a package __init__ before its submodule", () => {
    expect(run({
      "main.tera": "from pkg.leaf import value\nprint(value)\n",
      "pkg/__init__.tera": 'print("init")\n',
      "pkg/leaf.tera": 'print("leaf")\nvalue = 1\n',
    })).toEqual(["init", "leaf", "1"]);
  });

  it("re-exports a name through a package __init__", () => {
    expect(run({
      "main.tera": "from pkg import shout\nprint(shout(\"hi\"))\n",
      "pkg/__init__.tera": "from .text import shout\n",
      "pkg/text.tera": 'fn shout(s: string) -> string:\n  return s + "!"\n',
    })).toEqual(["hi!"]);
  });

  it("imports a submodule by name from its package", () => {
    expect(run({
      "main.tera": "from pkg import text\nprint(text.shout(\"hi\"))\n",
      "pkg/__init__.tera": "marker = 1\n",
      "pkg/text.tera": 'fn shout(s: string) -> string:\n  return s + "!"\n',
    })).toEqual(["hi!"]);
  });

  it("resolves a relative import inside a package", () => {
    expect(run({
      "main.tera": "from pkg.one import total\nprint(total)\n",
      "pkg/one.tera": "from .two import base\ntotal = base + 1\n",
      "pkg/two.tera": "base = 41\n",
    })).toEqual(["42"]);
  });

  it("resolves a parent-relative import", () => {
    expect(run({
      "main.tera": "from pkg.nested.leaf import value\nprint(value)\n",
      "pkg/shared.tera": "base = 5\n",
      "pkg/nested/leaf.tera": "from ..shared import base\nvalue = base * 2\n",
    })).toEqual(["10"]);
  });
});

describe("a search path nested inside the project root", () => {
  const VENDOR = {
    "vendor/http/__init__.tera": "from .client import request\n\nfn fetch() -> string:\n  return request()\n",
    "vendor/http/client.tera": 'fn request() -> string:\n  return "ok"\n',
  };

  function runNested(files: Record<string, string>): { output: string[]; specs: string[] } {
    const root = project(files);
    const output: string[] = [];
    const engine = nodeEngine({ output: (text) => output.push(text) });
    const graph = engine.loadModuleGraph(path.join(root, "main.tera"), {
      root,
      searchPaths: [path.join(root, "vendor")],
    });
    engine.runModuleGraphNative(graph);
    return { output, specs: [...graph.modules.keys()].sort() };
  }

  it("names a package's own submodule after the package, not after the outer root", () => {
    const nested = runNested({
      ...VENDOR,
      "main.tera": "from http import fetch\nprint(fetch())\n",
    });

    expect(nested.output).toEqual(["ok"]);
    expect(nested.specs).toEqual(["__main__", "http", "http.client"]);
  });

  it("still runs the same package addressed through the outer directory", () => {
    const nested = runNested({
      ...VENDOR,
      "main.tera": "import vendor.http\nprint(vendor.http.fetch())\n",
    });

    expect(nested.output).toEqual(["ok"]);
    expect(nested.specs).toEqual(["__main__", "vendor", "vendor.http", "vendor.http.client"]);
  });
});

describe("import cycles", () => {
  it("supports mutually recursive functions across a cycle", () => {
    expect(run({
      "main.tera": "from even import is_even\nprint(is_even(4))\n",
      "even.tera": [
        "from odd import is_odd",
        "fn is_even(n: int) -> bool:",
        "  if n == 0:",
        "    return true",
        "  return is_odd(n - 1)",
        "",
      ].join("\n"),
      "odd.tera": [
        "from even import is_even",
        "fn is_odd(n: int) -> bool:",
        "  if n == 0:",
        "    return false",
        "  return is_even(n - 1)",
        "",
      ].join("\n"),
    })).toEqual(["true"]);
  });

  it("reports a cycle read of a value that is not initialised yet", () => {
    const root = project({
      "main.tera": "from a import x\nprint(x)\n",
      "a.tera": "from b import y\nx = y\n",
      "b.tera": "from a import x\ny = x + 1\n",
    });
    expect(() => nodeEngine().runModule(path.join(root, "main.tera"), { root })).toThrow(
      /cannot access 'y' from module 'a' before module 'b' finished initializing/,
    );
  });
});

describe("module values", () => {
  it("returns the entry module result", () => {
    expect(runValue({
      "main.tera": "from helper import twice\ntwice(21)\n",
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    })).toBe(42);
  });

  it("shares one class definition across modules", () => {
    expect(run({
      "main.tera": [
        "from shapes import Circle",
        "from areas import describe",
        "print(describe(Circle(2.0)))",
        "",
      ].join("\n"),
      "shapes.tera": [
        "class Circle:",
        "  public constructor(r: float):",
        "    this.r = r",
        "  public area() -> float:",
        "    return 3.0 * this.r * this.r",
        "",
      ].join("\n"),
      "areas.tera": [
        "from shapes import Circle",
        "fn describe(c: Circle) -> string:",
        "  return `area ${c.area()}`",
        "",
      ].join("\n"),
    })).toEqual(["area 12"]);
  });

  it("implements an interface imported from another module", () => {
    expect(run({
      "main.tera": [
        "from disc import Disc",
        "from shaped import Shaped",
        "d: Shaped = Disc(3)",
        "print(d.area())",
        "",
      ].join("\n"),
      "shaped.tera": ["interface Shaped:", "  area() -> int", ""].join("\n"),
      "disc.tera": [
        "from shaped import Shaped",
        "class Disc implements Shaped:",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public area() -> int:",
        "    return this.n",
        "",
      ].join("\n"),
    })).toEqual(["3"]);
  });

  it("implements an imported interface under a local alias", () => {
    expect(run({
      "main.tera": ["from disc import Disc", "print(Disc(4).area())", ""].join("\n"),
      "shaped.tera": ["interface Shaped:", "  area() -> int", ""].join("\n"),
      "disc.tera": [
        "from shaped import Shaped as Figure",
        "class Disc implements Figure:",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public area() -> int:",
        "    return this.n",
        "",
      ].join("\n"),
    })).toEqual(["4"]);
  });

  it("sees a later write made by the exporting module", () => {
    expect(run({
      "main.tera": "from state import current, bump\nbump()\nprint(current)\n",
      "state.tera": "current = 1\nfn bump():\n  current = 2\n",
    })).toEqual(["1"]);
  });
});

describe("module diagnostics", () => {
  it("rejects an unknown export", () => {
    const root = project({
      "main.tera": "from helper import nope\n",
      "helper.tera": "value = 1\n",
    });
    expect(() =>
      nodeEngine({ typecheck: "strict" }).runModule(path.join(root, "main.tera"), { root }),
    ).toThrow(/has no export 'nope'/);
  });

  it("rejects an import of a private name", () => {
    const root = project({
      "main.tera": "from helper import _hidden\n",
      "helper.tera": "_hidden = 1\n",
    });
    expect(() =>
      nodeEngine({ typecheck: "strict" }).runModule(path.join(root, "main.tera"), { root }),
    ).toThrow(/is private to module 'helper'/);
  });
});
