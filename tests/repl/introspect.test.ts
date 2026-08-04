import { beforeAll, describe, expect, it } from "vitest";
import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import { Engine } from "../../src/api/engine.js";
import type { EngineOptions } from "../../src/api/engine.js";
import { nativeToTagged, taggedToNative } from "../../src/runtime/domain/host.js";
import { parseReceiverPath } from "../../src/runtime/introspect.js";
import { createLanguage } from "../../src/cli/repl/language.js";
import { createAnalyzer } from "../../src/cli/repl/analysis.js";
import { createCompleter } from "../../src/cli/repl/completion.js";
import type { GlobalCell } from "../../src/runtime/intrinsics/global-cells.js";

function globalNames(engine: Engine): string[] {
  const cells = engine.interpreter.globalCells?.cells as Iterable<[string, GlobalCell]> | undefined;
  return cells ? Array.from(cells, ([key]) => String(key)) : [];
}

function memberNames(engine: Engine, receiver: string): string[] {
  return (engine.introspectMembers(receiver) ?? []).map((member) => member.name);
}

describe("parseReceiverPath", () => {
  it("accepts identifier chains", () => {
    expect(parseReceiverPath("a")).toEqual(["a"]);
    expect(parseReceiverPath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("rejects calls, indexing, and non-identifier expressions", () => {
    expect(parseReceiverPath("f()")).toBeNull();
    expect(parseReceiverPath("xs[0]")).toBeNull();
    expect(parseReceiverPath("a + b")).toBeNull();
    expect(parseReceiverPath("")).toBeNull();
  });
});

describe("engine.introspectMembers", () => {
  let engine: Engine;

  beforeAll(() => {
    engine = new Engine(createReactiveTeraOptions({ nativeToTagged, taggedToNative }) as EngineOptions);
    engine.run('rec = {name: "a", age: 3}');
    engine.run("bag = {}");
    engine.run("bag.alpha = 1");
    engine.run("bag.beta = 2");
    engine.run("box = {only: 1}");
    engine.run("box = {fresh: 2}");
    engine.run("nest = {inner: rec}");
    engine.run("class Shape:\n  public constructor(name: string):\n    this.name = name\n  private hidden() -> int:\n    return 0\n  public get label() -> string:\n    return this.name\n  public area() -> float:\n    return 0.0\n");
    engine.run('class Circle extends Shape:\n  public constructor(r: float):\n    super(name="c")\n    this.r = r\n  public area() -> float:\n    return this.r\n');
    engine.run("shape = Circle(2.0)");
    engine.run("total = 42");
    engine.run("m = Map()");
  });

  it("enumerates literal object keys", () => {
    expect(memberNames(engine, "rec").sort()).toEqual(["age", "name"]);
  });

  it("enumerates keys added dynamically after construction", () => {
    expect(memberNames(engine, "bag").sort()).toEqual(["alpha", "beta"]);
  });

  it("reflects the live value after reassignment", () => {
    expect(memberNames(engine, "box")).toEqual(["fresh"]);
  });

  it("resolves a chained property path to the live nested value", () => {
    expect(memberNames(engine, "nest.inner").sort()).toEqual(["age", "name"]);
  });

  it("enumerates instance fields, methods, getters, and inherited members", () => {
    const members = memberNames(engine, "shape").sort();
    expect(members).toContain("r");
    expect(members).toContain("area");
    expect(members).toContain("name");
    expect(members).toContain("label");
  });

  it("hides private members and the constructor", () => {
    const members = memberNames(engine, "shape");
    expect(members).not.toContain("hidden");
    expect(members).not.toContain("constructor");
  });

  it("classifies method, field, and getter kinds", () => {
    const byName = new Map((engine.introspectMembers("shape") ?? []).map((member) => [member.name, member.kind]));
    expect(byName.get("area")).toBe("method");
    expect(byName.get("r")).toBe("field");
    expect(byName.get("label")).toBe("property");
  });

  it("enumerates builtin prototype methods for Map instances", () => {
    const members = memberNames(engine, "m");
    expect(members).toEqual(expect.arrayContaining(["get", "set", "has", "delete", "keys"]));
  });

  it("returns null for primitives and unresolved receivers", () => {
    expect(engine.introspectMembers("total")).toBeNull();
    expect(engine.introspectMembers("missing")).toBeNull();
    expect(engine.introspectMembers("shape.area()")).toBeNull();
  });

  it("returns an empty list for a resolved object with no members", () => {
    engine.run("blank = {}");
    expect(engine.introspectMembers("blank")).toEqual([]);
  });
});

describe("completion with runtime introspection", () => {
  let engine: Engine;
  let complete: (input: string) => string | string[];

  beforeAll(() => {
    engine = new Engine(createReactiveTeraOptions({ nativeToTagged, taggedToNative }) as EngineOptions);
    engine.run("bag = {}");
    engine.run("bag.alpha = 1");
    engine.run("bag.beta = 2");
    complete = createCompleter({
      language: createLanguage(),
      analyzer: createAnalyzer(),
      sessionSource: () => "bag = {}\nbag.alpha = 1\nbag.beta = 2",
      engineGlobals: () => globalNames(engine),
      commandNames: () => ["exit", "reset"],
      introspect: (receiver) => engine.introspectMembers(receiver),
    });
  });

  it("suggests dynamically added object keys behind a dot", () => {
    const labels = complete("bag.");
    const list = Array.isArray(labels) ? labels : [labels];
    expect(list).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("completes a uniquely matching member from its typed prefix", () => {
    const completed = complete("bag.al");
    expect(completed).toBe("bag.alpha");
  });

  it("offers no member noise for a resolved empty object", () => {
    engine.run("hollow = {}");
    expect(complete("hollow.")).toBe("hollow.");
  });
});

describe("completion inside an unevaluated multiline buffer", () => {
  function multilineCompleter(pending: string) {
    const engine = new Engine(createReactiveTeraOptions({ nativeToTagged, taggedToNative }) as EngineOptions);
    return createCompleter({
      language: createLanguage(),
      analyzer: createAnalyzer(),
      sessionSource: () => pending,
      engineGlobals: () => globalNames(engine),
      commandNames: () => ["exit", "reset"],
      introspect: (receiver) => engine.introspectMembers(receiver),
    });
  }

  it("suggests keys of an object literal declared earlier in the block", () => {
    const complete = multilineCompleter("row = {alpha: 1, beta: 2}");
    const labels = complete("row.");
    const list = Array.isArray(labels) ? labels : [labels];
    expect(list).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("suggests methods of a builtin constructed earlier in the block", () => {
    const complete = multilineCompleter("a = Map()");
    expect(complete("a.g")).toBe("a.get");
  });
});
