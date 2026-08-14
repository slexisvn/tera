import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { toDisplayString } from "../../../../src/core/value/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-repl-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

function session(files: Record<string, string>) {
  const root = project(files);
  const output: string[] = [];
  const engine = nodeEngine({ output: (text) => output.push(text) });
  const enter = (line: string): string =>
    toDisplayString(engine.run(line, { moduleRoot: root }));
  return { engine, output, enter };
}

describe("repl imports", () => {
  it("imports a name and calls it on the next line", () => {
    const { output, enter } = session({
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    });
    enter("from helper import twice");
    enter("print(twice(21))");
    expect(output).toEqual(["42"]);
  });

  it("keeps an imported binding across several lines", () => {
    const { output, enter } = session({
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    });
    enter("from helper import twice");
    enter("print(twice(1))");
    enter("print(twice(2))");
    expect(output).toEqual(["2", "4"]);
  });

  it("runs an imported module body only once", () => {
    const { output, enter } = session({
      "noisy.tera": 'print("loaded")\nvalue = 1\n',
    });
    enter("from noisy import value");
    enter("from noisy import value");
    enter("print(value)");
    expect(output).toEqual(["loaded", "1"]);
  });

  it("supports a namespace import in the repl", () => {
    const { output, enter } = session({ "config.tera": "limit = 5\n" });
    enter("import config");
    enter("print(config.limit)");
    expect(output).toEqual(["5"]);
  });

  it("leaves plain lines on the non-module path", () => {
    const { enter } = session({});
    expect(enter("1 + 1")).toBe("2");
  });

  it("keeps repl state alongside imported names", () => {
    const { output, enter } = session({
      "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n",
    });
    enter("from helper import twice");
    enter("base = 10");
    enter("print(twice(base))");
    expect(output).toEqual(["20"]);
  });
});

describe("repl module reload", () => {
  function projectAt(files: Record<string, string>) {
    const root = project(files);
    const output: string[] = [];
    const engine = nodeEngine({ output: (text) => output.push(text) });
    return {
      root,
      output,
      engine,
      enter: (line: string) => toDisplayString(engine.run(line, { moduleRoot: root })),
      edit: (name: string, contents: string) =>
        fs.writeFileSync(path.join(root, name), contents, "utf8"),
    };
  }

  it("lists the modules loaded so far", () => {
    const s = projectAt({ "helper.tera": "value = 1\n" });
    s.enter("from helper import value");
    expect(s.engine.loadedModules()).toEqual(["helper"]);
  });

  it("refuses to reload a module that was never imported", () => {
    const s = projectAt({ "helper.tera": "value = 1\n" });
    expect(s.engine.reloadModule("helper")).toBe(false);
  });

  it("picks up an edit to an imported module", () => {
    const s = projectAt({ "helper.tera": "fn twice(n: int) -> int:\n  return n * 2\n" });
    s.enter("from helper import twice");
    s.enter("print(twice(10))");
    s.edit("helper.tera", "fn twice(n: int) -> int:\n  return n * 3\n");
    expect(s.engine.reloadModule("helper")).toBe(true);
    s.enter("print(twice(10))");
    expect(s.output).toEqual(["20", "30"]);
  });

  it("re-runs the module body on reload", () => {
    const s = projectAt({ "noisy.tera": 'print("loaded")\nvalue = 1\n' });
    s.enter("from noisy import value");
    s.engine.reloadModule("noisy");
    expect(s.output).toEqual(["loaded", "loaded"]);
  });

  it("keeps the module runnable after a reload", () => {
    const s = projectAt({ "helper.tera": "value = 1\n" });
    s.enter("from helper import value");
    s.engine.reloadModule("helper");
    s.enter("print(value)");
    expect(s.output).toEqual(["1"]);
  });

  it("refuses to reload the entry module", () => {
    const s = projectAt({ "helper.tera": "value = 1\n" });
    s.enter("from helper import value");
    expect(s.engine.reloadModule("__main__")).toBe(false);
  });
});
