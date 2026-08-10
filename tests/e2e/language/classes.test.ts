import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/index.js";

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

  it("initializes string literal fields in simple constructors", () => {
    const source = [
      "class Label:",
      "  constructor():",
      "    this.text = \"ready\"",
      "Label().text",
    ].join("\n");
    expect(run(source)).toBe("ready");
  });

  it("allows keyword-named static class members", () => {
    const source = [
      "class Glyph:",
      "  static of(value):",
      "    return value",
      "Glyph.of(\"A\")",
    ].join("\n");
    expect(run(source)).toBe("A");
  });

  it("runs private constructor calls from static field initializers", () => {
    const source = [
      "class Config:",
      "  private static instance = Config(\"prod\")",
      "  private constructor(env):",
      "    this.env = env",
      "  static getInstance():",
      "    return Config.instance",
      "Config.getInstance().env",
    ].join("\n");
    expect(run(source)).toBe("prod");
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

  it("runs classes that declare interface implementations", () => {
    const source = [
      "interface Shape:",
      "  area() -> int",
      "class Square implements Shape:",
      "  constructor(side):",
      "    this.side = side",
      "  area():",
      "    return this.side * this.side",
      "Square(3).area()",
    ].join("\n");
    expect(run(source)).toBe(9);
  });

  it("runs a class that extends a base and implements interfaces", () => {
    const source = [
      "interface Named:",
      "  label() -> string",
      "class Base:",
      "  constructor():",
      "    this.kind = \"base\"",
      "class Tagged extends Base implements Named:",
      "  label():",
      "    return this.kind",
      "Tagged().label()",
    ].join("\n");
    expect(run(source)).toBe("base");
  });

  it("initializes and guards private instance fields", () => {
    const source = [
      "class Account:",
      "  private balance = 1",
      "  deposit(amount):",
      "    this.balance = this.balance + amount",
      "    return this.balance",
      "Account().deposit(4)",
    ].join("\n");
    expect(run(source)).toBe(5);
    expect(() => run([
      "class Account:",
      "  private balance = 1",
      "Account().balance",
    ].join("\n"))).toThrow(/Cannot access private member 'balance'/);
    expect(() => run([
      "class Account:",
      "  private balance = 1",
      "acc = Account()",
      "acc.balance = 3",
    ].join("\n"))).toThrow(/Cannot access private member 'balance'/);
  });

  it("guards private methods while allowing owner calls", () => {
    const source = [
      "class SecretBox:",
      "  private secret():",
      "    return 3",
      "  reveal():",
      "    return this.secret()",
      "SecretBox().reveal()",
    ].join("\n");
    expect(run(source)).toBe(3);
    expect(() => run([
      "class SecretBox:",
      "  private secret():",
      "    return 3",
      "SecretBox().secret()",
    ].join("\n"))).toThrow(/Cannot access private member 'secret'/);
  });

  it("allows protected subclass access and rejects external access", () => {
    const source = [
      "class Base:",
      "  protected code = 4",
      "  protected read():",
      "    return this.code",
      "class Sub extends Base:",
      "  reveal():",
      "    return this.read() + this.code",
      "Sub().reveal()",
    ].join("\n");
    expect(run(source)).toBe(8);
    expect(() => run([
      "class Base:",
      "  protected code = 4",
      "Base().code",
    ].join("\n"))).toThrow(/Cannot access protected member 'code'/);
  });

  it("guards private constructors but allows owner factories", () => {
    const source = [
      "class Token:",
      "  private constructor(value):",
      "    this.value = value",
      "  static make(value):",
      "    return Token(value)",
      "Token.make(7).value",
    ].join("\n");
    expect(run(source)).toBe(7);
    expect(() => run([
      "class Token:",
      "  private constructor():",
      "    this.value = 1",
      "Token()",
    ].join("\n"))).toThrow(/Cannot access private constructor 'Token'/);
  });

  it("guards private and protected static members", () => {
    const source = [
      "class Base:",
      "  protected static seed = 3",
      "class Vault extends Base:",
      "  private static key = 5",
      "  private static secret():",
      "    return Vault.key",
      "  static read():",
      "    return Vault.secret() + Vault.seed",
      "Vault.read()",
    ].join("\n");
    expect(run(source)).toBe(8);
    expect(() => run([
      "class Vault:",
      "  private static key = 5",
      "Vault.key",
    ].join("\n"))).toThrow(/Cannot access private member 'key'/);
    expect(() => run([
      "class Vault:",
      "  private static secret():",
      "    return 5",
      "Vault.secret()",
    ].join("\n"))).toThrow(/Cannot access private member 'secret'/);
    expect(() => run([
      "class Base:",
      "  protected static seed = 3",
      "Base.seed",
    ].join("\n"))).toThrow(/Cannot access protected member 'seed'/);
  });

  it("guards abstract class construction at runtime without typecheck", () => {
    const source = [
      "abstract class Exporter:",
      "  abstract write() -> string",
      "Exporter()",
    ].join("\n");
    expect(() => new Engine({ typecheck: "off" }).runNative(source)).toThrow(/Cannot instantiate abstract class 'Exporter'/);
  });

  it("runs concrete subclasses that implement abstract members", () => {
    const source = [
      "abstract class Exporter:",
      "  prefix() -> string:",
      "    return \"file\"",
      "  abstract write() -> string",
      "class CsvExporter extends Exporter:",
      "  write() -> string:",
      "    return this.prefix() + \":csv\"",
      "CsvExporter().write()",
    ].join("\n");
    expect(new Engine({ typecheck: "off" }).runNative(source)).toBe("file:csv");
  });

  it("rejects concrete subclasses that leave abstract members unresolved without typecheck", () => {
    const source = [
      "abstract class Exporter:",
      "  abstract write() -> string",
      "class CsvExporter extends Exporter:",
      "  label() -> string:",
      "    return \"csv\"",
    ].join("\n");
    expect(() => new Engine({ typecheck: "off" }).runNative(source)).toThrow(/must implement abstract member 'write'/);
  });

  it("enforces implemented interface contracts at runtime without typecheck", () => {
    const source = [
      "interface Shape:",
      "  area() -> int",
      "class Square implements Shape:",
      "  constructor(side):",
      "    this.side = side",
    ].join("\n");
    expect(() => new Engine({ typecheck: "off" }).runNative(source)).toThrow(/Class 'Square' is missing 'area' required by interface 'Shape'/);
  });

  it("accepts runtime interface fields created by constructor assignments", () => {
    const source = [
      "interface Named:",
      "  name: string",
      "class Person implements Named:",
      "  constructor(name):",
      "    this.name = name",
      "Person(\"tera\").name",
    ].join("\n");
    expect(new Engine({ typecheck: "off" }).runNative(source)).toBe("tera");
  });
});
