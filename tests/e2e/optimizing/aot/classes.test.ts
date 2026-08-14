import { describe, it, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";

function compile(lines: readonly string[]) {
  const program = nodeEngine().compileAot(`${lines.join("\n")}\n`);
  expect(program.skipped).toEqual([]);
  return program;
}

function interpret(lines: readonly string[], call: string): unknown {
  return nodeEngine().runNative(`${lines.join("\n")}\n${call}\n`);
}

function bodyOf(program: { source: string }, symbol: string): string {
  const start = cSource(program).search(new RegExp(`^\\w[\\w *]*\\b${symbol}\\(`, "m"));
  expect(start).toBeGreaterThan(-1);
  return cSource(program).slice(start, cSource(program).indexOf("\n}", start));
}

function expectMatchesInterpreter(
  lines: readonly string[],
  entry: string,
  args: readonly number[],
): void {
  const program = compile(lines);
  const interpreted = interpret(lines, `${entry}(${args.join(", ")})`);
  expect(runCFunction(cSource(program), entry, args)).toBe(interpreted);
}

const POINT = [
  "class Point:",
  "  public constructor(x: int, y: int):",
  "    this.x = x",
  "    this.y = y",
  "  public sum() -> int:",
  "    return this.x + this.y",
  "  public scaled(by: int) -> int:",
  "    return this.x * by + this.y * by",
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

const INHERITED = [
  "class Base:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public size() -> int:",
  "    return this.n",
  "class Leaf extends Base:",
  "  public doubled() -> int:",
  "    return this.n * 2",
];

const GAUGE = [
  "class Gauge:",
  "  public constructor(raw: int):",
  "    this.raw = raw",
  "  public get scaled() -> int:",
  "    return this.raw * 10",
  "  public set scaled(value: int):",
  "    this.raw = value / 10",
];

const SIZED = [
  "class Sized:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public get width() -> int:",
  "    return this.n",
  "class Wide extends Sized:",
  "  public constructor(n: int):",
  "    super(n)",
  "  public get width() -> int:",
  "    return this.n * 3",
];

describe("AOT classes", () => {
  itNative("constructs an instance and reads a field back", () => {
    expectMatchesInterpreter(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(a, b)", "  return p.x"],
      "go",
      [3, 4],
    );
  });

  itNative("calls a method that reads two fields", () => {
    expectMatchesInterpreter(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(a, b)", "  return p.sum()"],
      "go",
      [3, 4],
    );
  });

  itNative("passes arguments to a method alongside the receiver", () => {
    expectMatchesInterpreter(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(a, b)", "  return p.scaled(3)"],
      "go",
      [3, 4],
    );
  });

  itNative("mutates a field through an assignment", () => {
    expectMatchesInterpreter(
      [
        ...POINT,
        "fn go(a: int, b: int) -> int:",
        "  p = Point(a, b)",
        "  p.x = p.x + 10",
        "  return p.sum()",
      ],
      "go",
      [3, 4],
    );
  });

  itNative("keeps two instances of the same class distinct", () => {
    expectMatchesInterpreter(
      [
        ...POINT,
        "fn go(a: int, b: int) -> int:",
        "  p = Point(a, b)",
        "  q = Point(b, a)",
        "  p.x = 100",
        "  return p.sum() - q.sum()",
      ],
      "go",
      [3, 4],
    );
  });

  itNative("constructs inside a loop without reusing storage", () => {
    expectMatchesInterpreter(
      [
        ...POINT,
        "fn go(n: int) -> int:",
        "  total = 0",
        "  i = 0",
        "  while i < n:",
        "    p = Point(i, i)",
        "    total = total + p.sum()",
        "    i = i + 1",
        "  return total",
      ],
      "go",
      [5],
    );
  });

  itNative("keeps a float field in floating point", () => {
    expectMatchesInterpreter(
      [
        "class Box:",
        "  public constructor(v: float):",
        "    this.v = v",
        "  public half() -> float:",
        "    return this.v / 2.0",
        "fn go(v: float) -> float:",
        "  b = Box(v)",
        "  return b.half()",
      ],
      "go",
      [7.5],
    );
  });

  itNative("runs a derived constructor through super", () => {
    expectMatchesInterpreter(
      [
        "class Shape:",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public size() -> int:",
        "    return this.n",
        "class Circle extends Shape:",
        "  public constructor(r: int):",
        "    super(r)",
        "    this.r = r",
        "  public area() -> int:",
        "    return this.r * this.r",
        "fn go(a: int) -> int:",
        "  c = Circle(a)",
        "  return c.area() + c.size()",
      ],
      "go",
      [6],
    );
  });

  itNative("overrides an inherited method", () => {
    expectMatchesInterpreter(
      [
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
        "fn go(a: int) -> int:",
        "  c = Circle(a)",
        "  return c.area()",
      ],
      "go",
      [6],
    );
  });

  it("gives a subclass field an offset past the whole parent instance", () => {
    const program = compile([
      "class Shape:",
      "  public constructor(n: int):",
      "    this.n = n",
      "class Circle extends Shape:",
      "  public constructor(r: int):",
      "    super(r)",
      "    this.r = r",
      "  public radius() -> int:",
      "    return this.r",
      "fn go(a: int) -> int:",
      "  c = Circle(a)",
      "  return c.radius()",
    ]);

    expect(bodyOf(program, "Circle_radius")).toContain("+ 16)");
  });

  itNative("reads a field through a field that holds another instance", () => {
    expectMatchesInterpreter(
      [
        "class Inner:",
        "  public constructor(v: int):",
        "    this.v = v",
        "class Outer:",
        "  public constructor(i: Inner):",
        "    this.i = i",
        "  public get() -> int:",
        "    return this.i.v",
        "fn go(v: int) -> int:",
        "  return Outer(Inner(v)).get()",
      ],
      "go",
      [7],
    );
  });

  itNative("reads a field off an instance returned by a plain function", () => {
    expectMatchesInterpreter(
      [
        "class P:",
        "  public constructor(v: int):",
        "    this.v = v",
        "fn make(v: int) -> P:",
        "  return P(v)",
        "fn go(v: int) -> int:",
        "  return make(v).v",
      ],
      "go",
      [9],
    );
  });

  itNative("chains a method that returns an instance", () => {
    expectMatchesInterpreter(
      [
        "class P:",
        "  public constructor(v: int):",
        "    this.v = v",
        "  public self() -> P:",
        "    return this",
        "fn go(v: int) -> int:",
        "  return P(v).self().v",
      ],
      "go",
      [9],
    );
  });

  it("lays an int field out directly after the object header", () => {
    const program = compile([
      ...POINT,
      "fn go(a: int, b: int) -> int:",
      "  p = Point(a, b)",
      "  return p.x",
    ]);

    expect(bodyOf(program, "go")).toContain("+ 8)");
  });

  it("allocates the instance through the arena rather than the stack", () => {
    const program = compile([
      ...POINT,
      "fn go(a: int, b: int) -> int:",
      "  p = Point(a, b)",
      "  return p.x",
    ]);

    expect(bodyOf(program, "go")).toContain("tera_alloc(");
  });

  it("calls the method directly instead of dispatching through a pointer", () => {
    const program = compile([
      ...POINT,
      "fn go(a: int, b: int) -> int:",
      "  p = Point(a, b)",
      "  return p.sum()",
    ]);

    expect(bodyOf(program, "go")).toContain("Point_sum(");
  });

  it("gives the constructor the receiver as its first parameter", () => {
    const program = compile([
      ...POINT,
      "fn go(a: int, b: int) -> int:",
      "  p = Point(a, b)",
      "  return p.x",
    ]);

    expect(cSource(program)).toContain("Point(unsigned char *p0, int32_t p1, int32_t p2)");
  });
  itNative("dispatches a polymorphic call to the receivers own implementation", () => {
    expectMatchesInterpreter(SHAPES.concat([
      "fn go(a: int) -> int:",
      "  s = Shape(a)",
      "  return s.area()",
    ]), "go", [7]);
  });

  itNative("dispatches the same call site to an overriding subclass", () => {
    expectMatchesInterpreter(SHAPES.concat([
      "fn go(a: int) -> int:",
      "  c = Circle(a)",
      "  return c.area()",
    ]), "go", [7]);
  });

  it("tests the shape id in the object header when the call site is polymorphic", () => {
    const program = compile(SHAPES.concat([
      "fn go(a: int) -> int:",
      "  s = Shape(a)",
      "  return s.area()",
    ]));

    expect(bodyOf(program, "go")).toContain("+ 0)");
    expect(bodyOf(program, "go")).toContain("Shape_area(");
    expect(bodyOf(program, "go")).toContain("Circle_area(");
  });

  itNative("reads a property through a getter", () => {
    expectMatchesInterpreter(
      [...GAUGE, "fn go(a: int) -> int:", "  return Gauge(a).scaled"],
      "go",
      [7],
    );
  });

  itNative("writes a property through a setter", () => {
    expectMatchesInterpreter(
      [
        ...GAUGE,
        "fn go(a: int) -> int:",
        "  g = Gauge(a)",
        "  g.scaled = 250",
        "  return g.raw",
      ],
      "go",
      [7],
    );
  });

  it("calls the getter instead of loading a field at an offset", () => {
    const program = compile([...GAUGE, "fn go(a: int) -> int:", "  return Gauge(a).scaled"]);

    expect(bodyOf(program, "go")).toContain("Gauge_get_scaled(");
  });

  it("gives the setter the receiver and the written value", () => {
    const program = compile([
      ...GAUGE,
      "fn go(a: int) -> int:",
      "  g = Gauge(a)",
      "  g.scaled = 250",
      "  return g.raw",
    ]);

    expect(cSource(program)).toContain("void Gauge_set_scaled(unsigned char *p0, int32_t p1)");
  });

  itNative("dispatches a getter to the receivers own implementation", () => {
    expectMatchesInterpreter(
      [...SIZED, "fn go(a: int) -> int:", "  s = Sized(a)", "  return s.width"],
      "go",
      [7],
    );
  });

  itNative("dispatches the same getter site to an overriding subclass", () => {
    expectMatchesInterpreter(
      [...SIZED, "fn go(a: int) -> int:", "  w = Wide(a)", "  return w.width"],
      "go",
      [7],
    );
  });

  it("tests the shape id when a getter site is polymorphic", () => {
    const program = compile([
      ...SIZED,
      "fn go(a: int) -> int:",
      "  s = Sized(a)",
      "  return s.width",
    ]);

    expect(bodyOf(program, "go")).toContain("Sized_get_width(");
    expect(bodyOf(program, "go")).toContain("Wide_get_width(");
  });

  itNative("calls a static method on the class itself", () => {
    expectMatchesInterpreter(
      [
        "class M:",
        "  public constructor(v: int):",
        "    this.v = v",
        "  public static twice(n: int) -> int:",
        "    return n * 2",
        "fn go(a: int) -> int:",
        "  return M.twice(a)",
      ],
      "go",
      [21],
    );
  });

  it("calls a static method without passing a receiver", () => {
    const program = compile([
      "class M:",
      "  public constructor(v: int):",
      "    this.v = v",
      "  public static twice(n: int) -> int:",
      "    return n * 2",
      "fn go(a: int) -> int:",
      "  return M.twice(a)",
    ]);

    expect(cSource(program)).toContain("int32_t M_static_twice(int32_t p0)");
    expect(bodyOf(program, "go")).toContain("M_static_twice(p0)");
  });

  itNative("inherits a static method from the parent class", () => {
    expectMatchesInterpreter(
      [
        "class Base:",
        "  public constructor(v: int):",
        "    this.v = v",
        "  public static twice(n: int) -> int:",
        "    return n * 2",
        "class Derived extends Base:",
        "  public constructor(v: int):",
        "    super(v)",
        "fn go(a: int) -> int:",
        "  return Derived.twice(a)",
      ],
      "go",
      [21],
    );
  });

  itNative("calls the parent implementation through super", () => {
    expectMatchesInterpreter(
      [
        "class A:",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public size() -> int:",
        "    return this.n",
        "class B extends A:",
        "  public constructor(n: int):",
        "    super(n)",
        "  public size() -> int:",
        "    return super.size() + 1",
        "fn go(a: int) -> int:",
        "  return B(a).size()",
      ],
      "go",
      [6],
    );
  });

  it("binds a super call to the parent implementation rather than dispatching", () => {
    const program = compile([
      "class A:",
      "  public constructor(n: int):",
      "    this.n = n",
      "  public size() -> int:",
      "    return this.n",
      "class B extends A:",
      "  public constructor(n: int):",
      "    super(n)",
      "  public size() -> int:",
      "    return super.size() + 1",
      "fn go(a: int) -> int:",
      "  return B(a).size()",
    ]);

    expect(bodyOf(program, "B_size")).toContain("A_size(p0)");
  });

  itNative("round-trips a static field through the module datum", () => {
    expectMatchesInterpreter(
      [
        "class Tally:",
        "  public static total: int = 0",
        "  public constructor(v: int):",
        "    this.v = v",
        "fn go(a: int) -> int:",
        "  Tally.total = a",
        "  Tally.total = Tally.total + a",
        "  return Tally.total",
      ],
      "go",
      [5],
    );
  });

  it("addresses a static field off the statics block rather than an instance", () => {
    const program = compile([
      "class Tally:",
      "  public static total: int = 0",
      "  public constructor(v: int):",
      "    this.v = v",
      "fn go(a: int) -> int:",
      "  Tally.total = a",
      "  return Tally.total",
    ]);

    expect(bodyOf(program, "go")).toContain("= (unsigned char *)&tera_statics;");
    expect(bodyOf(program, "go")).not.toContain("tera_alloc(");
  });

  itNative("gives two classes separate storage for a static field of the same name", () => {
    expectMatchesInterpreter(
      [
        "class Left:",
        "  public static slot: int = 0",
        "  public constructor(v: int):",
        "    this.v = v",
        "class Right:",
        "  public static slot: int = 0",
        "  public constructor(v: int):",
        "    this.v = v",
        "fn go(a: int) -> int:",
        "  Left.slot = a",
        "  Right.slot = a * 3",
        "  return Right.slot - Left.slot",
      ],
      "go",
      [5],
    );
  });

  itNative("passes a constructor argument by name", () => {
    expectMatchesInterpreter(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(y=b, x=a)", "  return p.x - p.y"],
      "go",
      [3, 4],
    );
  });

  itNative("passes a super constructor argument by name", () => {
    expectMatchesInterpreter(
      [
        "class Shape:",
        "  public constructor(n: int):",
        "    this.n = n",
        "class Circle extends Shape:",
        "  public constructor(r: int):",
        "    super(n=r)",
        "  public area() -> int:",
        "    return this.n * 2",
        "fn go(a: int) -> int:",
        "  return Circle(a).area()",
      ],
      "go",
      [6],
    );
  });

  itNative("passes a method argument by name", () => {
    expectMatchesInterpreter(
      [...POINT, "fn go(a: int, b: int) -> int:", "  return Point(a, b).scaled(by=3)"],
      "go",
      [3, 4],
    );
  });

  itNative("passes a static method argument by name", () => {
    expectMatchesInterpreter(
      [
        "class M:",
        "  public constructor(v: int):",
        "    this.v = v",
        "  public static scale(n: int, by: int) -> int:",
        "    return n * by",
        "fn go(a: int) -> int:",
        "  return M.scale(by=3, n=a)",
      ],
      "go",
      [7],
    );
  });

  itNative("passes a plain function argument by name", () => {
    expectMatchesInterpreter(
      [
        "fn span(low: int, high: int) -> int:",
        "  return high - low",
        "fn go(a: int, b: int) -> int:",
        "  return span(high=b, low=a)",
      ],
      "go",
      [3, 10],
    );
  });

  itNative("reads a field off an instance held in an array", () => {
    expectMatchesInterpreter(
      [
        "class P:",
        "  public constructor(v: int):",
        "    this.v = v",
        "fn go(a: int) -> int:",
        "  xs = [P(a), P(a + 1)]",
        "  return xs[0].v * 10 + xs[1].v",
      ],
      "go",
      [3],
    );
  });

  it("holds instances in an array of pointers", () => {
    const program = compile([
      "class P:",
      "  public constructor(v: int):",
      "    this.v = v",
      "fn go(a: int) -> int:",
      "  xs = [P(a), P(a + 1)]",
      "  return xs[0].v",
    ]);

    expect(bodyOf(program, "go")).toContain("unsigned char *v");
    expect(bodyOf(program, "go")).toContain("[2] = {");
  });

  itNative("dispatches through an array holding two subclasses", () => {
    expectMatchesInterpreter(
      SHAPES.concat([
        "fn go(a: int) -> int:",
        "  xs = [Shape(a), Circle(a)]",
        "  return xs[0].area() + xs[1].area()",
      ]),
      "go",
      [7],
    );
  });

  itNative("walks an array of instances in a loop", () => {
    expectMatchesInterpreter(
      [
        "class P:",
        "  public constructor(v: int):",
        "    this.v = v",
        "fn go(a: int) -> int:",
        "  xs = [P(a), P(a + 1), P(a + 2)]",
        "  total = 0",
        "  i = 0",
        "  while i < 3:",
        "    total = total + xs[i].v",
        "    i = i + 1",
        "  return total",
      ],
      "go",
      [3],
    );
  });

  itNative("dispatches per element while walking instances with for-of", () => {
    const program = compile([
      "class Shape:",
      "  public constructor(n: int):",
      "    this.n = n",
      "  public area() -> int:",
      "    return this.n",
      "  public get label() -> int:",
      "    return this.n * 100",
      "class Square extends Shape:",
      "  public constructor(n: int):",
      "    super(n=n)",
      "  public area() -> int:",
      "    return super.area() * this.n",
      "  public static of(n: int) -> Square:",
      "    return Square(n)",
      "fn go(a: int) -> int:",
      "  total = 0",
      "  for s of [Shape(a), Square.of(a + 1)]:",
      "    total = total + s.area() + s.label",
      "  return total",
    ]);

    expect(runCFunction(cSource(program), "go", [3])).toBe(3 + 300 + 16 + 400);
  });

  itNative("returns from a method that declares no return value", () => {
    expectMatchesInterpreter(
      [
        "class Counter:",
        "  public constructor():",
        "    this.n = 0",
        "  public bump(by: int):",
        "    this.n = this.n + by",
        "fn go(a: int) -> int:",
        "  c = Counter()",
        "  c.bump(a)",
        "  c.bump(a)",
        "  return c.n",
      ],
      "go",
      [4],
    );
  });

  itNative("constructs a subclass that declares no constructor", () => {
    expectMatchesInterpreter(
      [...INHERITED, "fn go(a: int) -> int:", "  return Leaf(a).doubled()"],
      "go",
      [7],
    );
  });

  itNative("carries the parent constructor down two levels of silent subclasses", () => {
    expectMatchesInterpreter(
      [
        ...INHERITED,
        "class Deep extends Leaf:",
        "  public tripled() -> int:",
        "    return this.n * 3",
        "fn go(a: int) -> int:",
        "  d = Deep(a)",
        "  return d.size() + d.doubled() + d.tripled()",
      ],
      "go",
      [7],
    );
  });

  itNative("applies a parent default through an inherited constructor", () => {
    expectMatchesInterpreter(
      [
        "class Base:",
        "  public constructor(n: int = 4):",
        "    this.n = n",
        "  public size() -> int:",
        "    return this.n",
        "class Leaf extends Base:",
        "  public get twice() -> int:",
        "    return this.n * 2",
        "fn go(a: int) -> int:",
        "  return Leaf().twice + Leaf(a).size()",
      ],
      "go",
      [9],
    );
  });

  itNative("initializes the fields of a subclass that declares no constructor", () => {
    expectMatchesInterpreter(
      [
        ...INHERITED,
        "class Tagged extends Base:",
        "  public tag: int = 5",
        "  public total() -> int:",
        "    return this.n + this.tag",
        "fn go(a: int) -> int:",
        "  return Tagged(a).total()",
      ],
      "go",
      [7],
    );
  });

  itNative("dispatches over a subclass that declares no constructor", () => {
    expectMatchesInterpreter(
      [
        "class Base:",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public area() -> int:",
        "    return this.n",
        "class Leaf extends Base:",
        "  public area() -> int:",
        "    return this.n * 10",
        "fn go(a: int) -> int:",
        "  total = 0",
        "  for s of [Base(a), Leaf(a)]:",
        "    total = total + s.area()",
        "  return total",
      ],
      "go",
      [7],
    );
  });
});
