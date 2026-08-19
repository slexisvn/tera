import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const ASYNC = ["async fn produce():", "  return 1"];
const ASYNC_OF = ["async fn produce(a):", "  return (a + 1)"];
const GENERATOR = ["fn* produce():", "  yield 7"];
const RETURNING_GENERATOR = ["fn* produce():", "  return 1"];
const PLAIN = ["fn produce():", "  return 1"];

const inLoop = (callee: readonly string[], ...body: string[]) =>
  differential(
    src(
      ...callee,
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

describe("calling a coroutine from a function hot enough to leave the interpreter", () => {
  it("hands back a promise, not the value the async body returned", () => {
    expect(inLoop(ASYNC, "  p = produce()", "  return typeof p")).toEqual("object");
  });

  it("keeps then on the promise the compiled call site produced", () => {
    expect(inLoop(ASYNC, "  p = produce()", "  return typeof p.then")).toEqual("function");
  });

  it("keeps catch on the promise the compiled call site produced", () => {
    expect(inLoop(ASYNC, "  p = produce()", "  return typeof p.catch")).toEqual("function");
  });

  it("settles the promise to the value the async body returned", () => {
    expect(inLoop(ASYNC, "  p = produce()", "  return p.then((v) => v + 1)")).toEqual(2);
  });

  it("passes the caller's argument through to the async body", () => {
    expect(inLoop(ASYNC_OF, "  p = produce(p0)", "  return p.then((v) => v)")).toEqual(401);
  });

  it("hands back an iterator for a generator that yields", () => {
    expect(inLoop(GENERATOR, "  it = produce()", "  return it.next().value")).toEqual(7);
  });

  it("hands back an iterator for a generator that only returns", () => {
    expect(inLoop(RETURNING_GENERATOR, "  it = produce()", "  return typeof it")).toEqual("object");
  });

  it("reports the returning generator as done on its first step", () => {
    expect(inLoop(RETURNING_GENERATOR, "  it = produce()", "  return it.next().done")).toEqual(true);
  });

  it("carries the returning generator's value on that first step", () => {
    expect(inLoop(RETURNING_GENERATOR, "  it = produce()", "  return it.next().value")).toEqual(1);
  });

  it("still hands back the body's own value for a plain callee", () => {
    expect(inLoop(PLAIN, "  p = produce()", "  return typeof p")).toEqual("number");
  });
});
