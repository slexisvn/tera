import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const run = (source: string) => new Engine().runValue(source).value;

describe("Tera classes", () => {
  it("constructs instances without new", () => {
    const source = [
      "class Point:",
      "  constructor(x, y):",
      "    this.x = x",
      "    this.y = y",
      "  sum():",
      "    return this.x + this.y",
      "Point(3, 4).sum()",
    ].join("\n");
    expect(run(source)).toBe(7);
  });

  it("supports inheritance, super calls, and method override", () => {
    const source = [
      "class Animal:",
      "  constructor(name, suffix=\"\"):",
      "    this.name = name + suffix",
      "  speak():",
      "    return this.name",
      "class Dog extends Animal:",
      "  constructor(name):",
      "    super(name=name, suffix=\"!\")",
      "  speak():",
      "    return super.speak() + \" bark\"",
      "Dog(\"Rex\").speak()",
    ].join("\n");
    expect(run(source)).toBe("Rex! bark");
  });

  it("passes arguments through default subclass constructors", () => {
    const source = [
      "class Animal:",
      "  constructor(name):",
      "    this.name = name",
      "class Dog extends Animal:",
      "  speak():",
      "    return this.name",
      "Dog(\"Rex\").speak()",
    ].join("\n");
    expect(run(source)).toBe("Rex");
  });

  it("keeps instances independent", () => {
    const source = [
      "class Counter:",
      "  constructor():",
      "    this.count = 0",
      "  inc():",
      "    this.count = this.count + 1",
      "    return this",
      "a = Counter()",
      "b = Counter()",
      "a.inc().inc().inc()",
      "b.inc()",
      "a.count * 10 + b.count",
    ].join("\n");
    expect(run(source)).toBe(31);
  });
});
