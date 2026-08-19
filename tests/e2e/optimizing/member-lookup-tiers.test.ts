import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const inLoop = (...body: string[]) =>
  differential(
    src(
      "async fn settle():",
      "  return 1",
      "fn* step():",
      "  yield 7",
      "fn plain(v):",
      "  return v",
      "fn f0(p0):",
      ...body,
      "fn run(n):",
      "  last = 0",
      "  i = 0",
      "  while (i < n):",
      "    i = (i + 1)",
      "    last = f0(i)",
      "  return last",
      "run(400)",
    ),
    { tiers: ["baseline", "jit", "osr", "production"] },
  );

describe("reading a member of every value kind once the reader leaves the interpreter", () => {
  it("reads an array's own length", () => {
    expect(inLoop("  a = [1, 2, 3]", "  return a.length")).toEqual(3);
  });

  it("reads an array method off the array prototype", () => {
    expect(inLoop("  a = [1, 2, 3]", "  return a.index_of(2)")).toEqual(1);
  });

  it("reads a string's own length", () => {
    expect(inLoop("  s = \"hello\"", "  return s.length")).toEqual(5);
  });

  it("reads a string method off the string prototype", () => {
    expect(inLoop("  s = \"hello\"", "  return s.to_upper_case()")).toEqual("HELLO");
  });

  it("reads a regex's own source", () => {
    expect(inLoop("  r = /ab+/g", "  return r.source")).toEqual("ab+");
  });

  it("reads a regex flag property", () => {
    expect(inLoop("  r = /ab+/g", "  return r.global")).toEqual(true);
  });

  it("reads a regex method off the regex prototype", () => {
    expect(inLoop("  r = /ab+/", "  return r.test(\"abb\")")).toEqual(true);
  });

  it("reads a number method off the number prototype", () => {
    expect(inLoop("  x = 1.25", "  return x.to_fixed(1)")).toEqual("1.3");
  });

  it("reads a boolean method off the boolean prototype", () => {
    expect(inLoop("  b = true", "  return b.to_string()")).toEqual("true");
  });

  it("reads a function's own name", () => {
    expect(inLoop("  return plain.name")).toEqual("plain");
  });

  it("reads a function's own arity", () => {
    expect(inLoop("  return plain.length")).toEqual(1);
  });

  it("reads then off a promise", () => {
    expect(inLoop("  p = settle()", "  return typeof p.then")).toEqual("function");
  });

  it("reads state off a promise", () => {
    expect(inLoop("  p = settle()", "  return typeof p.state")).toEqual("string");
  });

  it("reads next off a generator", () => {
    expect(inLoop("  it = step()", "  return it.next().value")).toEqual(7);
  });

  it("reads a member of an object literal", () => {
    expect(inLoop("  o = { k: 4 }", "  return o.k")).toEqual(4);
  });

  it("answers undefined for a member no value kind provides", () => {
    expect(inLoop("  x = 1.25", "  return x.not_a_member")).toEqual(undefined);
  });
});
