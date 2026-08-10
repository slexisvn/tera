import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/index.js";
import type { EngineUnhandledRejection } from "../../../src/index.js";

type Harness = {
  engine: Engine;
  out: string[];
  rejections: EngineUnhandledRejection[];
};

function harness(): Harness {
  const out: string[] = [];
  const rejections: EngineUnhandledRejection[] = [];
  const engine = new Engine({
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
