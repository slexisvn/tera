import { describe, it, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";
import { cCalls } from "../../../helpers/aot-agreement.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";

const KEEPS_CALLS = compilerOptions("speed", { inlineBudget: 0 });

function dispatched(lines: readonly string[]) {
  const program = nodeEngine().compileAot(`${lines.join("\n")}\n`, {
    compilerOptions: KEEPS_CALLS,
  });
  expect(program.skipped).toEqual([]);
  return program;
}

function compile(lines: readonly string[]) {
  const program = nodeEngine().compileAot(`${lines.join("\n")}\n`);
  expect(program.skipped).toEqual([]);
  return program;
}

function interpret(lines: readonly string[], call: string): unknown {
  return nodeEngine().runNative(`${lines.join("\n")}\n${call}\n`);
}

const native = cCalls({
  toC: (lines: readonly string[]) => cSource(compile(lines)),
  interpret: (lines: readonly string[], call: string) => interpret(lines, call),
});

function bodyOf(program: { source: string }, symbol: string): string {
  const start = cSource(program).search(new RegExp(`^\\w[\\w *]*\\b${symbol}\\(`, "m"));
  expect(start).toBeGreaterThan(-1);
  return cSource(program).slice(start, cSource(program).indexOf("\n}", start));
}

const POINT = [
  "class Point:",
  "  public constructor(x: int, y: int):",
  "    this.x = x",
  "    this.y = y",
  "  public sum() -> int:",
  "    if this.x < 0:",
  "      return 0",
  "    return this.x + this.y",
  "  public scaled(by: int) -> int:",
  "    return this.x * by + this.y * by",
];

const SHAPES = [
  "class Shape:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public area() -> int:",
  "    if this.n < 0:",
  "      return 0",
  "    return this.n",
  "class Circle extends Shape:",
  "  public constructor(r: int):",
  "    super(r)",
  "  public area() -> int:",
  "    if this.n < 0:",
  "      return 0",
  "    return this.n * 2",
];

const INHERITED = [
  "class Base:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public size() -> int:",
  "    if this.n < 0:",
  "      return 0",
  "    return this.n",
  "class Leaf extends Base:",
  "  public doubled() -> int:",
  "    return this.n * 2",
];

const GAUGE = [
  "class Gauge:",
  "  public constructor(raw: float):",
  "    this.raw = raw",
  "  public get scaled() -> float:",
  "    if this.raw < 0.0:",
  "      return 0.0",
  "    return this.raw * 10",
  "  public set scaled(value: int):",
  "    this.raw = value / 10",
];

const SHAPED = [
  "interface Shaped:",
  "  area() -> int",
  "class Box implements Shaped:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public area() -> int:",
  "    if this.n < 0:",
  "      return 0",
  "    return this.n * this.n",
  "class Disc implements Shaped:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public area() -> int:",
  "    if this.n < 0:",
  "      return 0",
  "    return this.n * 3",
];

const STATES = [
  "class DraftState:",
  "  public publish(document: Document) -> int:",
  "    if document.n < 0:",
  "      return 0",
  "    document.state = PublishedState()",
  "    return 1",
  "class PublishedState:",
  "  public publish(document: Document) -> int:",
  "    if document.n < 0:",
  "      return 0",
  "    return 2",
  "class Document:",
  "  public constructor(n: int):",
  "    this.n = n",
  "    this.state = DraftState()",
  "  public publish() -> int:",
  "    return this.state.publish(this)",
];

const SIZED = [
  "class Sized:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public get width() -> int:",
  "    if this.n < 0:",
  "      return 0",
  "    return this.n",
  "class Wide extends Sized:",
  "  public constructor(n: int):",
  "    super(n)",
  "  public get width() -> int:",
  "    if this.n < 0:",
  "      return 0",
  "    return this.n * 3",
];

describe("AOT classes", () => {
  itNative("constructs an instance and reads a field back", native.matches(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(a, b)", "  return p.x"],
      "go",
      [3, 4],
    ));

  itNative("calls a method that reads two fields", native.matches(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(a, b)", "  return p.sum()"],
      "go",
      [3, 4],
    ));

  itNative("passes arguments to a method alongside the receiver", native.matches(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(a, b)", "  return p.scaled(3)"],
      "go",
      [3, 4],
    ));

  itNative("mutates a field through an assignment", native.matches(
      [
        ...POINT,
        "fn go(a: int, b: int) -> int:",
        "  p = Point(a, b)",
        "  p.x = p.x + 10",
        "  return p.sum()",
      ],
      "go",
      [3, 4],
    ));

  itNative("keeps two instances of the same class distinct", native.matches(
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
    ));

  itNative("constructs inside a loop without reusing storage", native.matches(
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
    ));

  itNative("keeps a float field in floating point", native.matches(
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
    ));

  itNative("runs a derived constructor through super", native.matches(
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
    ));

  itNative("overrides an inherited method", native.matches(
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
    ));

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

  itNative("reads a field through a field that holds another instance", native.matches(
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
    ));

  itNative("reads a field off an instance returned by a plain function", native.matches(
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
    ));

  itNative("chains a method that returns an instance", native.matches(
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
    ));

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
    const program = dispatched([
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
  itNative("dispatches a polymorphic call to the receivers own implementation", native.matches(SHAPES.concat([
      "fn go(a: int) -> int:",
      "  s = Shape(a)",
      "  return s.area()",
    ]), "go", [7]));

  itNative("dispatches the same call site to an overriding subclass", native.matches(SHAPES.concat([
      "fn go(a: int) -> int:",
      "  c = Circle(a)",
      "  return c.area()",
    ]), "go", [7]));

  it("tests the shape id in the object header when the call site is polymorphic", () => {
    const program = dispatched(SHAPES.concat([
      "fn measure(s: Shape) -> int:",
      "  return s.area()",
      "fn go(a: int) -> int:",
      "  return measure(Shape(a)) + measure(Circle(a))",
    ]));

    expect(bodyOf(program, "measure")).toContain("+ 0)");
    expect(bodyOf(program, "measure")).toContain("Shape_area(");
    expect(bodyOf(program, "measure")).toContain("Circle_area(");
  });

  it("calls the implementation directly when it can see the receiver allocated", () => {
    const program = dispatched(SHAPES.concat([
      "fn go(a: int) -> int:",
      "  s = Shape(a)",
      "  return s.area()",
    ]));

    expect(bodyOf(program, "go")).toContain("Shape_area(");
    expect(bodyOf(program, "go")).not.toContain("Circle_area(");
  });

  itNative("reads a property through a getter", native.matches(
      [...GAUGE, "fn go(a: int) -> float:", "  return Gauge(a).scaled"],
      "go",
      [7],
    ));

  itNative("writes a property through a setter", native.matches(
      [
        ...GAUGE,
        "fn go(a: int) -> float:",
        "  g = Gauge(a)",
        "  g.scaled = 250",
        "  return g.raw",
      ],
      "go",
      [7],
    ));

  it("calls the getter instead of loading a field at an offset", () => {
    const program = dispatched([...GAUGE, "fn go(a: int) -> float:", "  return Gauge(a).scaled"]);

    expect(bodyOf(program, "go")).toContain("Gauge_get_scaled(");
  });

  it("gives the setter the receiver and the written value", () => {
    const program = compile([
      ...GAUGE,
      "fn go(a: int) -> float:",
      "  g = Gauge(a)",
      "  g.scaled = 250",
      "  return g.raw",
    ]);

    expect(cSource(program)).toContain("void Gauge_set_scaled(unsigned char *p0, int32_t p1)");
  });

  itNative("dispatches a getter to the receivers own implementation", native.matches(
      [...SIZED, "fn go(a: int) -> int:", "  s = Sized(a)", "  return s.width"],
      "go",
      [7],
    ));

  itNative("dispatches the same getter site to an overriding subclass", native.matches(
      [...SIZED, "fn go(a: int) -> int:", "  w = Wide(a)", "  return w.width"],
      "go",
      [7],
    ));

  it("tests the shape id when a getter site is polymorphic", () => {
    const program = dispatched([
      ...SIZED,
      "fn measure(s: Sized) -> int:",
      "  return s.width",
      "fn go(a: int) -> int:",
      "  return measure(Sized(a)) + measure(Wide(a))",
    ]);

    expect(bodyOf(program, "measure")).toContain("Sized_get_width(");
    expect(bodyOf(program, "measure")).toContain("Wide_get_width(");
  });

  itNative("dispatches through a field to the class the field currently holds", native.matches(STATES.concat([
      "fn go(a: int) -> int:",
      "  d = Document(a)",
      "  return d.publish() * 100 + d.publish()",
    ]), "go", [7]));

  it("covers a class that only matches the receiver's surface", () => {
    const program = dispatched(STATES.concat([
      "fn go(a: int) -> int:",
      "  d = Document(a)",
      "  return d.publish()",
    ]));

    expect(bodyOf(program, "Document_publish")).toContain("DraftState_publish(");
    expect(bodyOf(program, "Document_publish")).toContain("PublishedState_publish(");
  });

  itNative("dispatches a call made through an interface typed value", native.matches(SHAPED.concat([
      "fn measure(s: Shaped) -> int:",
      "  return s.area()",
      "fn go(a: int) -> int:",
      "  return measure(Box(a)) * 100 + measure(Disc(a))",
    ]), "go", [7]));

  itNative("stores an interface typed value in a field and calls back through it", native.matches(SHAPED.concat([
      "class Holder:",
      "  public constructor(s: Shaped):",
      "    this.s = s",
      "  public measure() -> int:",
      "    return this.s.area()",
      "fn go(a: int) -> int:",
      "  return Holder(Disc(a)).measure()",
    ]), "go", [7]));

  it("names every implementation of the interface at the call site", () => {
    const program = dispatched(SHAPED.concat([
      "fn measure(s: Shaped) -> int:",
      "  return s.area()",
      "fn go(a: int) -> int:",
      "  return measure(Box(a)) + measure(Disc(a))",
    ]));

    expect(bodyOf(program, "measure")).toContain("Box_area(");
    expect(bodyOf(program, "measure")).toContain("Disc_area(");
  });

  itNative("calls a static method on the class itself", native.matches(
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
    ));

  it("calls a static method without passing a receiver", () => {
    const program = dispatched([
      "class M:",
      "  public constructor(v: int):",
      "    this.v = v",
      "  public static twice(n: int) -> int:",
      "    if n < 0:",
      "      return 0",
      "    return n * 2",
      "fn go(a: int) -> int:",
      "  return M.twice(a)",
    ]);

    expect(cSource(program)).toContain("int32_t M_static_twice(int32_t p0)");
    expect(bodyOf(program, "go")).toContain("M_static_twice(p0)");
  });

  itNative("inherits a static method from the parent class", native.matches(
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
    ));

  itNative("calls the parent implementation through super", native.matches(
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
    ));

  it("binds a super call to the parent implementation rather than dispatching", () => {
    const program = dispatched([
      "class A:",
      "  public constructor(n: int):",
      "    this.n = n",
      "  public size() -> int:",
      "    if this.n < 0:",
      "      return 0",
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

  itNative("round-trips a static field through the module datum", native.matches(
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
    ));

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

  itNative("gives two classes separate storage for a static field of the same name", native.matches(
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
    ));

  itNative("passes a constructor argument by name", native.matches(
      [...POINT, "fn go(a: int, b: int) -> int:", "  p = Point(y=b, x=a)", "  return p.x - p.y"],
      "go",
      [3, 4],
    ));

  itNative("passes a super constructor argument by name", native.matches(
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
    ));

  itNative("passes a method argument by name", native.matches(
      [...POINT, "fn go(a: int, b: int) -> int:", "  return Point(a, b).scaled(by=3)"],
      "go",
      [3, 4],
    ));

  itNative("passes a static method argument by name", native.matches(
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
    ));

  itNative("passes a plain function argument by name", native.matches(
      [
        "fn span(low: int, high: int) -> int:",
        "  return high - low",
        "fn go(a: int, b: int) -> int:",
        "  return span(high=b, low=a)",
      ],
      "go",
      [3, 10],
    ));

  itNative("reads a field off an instance held in an array", native.matches(
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
    ));

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
    expect(bodyOf(program, "go")).toContain("tera_alloc(");
  });

  itNative("dispatches through an array holding two subclasses", native.matches(
      SHAPES.concat([
        "fn go(a: int) -> int:",
        "  xs = [Shape(a), Circle(a)]",
        "  return xs[0].area() + xs[1].area()",
      ]),
      "go",
      [7],
    ));

  itNative("walks an array of instances in a loop", native.matches(
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
    ));

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

  itNative("returns from a method that declares no return value", native.matches(
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
    ));

  itNative("constructs a subclass that declares no constructor", native.matches(
      [...INHERITED, "fn go(a: int) -> int:", "  return Leaf(a).doubled()"],
      "go",
      [7],
    ));

  itNative("carries the parent constructor down two levels of silent subclasses", native.matches(
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
    ));

  itNative("applies a parent default through an inherited constructor", native.matches(
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
    ));

  itNative("initializes the fields of a subclass that declares no constructor", native.matches(
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
    ));

  itNative("dispatches over a subclass that declares no constructor", native.matches(
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
    ));
  itNative("initialises a declared field to the zero of its type", native.matches(
      [
        "class Counter:",
        "  public n: int",
        "  public constructor(start: int):",
        "    this.n = start",
        "  public step() -> int:",
        "    this.n = this.n + 1",
        "    return this.n",
        "fn go(start: int) -> int:",
        "  c = Counter(start)",
        "  c.step()",
        "  return c.step()",
      ],
      "go",
      [4],
    ));

  itNative("reaches a declared field through a class that owns another", native.matches(
      [
        "class Engine:",
        "  public hp: int",
        "  public constructor(hp: int):",
        "    this.hp = hp",
        "class Car:",
        "  public engine: Engine",
        "  public constructor(hp: int):",
        "    this.engine = Engine(hp)",
        "  public power() -> int:",
        "    return this.engine.hp",
        "fn go(hp: int) -> int:",
        "  return Car(hp).power()",
      ],
      "go",
      [300],
    ));

  itNative("reads a field through the interface a class conforms to", native.matches(
      [
        "interface Sized:",
        "  size: int",
        "class Box:",
        "  public size: int",
        "  public constructor(size: int):",
        "    this.size = size",
        "fn measure(s: Sized) -> int:",
        "  return s.size",
        "fn go(n: int) -> int:",
        "  return measure(Box(n))",
      ],
      "go",
      [12],
    ));
});
