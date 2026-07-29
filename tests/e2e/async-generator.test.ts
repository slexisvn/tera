import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

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
});
