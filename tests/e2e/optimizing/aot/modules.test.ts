import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-aot-mod-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function compile(files: Record<string, string>): AotProgram {
  const root = project(files);
  return nodeEngine().compileAotModule(path.join(root, "main.tera"), { root });
}

function dispatched(files: Record<string, string>): AotProgram {
  const root = project(files);
  return nodeEngine().compileAotModule(path.join(root, "main.tera"), {
    root,
    compilerOptions: compilerOptions("speed", { inlineBudget: 0 }),
  });
}

const MATHLIB = [
  "fn square(n: int) -> int:",
  "  if n < 0:",
  "    return 0",
  "  return n * n",
  "",
].join("\n");

const MAIN = [
  "from mathlib import square",
  "fn total(n: int) -> int:",
  "  return square(n) + 1",
  "total(7)",
  "",
].join("\n");

describe("whole-program AOT across modules", () => {
  it("emits the imported function under a module-qualified symbol", () => {
    expect(cSource(compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB }))).toContain(
      "int32_t mathlib_square(int32_t",
    );
  });

  it("keeps the entry module's functions unqualified", () => {
    expect(cSource(compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB }))).toContain(
      "int32_t total(int32_t",
    );
  });

  it("resolves the cross-module call to the qualified symbol", () => {
    const source = cSource(
      dispatched({ "main.tera": MAIN, "mathlib.tera": MATHLIB }),
    );
    expect(source).toMatch(/int32_t total\(int32_t[\s\S]*mathlib_square\(/);
  });

  it("does not drop the caller as an unresolved reference", () => {
    const program = compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB });
    expect(program.compiled.map((fn) => fn.name)).toContain("total");
    expect(program.skipped.map((fn) => fn.name)).not.toContain("total");
  });

  it("gives two modules with the same function name distinct symbols", () => {
    const source = cSource(
      compile({
        "main.tera": [
          "from a import helper as ah",
          "from b import helper as bh",
          "fn total(n: int) -> int:",
          "  return ah(n) + bh(n)",
          "total(2)",
          "",
        ].join("\n"),
        "a.tera": "fn helper(n: int) -> int:\n  return n + 1\n",
        "b.tera": "fn helper(n: int) -> int:\n  return n + 2\n",
      }),
    );
    expect(source).toContain("int32_t a_helper(int32_t");
    expect(source).toContain("int32_t b_helper(int32_t");
  });

  it("resolves a chain of cross-module calls", () => {
    const program = compile({
      "main.tera": "from a import outer\nfn go() -> int:\n  return outer(3)\ngo()\n",
      "a.tera": "from b import inner\nfn outer(n: int) -> int:\n  return inner(n) * 2\n",
      "b.tera": "fn inner(n: int) -> int:\n  return n + 1\n",
    });
    expect(program.skipped.map((fn) => fn.name)).not.toContain("outer");
    expect(cSource(program)).toContain("int32_t b_inner(int32_t");
  });

  it("produces a deterministic C source across builds", () => {
    const files = { "main.tera": MAIN, "mathlib.tera": MATHLIB };
    const root = project(files);
    const first = nodeEngine().compileAotModule(path.join(root, "main.tera"), { root });
    const second = nodeEngine().compileAotModule(path.join(root, "main.tera"), { root });
    expect(cSource(second)).toBe(cSource(first));
  });
});

describe("running compiled multi-module code", () => {
  itNative("computes the same result as the interpreter", () => {
    const program = compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB });
    expect(runCFunction(cSource(program), "total", [7])).toBe(50);
  });

  itNative("runs a three-module call chain", () => {
    const program = compile({
      "main.tera": "from a import outer\nfn go() -> int:\n  return outer(3)\ngo()\n",
      "a.tera": "from b import inner\nfn outer(n: int) -> int:\n  return inner(n) * 2\n",
      "b.tera": "fn inner(n: int) -> int:\n  return n + 1\n",
    });
    expect(runCFunction(cSource(program), "go", [])).toBe(8);
  });

  itNative("keeps same-named functions from two modules apart at runtime", () => {
    const program = compile({
      "main.tera": [
        "from a import helper as ah",
        "from b import helper as bh",
        "fn total(n: int) -> int:",
        "  return ah(n) * 100 + bh(n)",
        "total(2)",
        "",
      ].join("\n"),
      "a.tera": "fn helper(n: int) -> int:\n  return n + 1\n",
      "b.tera": "fn helper(n: int) -> int:\n  return n + 2\n",
    });
    expect(runCFunction(cSource(program), "total", [2])).toBe(304);
  });
});

describe("linkage", () => {
  const PRIVATE_HELPER = {
    "main.tera": [
      "from lib import scaled",
      "fn go(n: int) -> int:",
      "  return scaled(n)",
      "go(4)",
      "",
    ].join("\n"),
    "lib.tera": [
      "fn _double(n: int) -> int:",
      "  return n * 2",
      "fn scaled(n: int) -> int:",
      "  return _double(n) + 1",
      "",
    ].join("\n"),
  };

  it("gives a module-private function internal linkage", () => {
    expect(cSource(compile(PRIVATE_HELPER))).toContain("static int32_t lib__double(int32_t");
  });

  it("keeps a public function externally linked", () => {
    const source = cSource(compile(PRIVATE_HELPER));
    expect(source).toContain("int32_t lib_scaled(int32_t");
    expect(source).not.toContain("static int32_t lib_scaled(int32_t");
  });

  it("keeps internal prototypes out of the header", () => {
    const program = compile(PRIVATE_HELPER);
    const header = program.files.find((file) => file.name.endsWith(".h"));
    expect(String(header!.contents)).not.toContain("lib__double");
    expect(String(header!.contents)).toContain("lib_scaled");
  });

  itNative("still runs the private helper correctly", () => {
    expect(runCFunction(cSource(compile(PRIVATE_HELPER)), "go", [4])).toBe(9);
  });
});

describe("module init table", () => {
  const NUMERIC_MODULE = {
    "main.tera": [
      "from consts import base",
      "fn go() -> int:",
      "  return base + 1",
      "go()",
      "",
    ].join("\n"),
    "consts.tera": "base = 41\n",
  };

  function headerOf(files: readonly { name: string; contents: string | Uint8Array }[]): string {
    return String(files.find((file) => file.name.endsWith(".h"))!.contents);
  }

  it("lists only init functions that actually lowered", () => {
    const program = compile(NUMERIC_MODULE);
    for (const symbol of program.moduleInits ?? []) {
      expect(program.compiled.map((fn) => fn.emitted.symbol)).toContain(symbol);
    }
  });

  it("omits the table when no module init survives", () => {
    const program = compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB });
    expect(program.moduleInits).toEqual([]);
    expect(headerOf(program.files)).not.toContain("tera_module_inits");
  });

  it("never lists the entry module", () => {
    const program = compile(NUMERIC_MODULE);
    expect(program.moduleInits ?? []).not.toContain("tera_program");
  });
});

describe("whole-program internalization", () => {
  function compileWhole(files: Record<string, string>, entry?: string): AotProgram {
    const root = project(files);
    return nodeEngine().compileAotModule(path.join(root, "main.tera"), {
      root,
      wholeProgram: true,
      ...(entry === undefined ? {} : { entry }),
    });
  }

  it("hides every symbol but the entry", () => {
    const source = cSource(compileWhole({ "main.tera": MAIN, "mathlib.tera": MATHLIB }));
    expect(source).toContain("static int32_t mathlib_square(int32_t");
    expect(source).toContain("static int32_t total(int32_t");
  });

  it("keeps a named entry exported so the C stub can call it", () => {
    const program = compileWhole({ "main.tera": MAIN, "mathlib.tera": MATHLIB }, "total");
    const header = String(program.files.find((file) => file.name.endsWith(".h"))!.contents);
    expect(header).toContain("int32_t total(int32_t");
    expect(header).not.toContain("mathlib_square");
  });

  it("leaves public symbols exported when not building whole-program", () => {
    const source = cSource(compile({ "main.tera": MAIN, "mathlib.tera": MATHLIB }));
    expect(source).not.toContain("static int32_t mathlib_square(int32_t");
  });

  itNative("still runs after internalization", () => {
    const program = compileWhole({ "main.tera": MAIN, "mathlib.tera": MATHLIB }, "total");
    expect(runCFunction(cSource(program), "total", [7])).toBe(50);
  });
});

const NEWLINE = String.fromCharCode(10);

describe("a name a program declares twice", () => {
  function binaryOf(source: string): Uint8Array {
    const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}${NEWLINE}`, {
      backend: "x64-windows",
      format: "executable",
    });
    expect(program.skipped).toEqual([]);
    return program.files[0]!.contents as Uint8Array;
  }

  itRunsPe("calls the declaration that shadows the earlier one", () => {
    const run = runPe(
      binaryOf(
        [
          "fn speak() -> string:",
          '  return "cow"',
          "print(speak())",
          "fn speak() -> string:",
          '  return "elk"',
          "print(speak())",
        ].join(NEWLINE),
      ),
    );

    expect([run.status, run.stdout]).toEqual([0, `elk${NEWLINE}elk${NEWLINE}`]);
  });

  itRunsPe("walks the generator that shadows the earlier one", () => {
    const run = runPe(
      binaryOf(
        [
          "fn* spoken():",
          '  yield "cow"',
          "for w of spoken():",
          "  print(w)",
          "fn* spoken():",
          '  yield "elk"',
          "for w of spoken():",
          "  print(w)",
        ].join(NEWLINE),
      ),
    );

    expect([run.status, run.stdout]).toEqual([0, `elk${NEWLINE}elk${NEWLINE}`]);
  });
});

describe("modules that do work when they load", () => {
  const SIDE = ['print("module loaded")', "fn helper(n: int) -> int:", "  return n + 1", ""].join(
    "\n",
  );
  const USES_SIDE = ["from side import helper", "print(helper(4))", ""].join("\n");

  function binary(files: Record<string, string>): Uint8Array {
    const root = project(files);
    const program = nodeEngine({ typecheck: "off" }).compileAotModule(
      path.join(root, "main.tera"),
      { root, backend: "x64-windows", format: "executable" },
    );
    expect(program.moduleInits).toEqual([]);
    return program.files[0]!.contents as Uint8Array;
  }

  itRunsPe("runs an imported module's top level before the program", () => {
    const run = runPe(binary({ "main.tera": USES_SIDE, "side.tera": SIDE }));

    expect([run.status, run.stdout]).toEqual([0, "module loaded\n5\n"]);
  });

  it("declines the program when a module's top level cannot be emitted", () => {
    expect(() =>
      binary({
        "main.tera": USES_SIDE,
        "side.tera": ["try:", '  throw "x"', "catch e:", "  print(e)", ...SIDE.split("\n")].join(
          "\n",
        ),
      }),
    ).toThrow(/cannot emit/);
  });
});

describe("classes across modules", () => {
  const ITEM = [
    "class Item:",
    "  public constructor(name: string, price: int):",
    "    this.name = name",
    "    this.price = price",
    "  public label() -> string:",
    '    return this.name + ": " + this.price',
    "fn make(n: int) -> Item:",
    '  return Item("gen", n)',
    "",
  ].join("\n");

  const SHAPES = [
    "class Shape:",
    "  public constructor(n: int):",
    "    this.n = n",
    "  public area() -> int:",
    "    return this.n",
    "class Circle extends Shape:",
    "  public constructor(r: int):",
    "    super(r)",
    "  public area() -> int:",
    "    return this.n * 2",
    "",
  ].join("\n");

  function runs(main: string, files: Record<string, string> = { "item.tera": ITEM }): string {
    const root = project({ "main.tera": main, ...files });
    const program = nodeEngine({ typecheck: "off" }).compileAotModule(
      path.join(root, "main.tera"),
      { root, wholeProgram: true, backend: "x64-windows", format: "executable" },
    );
    expect(program.skipped).toEqual([]);
    const run = runPe(program.files[0]!.contents as Uint8Array);
    expect(run.status).toBe(0);
    return run.stdout;
  }

  function builds(main: string, files: Record<string, string> = { "item.tera": ITEM }): void {
    const root = project({ "main.tera": main, ...files });
    const program = nodeEngine({ typecheck: "off" }).compileAotModule(
      path.join(root, "main.tera"),
      { root, wholeProgram: true, backend: "c", format: "assembly" },
    );
    expect(program.skipped).toEqual([]);
  }

  const READS_A_FIELD = ["from item import Item", 'print(Item("pen", 3).price)', ""].join("\n");
  const CALLS_A_METHOD = ["from item import Item", 'print(Item("pen", 3).label())', ""].join("\n");
  const DECLARES_THE_TYPE = [
    "from item import Item",
    "fn cost(i: Item) -> int:",
    "  return i.price",
    'print(cost(Item("pen", 3)))',
    "",
  ].join("\n");
  const WALKS_AN_ARRAY = [
    "from item import Item, make",
    'xs: Item[] = [Item("pen", 3), make(7)]',
    "total = 0",
    "for x of xs:",
    "  total = total + x.price",
    "print(total)",
    "",
  ].join("\n");
  const DISPATCHES = [
    "from shapes import Shape, Circle",
    "s: Shape = Circle(3)",
    "print(s.area())",
    "",
  ].join("\n");
  const KEYS_A_MAP = [
    "from item import Item",
    "m = Map()",
    'm.set("pen", Item("pen", 3))',
    'print(m.get("pen").label())',
    "",
  ].join("\n");

  it("compiles a program that constructs an imported class", () => {
    expect(() => builds(READS_A_FIELD)).not.toThrow();
  });

  itRunsPe("reads a field off an instance of an imported class", () => {
    expect(runs(READS_A_FIELD)).toBe("3\n");
  });

  itRunsPe("calls a method on an instance of an imported class", () => {
    expect(runs(CALLS_A_METHOD)).toBe("pen: 3\n");
  });

  itRunsPe("takes an imported class as a declared parameter type", () => {
    expect(runs(DECLARES_THE_TYPE)).toBe("3\n");
  });

  itRunsPe("walks an array of instances an imported factory made", () => {
    expect(runs(WALKS_AN_ARRAY)).toBe("10\n");
  });

  itRunsPe("dispatches to an override declared in another module", () => {
    expect(runs(DISPATCHES, { "shapes.tera": SHAPES })).toBe("6\n");
  });

  itRunsPe("holds an instance of an imported class as a map value", () => {
    expect(runs(KEYS_A_MAP)).toBe("pen: 3\n");
  });

  itRunsPe("calls a static method on an imported class", () => {
    expect(
      runs(["from counter import Counter", "print(Counter.bump(1))", ""].join("\n"), {
        "counter.tera": [
          "class Counter:",
          "  public static total: int = 0",
          "  public static bump(n: int) -> int:",
          "    return n + 1",
          "",
        ].join("\n"),
      }),
    ).toBe("2\n");
  });

  itRunsPe("extends a class declared in another module", () => {
    expect(
      runs(["from circle import Circle", "print(Circle(3).area())", ""].join("\n"), {
        "base.tera": [
          "class Shape:",
          "  public constructor(n: int):",
          "    this.n = n",
          "  public area() -> int:",
          "    return this.n",
          "",
        ].join("\n"),
        "circle.tera": [
          "from base import Shape",
          "class Circle extends Shape:",
          "  public constructor(r: int):",
          "    super(r)",
          "  public area() -> int:",
          "    return this.n * 2",
          "",
        ].join("\n"),
      }),
    ).toBe("6\n");
  });

  itRunsPe("catches an error subclass declared in another module", () => {
    expect(
      runs(
        [
          "from failures import HttpError",
          "try:",
          '  throw HttpError("nope", 404)',
          "catch e:",
          "  print(e.message, e.status)",
          "",
        ].join("\n"),
        {
          "failures.tera": [
            "class HttpError extends Error:",
            "  public status: int",
            "  public constructor(msg: string, status: int):",
            "    super(msg)",
            "    this.status = status",
            "",
          ].join("\n"),
        },
      ),
    ).toBe("nope 404\n");
  });

  itRunsPe("implements an interface declared in another module", () => {
    expect(
      runs(
        ["from disc import Disc", "from shaped import Shaped", "d: Shaped = Disc(3)", "print(d.area())", ""].join("\n"),
        {
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
        },
      ),
    ).toBe("3\n");
  });

  itRunsPe("holds an imported class in a field of a class declared elsewhere", () => {
    expect(
      runs(
        ["from item import Item", "from box import Box", "print(Box(Item(\"pen\", 4)).held.price)", ""].join("\n"),
        {
          "item.tera": ITEM,
          "box.tera": [
            "from item import Item",
            "class Box:",
            "  public constructor(held: Item):",
            "    this.held = held",
            "",
          ].join("\n"),
        },
      ),
    ).toBe("4\n");
  });

  itRunsPe("constructs an imported class through a namespace import", () => {
    expect(
      runs(["import item", 'p = item.Item("pen", 3)', "print(p.price)", ""].join("\n")),
    ).toBe("3\n");
  });

  it("refuses two modules that declare the same class name", () => {
    expect(() =>
      builds(
        ["from left import Point", "print(Point(1).x)", "", "from right import Point as Spot", ""].join("\n"),
        {
          "left.tera": ["class Point:", "  public constructor(x: int):", "    this.x = x", ""].join("\n"),
          "right.tera": ["class Point:", "  public constructor(y: int):", "    this.y = y", ""].join("\n"),
        },
      ),
    ).toThrow(/class Point is declared in left and right/);
  });
});

describe("a variable an imported module declares with a type", () => {
  function ranProject(files: Record<string, string>): { status: number; stdout: string } {
    const root = project(files);
    const program = nodeEngine({ typecheck: "off" }).compileAotModule(
      path.join(root, "main.tera"),
      { root, backend: "x64-windows", format: "executable", wholeProgram: true },
    );
    expect(program.skipped).toEqual([]);
    const run = runPe(program.files[0]!.contents as Uint8Array);
    return { status: run.status, stdout: run.stdout };
  }

  const lines = (...parts: string[]) => `${parts.join(NEWLINE)}${NEWLINE}`;

  itRunsPe("reads one the module only ever reads", () => {
    expect(
      ranProject({
        "conf.tera": lines("limit: int = 7", "fn limitOf() -> int:", "  return limit"),
        "main.tera": lines("from conf import limitOf", "print(limitOf())"),
      }),
    ).toEqual({ status: 0, stdout: `7${NEWLINE}` });
  });

  itRunsPe("keeps one the module mutates across calls", () => {
    expect(
      ranProject({
        "tally.tera": lines(
          "seen: int = 0",
          "fn note() -> int:",
          "  seen = seen + 1",
          "  return seen",
        ),
        "main.tera": lines("from tally import note", "print(note())", "print(note())"),
      }),
    ).toEqual({ status: 0, stdout: `1${NEWLINE}2${NEWLINE}` });
  });

  itRunsPe("keeps two modules that chose the same name apart", () => {
    expect(
      ranProject({
        "left.tera": lines("limit: int = 1", "fn leftLimit() -> int:", "  return limit"),
        "right.tera": lines("limit: int = 2", "fn rightLimit() -> int:", "  return limit"),
        "main.tera": lines(
          "from left import leftLimit",
          "from right import rightLimit",
          "print(leftLimit())",
          "print(rightLimit())",
        ),
      }),
    ).toEqual({ status: 0, stdout: `1${NEWLINE}2${NEWLINE}` });
  });

  itRunsPe("reaches one two imports deep", () => {
    expect(
      ranProject({
        "base.tera": lines("factor: int = 3", "fn scale(n: int) -> int:", "  return n * factor"),
        "mid.tera": lines(
          "from base import scale",
          "fn quad(n: int) -> int:",
          "  return scale(scale(n))",
        ),
        "main.tera": lines("from mid import quad", "print(quad(2))"),
      }),
    ).toEqual({ status: 0, stdout: `18${NEWLINE}` });
  });
});
