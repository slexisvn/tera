import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../src/index.js";
import { nodeModuleFileSystem } from "../../../src/frontend/modules/node-file-system.js";
import type { EngineUnhandledRejection } from "../../../src/index.js";

function inEntryFile<T>(source: string, use: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "tera-rejection-"));
  try {
    const path = join(directory, "entry.tera");
    writeFileSync(path, `${source}\n`);
    return use(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Harness = {
  engine: Engine;
  out: string[];
  rejections: EngineUnhandledRejection[];
};

function harness(): Harness {
  const out: string[] = [];
  const rejections: EngineUnhandledRejection[] = [];
  const engine = new Engine({
    moduleFileSystem: nodeModuleFileSystem,
    output: (text) => out.push(text),
    onUnhandledRejection: (rs) => rejections.push(...rs),
  });
  return { engine, out, rejections };
}

describe("Tera unhandled promise rejections", () => {
  it("reports a fire-and-forget async rejection but still runs the rest of the program", () => {
    const { engine, out, rejections } = harness();
    engine.runNative(
      [
        "async fn boom() -> void:",
        "  throw \"async failure\"",
        "boom()",
        "print(\"main done\")",
      ].join("\n"),
    );

    expect(out).toEqual(["main done"]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.message).toContain("async failure");
    expect(rejections[0]!.reason).toBe("async failure");
  });

  it("reports each distinct fire-and-forget rejection", () => {
    const { engine, rejections } = harness();
    engine.runNative(
      [
        "async fn boom(tag) -> void:",
        "  throw tag",
        "boom(\"first\")",
        "boom(\"second\")",
        "print(\"done\")",
      ].join("\n"),
    );

    expect(rejections.map((r) => r.reason)).toEqual(["first", "second"]);
  });

  it("does not report when the rejection is observed at the top level (surfaces as uncaught)", () => {
    const { engine, rejections } = harness();
    const source = [
      "async fn boom() -> void:",
      "  throw \"async failure\"",
      "async fn main() -> void:",
      "  await boom()",
      "main()",
    ].join("\n");

    expect(() => engine.runNative(source)).toThrow();
    expect(rejections).toHaveLength(0);
  });

  it("does not report when the rejection is handled with catch", () => {
    const { engine, out, rejections } = harness();
    engine.runNative(
      [
        "fn onErr(e):",
        "  print(\"caught\")",
        "async fn boom() -> void:",
        "  throw \"async failure\"",
        "boom().catch(onErr)",
      ].join("\n"),
    );

    expect(out).toEqual(["caught"]);
    expect(rejections).toHaveLength(0);
  });

  it("does not report a rejection an await raised into a try that caught it", () => {
    const { engine, out, rejections } = harness();
    engine.runNative(
      [
        "async fn boom() -> int:",
        '  throw "async failure"',
        "  return 1",
        "p = boom()",
        "try:",
        "  print(await p)",
        "catch e:",
        "  print(e)",
      ].join("\n"),
    );

    expect(out).toEqual(["async failure"]);
    expect(rejections).toHaveLength(0);
  });

  it("does not report a rejection settled before anything awaited it", () => {
    const { engine, out, rejections } = harness();
    engine.runNative(
      [
        "async fn g() -> int:",
        "  return 1",
        "async fn f(n: int) -> int:",
        "  x = await g()",
        "  if n == 1:",
        '    throw "one"',
        "  return x + n",
        "a = f(0)",
        "b = f(1)",
        "print(await a)",
        "try:",
        "  print(await b)",
        "catch e:",
        "  print(e)",
      ].join("\n"),
    );

    expect(out).toEqual(["1", "one"]);
    expect(rejections).toHaveLength(0);
  });

  it("surfaces a top level await of a rejection nobody caught as uncaught", () => {
    const { engine, out, rejections } = harness();
    const source = [
      "async fn g() -> int:",
      "  return 1",
      "async fn f() -> int:",
      "  x = await g()",
      '  throw "boom"',
      "  return x",
      "p = f()",
      'print("mid")',
      "print(await p)",
      'print("after")',
    ].join("\n");

    expect(() => engine.runNative(source)).toThrow("Uncaught boom");
    expect([out, rejections]).toEqual([["mid"], []]);
  });

  it("surfaces the same uncaught rejection when the entry is run as a module", () => {
    const { engine, out, rejections } = harness();
    const source = [
      "async fn g() -> int:",
      "  return 1",
      "async fn f() -> int:",
      "  x = await g()",
      '  throw "boom"',
      "  return x",
      "p = f()",
      'print("mid")',
      "print(await p)",
      'print("after")',
    ].join("\n");

    inEntryFile(source, (path) => {
      expect(() => engine.runModuleGraphNative(engine.loadModuleGraph(path))).toThrow(
        "Uncaught boom",
      );
    });
    expect([out, rejections]).toEqual([["mid"], []]);
  });

  it("does not report a fulfilled fire-and-forget promise", () => {
    const { engine, rejections } = harness();
    engine.runNative(
      [
        "async fn ok() -> void:",
        "  return",
        "ok()",
        "print(\"done\")",
      ].join("\n"),
    );

    expect(rejections).toHaveLength(0);
  });
});
