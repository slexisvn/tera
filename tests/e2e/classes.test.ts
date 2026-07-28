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

  it("calls static methods on the class itself", () => {
    const source = [
      "class MathKit:",
      "  static square(n):",
      "    return n * n",
      "  static sum(a, b):",
      "    return a + b",
      "MathKit.square(5) + MathKit.sum(3, 4)",
    ].join("\n");
    expect(run(source)).toBe(32);
  });

  it("keeps static members off instances and instance members off the class", () => {
    const source = [
      "class Widget:",
      "  static kind():",
      "    return \"widget\"",
      "  constructor():",
      "    this.size = 1",
      "  grow():",
      "    return this.size + 1",
      "w = Widget()",
      "typeof w.kind + \"|\" + typeof Widget.grow + \"|\" + Widget.kind() + \"|\" + w.grow()",
    ].join("\n");
    expect(run(source)).toBe("undefined|undefined|widget|2");
  });

  it("runs static factory methods that construct instances", () => {
    const source = [
      "class Point:",
      "  constructor(x, y):",
      "    this.x = x",
      "    this.y = y",
      "  static origin():",
      "    return Point(0, 0)",
      "  sum():",
      "    return this.x + this.y",
      "Point.origin().sum()",
    ].join("\n");
    expect(run(source)).toBe(0);
  });

  it("supports static getters and setters on the class", () => {
    const source = [
      "class Registry:",
      "  static get size():",
      "    return Registry._count",
      "  static set size(value):",
      "    Registry._count = value",
      "Registry.size = 7",
      "Registry.size",
    ].join("\n");
    expect(run(source)).toBe(7);
  });

  it("inherits static members through the constructor chain", () => {
    const source = [
      "class Base:",
      "  static tag():",
      "    return \"base\"",
      "class Middle extends Base:",
      "  hello():",
      "    return 1",
      "class Leaf extends Middle:",
      "  world():",
      "    return 2",
      "Leaf.tag()",
    ].join("\n");
    expect(run(source)).toBe("base");
  });

  it("lets subclasses override inherited static methods", () => {
    const source = [
      "class Base:",
      "  static name2():",
      "    return \"base\"",
      "class Sub extends Base:",
      "  static name2():",
      "    return \"sub\"",
      "Sub.name2() + \":\" + Base.name2()",
    ].join("\n");
    expect(run(source)).toBe("sub:base");
  });
});
