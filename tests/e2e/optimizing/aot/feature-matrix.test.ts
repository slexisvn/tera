import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotCompileOptions } from "../../../../src/api/engine.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const POINT = [
  "class Point:",
  "  public constructor(x: int, y: int):",
  "    this.x = x",
  "    this.y = y",
  "  public sum() -> int:",
  "    return this.x + this.y",
];

const SHAPES = [
  "class Shape:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public area() -> int:",
  "    return this.n",
  "class Circle extends Shape:",
  "  public constructor(r: int):",
  "    super(r)",
  "  public area() -> int:",
  "    return this.n * 2",
];

const FEATURES: ReadonlyArray<readonly [string, string]> = [
  ["int values", src("n: int = 7", "print(n)")],
  ["float values", src("x: float = 1.5", "print(x)")],
  ["string values", src('s: string = "hi"', "print(s)")],
  ["bool values", src("b: bool = true", "print(b)")],
  ["null values", src("n: int | null = null", "print(n == null)")],
  ["arrays", src("xs: int[] = [1, 2, 3]", "print(xs[1])")],
  ["nested arrays", src("xs: int[][] = [[1, 2], [3]]", "print(xs[0][1])")],
  ["object literals", src("o = {a: 1, b: 2}", "print(o.a + o.b)")],
  ["maps", src("m = Map()", 'm.set("a", 1)', 'print(m.get("a"))')],
  ["sets", src("s = Set()", "s.add(1)", "print(s.has(1))")],
  ["arithmetic", src("print(1 + 2 * 3 - 4 / 2)")],
  ["remainder", src("print(7 % 3)")],
  ["comparison", src("print(1 < 2)")],
  ["logical operators", src("print(true and not false)")],
  ["bitwise operators", src("print((6 & 3) | (1 << 2) ^ 5)")],
  ["compound assignment", src("n = 1", "n += 4", "n *= 2", "print(n)")],
  ["ternary", src("n: int = 3", 'print(n > 2 ? "big" : "small")')],
  ["nullish coalescing", src("n: int | null = null", "print(n ?? 5)")],
  ["in operator", src("o = {a: 1}", 'print("a" in o)')],
  ["optional member access", src("o = {a: 1}", "print(o?.a)")],
  ["if and else", src("n: int = 1", "if n > 0:", '  print("up")', "else:", '  print("down")')],
  ["else if", src("n: int = 1", "if n > 5:", '  print("big")', "else if n > 0:", '  print("small")', "else:", '  print("none")')],
  ["while loops", src("i = 0", "while i < 3:", "  i = i + 1", "print(i)")],
  ["for over an array", src("total = 0", "for n of [1, 2, 3]:", "  total = total + n", "print(total)")],
  ["for over a range", src("total = 0", "for i of range(0, 4):", "  total = total + i", "print(total)")],
  ["for over a set", src("s = Set()", "s.add(2)", "total = 0", "for v of s:", "  total = total + v", "print(total)")],
  ["break and continue", src("total = 0", "for i of range(0, 10):", "  if i > 4:", "    break", "  if i % 2 == 0:", "    continue", "  total = total + i", "print(total)")],
  ["switch on an int", src("fn name(v: int) -> string:", "  switch v:", "    case 1:", '      return "one"', "    default:", '      return "other"', "print(name(1))")],
  ["switch on a string", src("fn name(v: string) -> string:", "  switch v:", '    case "a":', '      return "first"', "    default:", '      return "other"', 'print(name("a"))')],
  ["try catch finally", src("try:", '  print("body")', "catch e:", '  print("caught")', "finally:", '  print("done")')],
  ["throw and catch", src("try:", '  throw "boom"', "catch e:", "  print(e)")],
  ["functions", src("fn add(a: int, b: int) -> int:", "  return a + b", "print(add(2, 3))")],
  ["recursion", src("fn fib(n: int) -> int:", "  if n < 2:", "    return n", "  return fib(n - 1) + fib(n - 2)", "print(fib(10))")],
  ["default parameters", src("fn step(n: int, by: int = 2) -> int:", "  return n + by", "print(step(1))")],
  ["rest parameters", src("fn total(...ns: int) -> int:", "  acc = 0", "  for n of ns:", "    acc = acc + n", "  return acc", "print(total(1, 2, 3))")],
  ["string returns", src("fn greet(name: string) -> string:", '  return "hi " + name', 'print(greet("a"))')],
  ["array returns", src("fn pair(a: int) -> int[]:", "  return [a, a]", "print(pair(2)[1])")],
  ["named function callbacks", src("fn twice(n: int) -> int:", "  return n * 2", "fn apply(f: (int) -> int, n: int) -> int:", "  return f(n)", "print(apply(twice, 4))")],
  ["lambda arguments", src("fn apply(f: (int) -> int, n: int) -> int:", "  return f(n)", "print(apply(n => n + 1, 4))")],
  ["lambdas in variables", src("inc: (int) -> int = n => n + 1", "print(inc(4))")],
  ["returned closures", src("fn make(base: int) -> (int) -> int:", "  return n => n + base", "print(make(3)(4))")],
  ["classes", src(...POINT, "p = Point(1, 2)", "print(p.sum())")],
  ["constructed with new", src(...POINT, "p = new Point(1, 2)", "print(p.sum())")],
  ["inheritance and override", src(...SHAPES, "s: Shape = Circle(3)", "print(s.area())")],
  ["static members", src("class Counter:", "  public static total: int = 0", "  public static bump(n: int) -> int:", "    return n + 1", "print(Counter.bump(1))")],
  ["getters", src("class Box:", "  public constructor(n: int):", "    this.n = n", "  public get doubled() -> int:", "    return this.n * 2", "print(Box(2).doubled)")],
  ["interfaces", src("interface Shaped:", "  area() -> int", "class Disc implements Shaped:", "  public constructor(n: int):", "    this.n = n", "  public area() -> int:", "    return this.n", "d: Shaped = Disc(3)", "print(d.area())")],
  ["arrays of instances", src(...POINT, "ps: Point[] = [Point(1, 2), Point(3, 4)]", "print(ps[1].sum())")],
  ["typeof", src("fn kind(n: int) -> string:", "  return typeof n", "print(kind(1))")],
  ["instanceof", src(...SHAPES, "fn round(s: Shape) -> bool:", "  return s instanceof Circle", "print(round(Circle(1)))")],
  ["async functions", src("async fn twice(n: int) -> int:", "  return n * 2", "async fn run() -> void:", "  v: int = await twice(21)", "  print(v)", "run()")],
  ["generators", src("fn* counter(n: int):", "  i = 0", "  while i < n:", "    yield i", "    i = i + 1", "for v of counter(3):", "  print(v)")],
  ["string methods", src('s = "hello"', "print(s.to_upper_case().length)")],
  ["array methods", src("xs = [3, 1, 2]", "print(xs.map(n => n * 2)[0])")],
  ["math intrinsics", src("print(Math.max(1, 2) + Math.floor(1.7))")],
  ["parse_int", src('print(parse_int("42"))')],
  ["type aliases", src("type Count = int", "n: Count = 3", "print(n)")],
  ["template interpolation", src("n: int = 2", "print(`n is ${n}`)")],
];

const VERIFIED = compilerOptions("speed", { verifyEachPass: true });

const BACKENDS: ReadonlyArray<readonly [string, AotCompileOptions]> = [
  ["c", { backend: "c", format: "assembly", compilerOptions: VERIFIED }],
  ["x64-windows", { backend: "x64-windows", format: "executable", compilerOptions: VERIFIED }],
];

describe("AOT language surface", () => {
  for (const [feature, source] of FEATURES) {
    it(`runs ${feature} in the interpreter`, () => {
      expect(() => nodeEngine({ typecheck: "off" }).runNative(source)).not.toThrow();
    });
  }

  for (const [name, options] of BACKENDS) {
    for (const [feature, source] of FEATURES) {
      it(`compiles ${feature} for the ${name} backend`, () => {
        const program = nodeEngine({ typecheck: "off" }).compileAot(source, options);
        expect([feature, program.skipped]).toEqual([feature, []]);
      });
    }
  }
});
