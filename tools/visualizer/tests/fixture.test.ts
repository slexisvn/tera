import { describe, expect, it } from "vitest";
import { fixtureFor } from "../src/services/fixture";
import { stageFor } from "./stage";

const BEFORE = stageFor({
  id: "a",
  title: "ir-builder",
  text: ["v0 = Parameter [index=0]", "v1 = Constant [value=8]", "v2 = Int32Mul v0, v1"].join("\n"),
});

const REWRITTEN = stageFor({
  id: "b",
  title: "type-narrowing",
  passName: "type-narrowing",
  owner: "drive",
  text: ["v0 = Parameter [index=0]", "v1 = Constant [value=8]", "v2 = Int32Shl v0, v1"].join("\n"),
});

const MINTED = stageFor({
  id: "c",
  title: "strength-reduction",
  passName: "strength-reduction",
  owner: "scaled",
  text: ["v0 = Parameter [index=0]", "v4 = Constant [value=3]", "v5 = Int32Shl v0, v4"].join("\n"),
});

describe("copying a stage as a test", () => {
  it("refuses a stage with nothing before it", () => {
    expect(fixtureFor(REWRITTEN, null)).toBeNull();
  });

  it("refuses a stage that is not an SSA graph", () => {
    const bytecode = stageFor({ id: "d", kind: "bytecode", passName: "bytecode" });

    expect(fixtureFor(bytecode, BEFORE)).toBeNull();
  });

  it("names the pass and the function it ran on", () => {
    const test = fixtureFor(REWRITTEN, BEFORE)!;

    expect(test).toContain('describe("type-narrowing on drive"');
    expect(test).toContain('afterNamedPass(BEFORE, "type-narrowing")');
  });

  it("asserts on the exact graph when the pass minted no new value", () => {
    const test = fixtureFor(REWRITTEN, BEFORE)!;

    expect(test).toContain(".toBe(");
    expect(test).toContain("v2 = Int32Shl v0, v1");
  });

  it("drops the exact graph when the pass minted values, since their ids are not reproducible", () => {
    const test = fixtureFor(MINTED, BEFORE)!;

    expect(test).not.toContain(".toBe(");
    expect(test).toContain('expect(after).not.toContain("v2 = Int32Mul v0, v1")');
    expect(test).toContain('expect(after).toContain("Int32Shl")');
  });

  it("says the pass left the graph alone when it did", () => {
    const quiet = stageFor({ id: "e", passName: "gvn", changed: false, text: BEFORE.text });

    expect(fixtureFor(quiet, BEFORE)).toContain("leaves alone the graph");
  });

  it("escapes anything that would end the template literal", () => {
    const risky = stageFor({ id: "f", passName: "gvn", text: "v1 = Constant [value=`${x}`]" });

    expect(fixtureFor(risky, BEFORE)).toContain("\\`\\${x}\\`");
  });
});
