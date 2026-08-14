import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import type { TeraExtension } from "../../../src/api/extensions.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-native-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function mathModule(): TeraExtension {
  return {
    name: "test/mathx",
    modules: [
      {
        name: "mathx",
        hostExports: {
          double: (value: unknown) => Number(value) * 2,
          label: () => "mathx",
        },
        interface: {
          builtins: [
            { name: "double", params: [{ name: "value", type: "int" }], returns: "int" },
            { name: "label", params: [], returns: "string" },
          ],
        },
      },
    ],
  };
}

function run(files: Record<string, string>, typecheck: "off" | "warn" | "strict" = "warn"): string[] {
  const root = project(files);
  const output: string[] = [];
  const engine = nodeEngine({
    output: (text) => output.push(text),
    extensions: [mathModule()],
    typecheck,
  });
  engine.runModule(path.join(root, "main.tera"), { root });
  return output;
}

describe("native modules", () => {
  it("calls a native export imported by name", () => {
    expect(run({ "main.tera": "from mathx import double\nprint(double(21))\n" })).toEqual(["42"]);
  });

  it("calls a native export through a namespace import", () => {
    expect(run({ "main.tera": "import mathx\nprint(mathx.double(4))\n" })).toEqual(["8"]);
  });

  it("honours an alias on a native import", () => {
    expect(run({ "main.tera": "from mathx import double as twice\nprint(twice(3))\n" })).toEqual(["6"]);
  });

  it("reaches a native module from inside a file module", () => {
    expect(run({
      "main.tera": "from helper import scaled\nprint(scaled(5))\n",
      "helper.tera": "from mathx import double\nfn scaled(n: int) -> int:\n  return double(n) + 1\n",
    })).toEqual(["11"]);
  });

  it("keeps native cells out of the entry namespace", () => {
    const root = project({ "main.tera": "print(1)\n" });
    const engine = nodeEngine({ extensions: [mathModule()] });
    engine.runModule(path.join(root, "main.tera"), { root });
    expect(engine.interpreter.globalCells.get("native:mathx#double")).toBeDefined();
    expect(engine.interpreter.globalCells.get("double")).toBeUndefined();
  });

  it("rejects an unknown native export", () => {
    expect(() => run({ "main.tera": "from mathx import triple\n" }, "strict")).toThrow(
      /Module 'mathx' has no export 'triple'/,
    );
  });

  it("refuses to let a file shadow a native module", () => {
    expect(() =>
      run({ "main.tera": "from mathx import double\n", "mathx.tera": "double = 1\n" }),
    ).toThrow(/Cannot shadow native module 'mathx'/);
  });

  it("type-checks a call against the native signature", () => {
    expect(() => run({ "main.tera": 'from mathx import double\nprint(double("x"))\n' }, "strict")).toThrow(
      /not assignable to parameter/,
    );
  });
});
