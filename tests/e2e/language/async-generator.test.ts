import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/index.js";

describe("Tera async and generators", () => {
  it("bridges async function results to native values", async () => {
    const engine = new Engine();
    await expect(Promise.resolve(engine.runNative("async fn f():\n  return 7\nf()"))).resolves.toBe(7);
  });

  it("runs generator yield and iterator next", () => {
    const source = [
      "fn* gen():",
      "  yield 1",
      "  yield 2",
      "it = gen()",
      "a = it.next().value",
      "b = it.next().value",
      "a + b",
    ].join("\n");
    expect(new Engine().runValue(source).value).toBe(3);
  });

  it("routes print through the engine output hook", () => {
    const prints: string[] = [];
    const engine = new Engine({ output: (text) => prints.push(text) });
    engine.run("print(\"hello\", 7)");
    expect(prints).toEqual(["hello 7"]);
  });

  it("runs Promise.all_settled under the name the checker knows", () => {
    const prints: string[] = [];
    const engine = new Engine({ output: (text) => prints.push(text) });
    const source = [
      "async fn main() -> void:",
      "  r = await Promise.all_settled([Promise.resolve(1), Promise.reject(\"e\")])",
      "  print(r[0].status, r[1].status, r[0].value, r[1].reason)",
      "main()",
    ].join("\n");
    engine.run(source);
    expect(prints).toEqual(["fulfilled rejected 1 e"]);
  });

  it("schedules queue_microtask after synchronous work", () => {
    const prints: string[] = [];
    const engine = new Engine({ output: (text) => prints.push(text) });
    engine.run("print(\"a\")\nqueue_microtask(() => print(\"micro\"))\nprint(\"b\")");
    expect(prints).toEqual(["a", "b", "micro"]);
  });

  it("coerces objects through a snake_case to_string method", () => {
    const prints: string[] = [];
    const engine = new Engine({ output: (text) => prints.push(text) });
    const source = [
      "class Money:",
      "  public constructor(n: int):",
      "    this.n = n",
      "  public to_string() -> string:",
      "    return `$${this.n}`",
      "print(`total ${Money(5)}`)",
    ].join("\n");
    engine.run(source);
    expect(prints).toEqual(["total $5"]);
  });
});
