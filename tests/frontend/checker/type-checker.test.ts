import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { checkProgram } from "../../../src/frontend/checker/index.js";
import { astToSemanticProgram } from "../../../src/frontend/checker/semantic-lowering.js";
import {
  NodeType,
  astChildren,
  declaredParamInfo,
  type ASTNode,
} from "../../../src/frontend/ast/index.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

interface RecordedSignature {
  readonly params: ReadonlyArray<string | undefined>;
  readonly returns: string | undefined;
}

function checked(source: string): { ast: ASTNode; messages: string[] } {
  const ast = parse(source, {});
  const { diagnostics } = checkProgram(astToSemanticProgram(ast), { mode: "strict" });
  return { ast, messages: diagnostics.map((entry) => entry.message) };
}

const diagnose = (source: string): string[] => checked(source).messages;

function functionLiterals(node: ASTNode, found: ASTNode[] = []): ASTNode[] {
  if (node.type === NodeType.ArrowFunctionExpression) found.push(node);
  for (const child of astChildren(node)) functionLiterals(child, found);
  return found;
}

function signatures(source: string): RecordedSignature[] {
  const { ast } = checked(source);
  return functionLiterals(ast).map((node) => ({
    params: (declaredParamInfo(node) ?? []).map((entry) => entry.type),
    returns: typeof node._returnType === "string" ? node._returnType : undefined,
  }));
}

describe("contextual lambda signatures", () => {
  it("types a lambda parameter from the declared variable type", () => {
    expect(signatures(src("inc: (int) -> int = n => n + 1", "print(inc(4))"))).toEqual([
      { params: ["int"], returns: "int" },
    ]);
  });

  it("types a lambda parameter from the parameter it is passed to", () => {
    const source = src(
      "fn apply(f: (int) -> int, x: int) -> int:",
      "  return f(x)",
      "print(apply(n => n + 1, 4))",
    );
    expect(signatures(source)).toEqual([{ params: ["int"], returns: "int" }]);
  });

  it("types a returned lambda from the declared return type", () => {
    const source = src(
      "fn make(base: int) -> (int) -> int:",
      "  return n => n + base",
      "print(make(3)(4))",
    );
    expect(signatures(source)).toEqual([{ params: ["int"], returns: "int" }]);
  });

  it("accepts a returned lambda that matches the declared return type", () => {
    const source = src("fn make(base: int) -> (int) -> int:", "  return n => n + base");
    expect(diagnose(source)).toEqual([]);
  });

  it("reports a returned lambda whose result does not match", () => {
    const source = src("fn make() -> (int) -> int:", '  return n => "text"');
    expect(diagnose(source)).toEqual([
      "Type 'string' is not assignable to return type 'int'",
    ]);
  });

  it("keeps the annotation the lambda spells out itself", () => {
    const source = src("inc: (float) -> float = (n: int) => n + 1.0", "print(inc(4.0))");
    expect(signatures(source)[0]?.params).toEqual(["int"]);
  });

  it("types nested lambdas through a curried return type", () => {
    const source = src(
      "fn add(a: int) -> (int) -> (int) -> int:",
      "  return b => c => a + b + c",
    );
    expect(signatures(source)).toEqual([
      { params: ["int"], returns: "(int) -> int" },
      { params: ["int"], returns: "int" },
    ]);
  });

  it("accepts a curried lambda that matches the declared return type", () => {
    const source = src(
      "fn outer(a: int) -> (int) -> (int) -> int:",
      "  return b => c => a + b + c",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("accepts a curried lambda that spells its own parameter types out", () => {
    const source = src(
      "fn outer(a: int) -> (int) -> (int) -> int:",
      "  return (b: int) => (c: int) => a + b + c",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("types a lambda inside an array literal from the declared element type", () => {
    expect(diagnose(src("fs: ((int) -> int)[] = [n => n + 1]"))).toEqual([]);
    expect(signatures(src("fs: ((int) -> int)[] = [n => n + 1]"))).toEqual([
      { params: ["int"], returns: "int" },
    ]);
  });

  it("points at the lambda in an array literal whose result does not match", () => {
    expect(diagnose(src('fs: ((int) -> int)[] = [n => "text"]'))).toEqual([
      "Type 'string' is not assignable to return type 'int'",
    ]);
  });

  it("lets a lambda with a declared function type call itself", () => {
    expect(diagnose(src("fact: (int) -> int = n => n < 2 ? 1 : n * fact(n - 1)"))).toEqual([]);
  });

  it("still reports a name a declaration without a function type cannot see yet", () => {
    expect(diagnose(src("n: int = n + 1"))).toEqual(["undefined name 'n'"]);
  });

  it("records nothing when the lambda has no contextual type", () => {
    expect(signatures(src("inc = n => n + 1", "print(inc(4))"))).toEqual([
      { params: [], returns: undefined },
    ]);
  });

  it("leaves the return type open when the context returns nothing useful", () => {
    const source = src("fn run(f: (int) -> void, x: int) -> void:", "  f(x)", "run(n => print(n), 1)");
    expect(signatures(source)[0]?.returns).toBeUndefined();
  });

  it("types the parameter even when the body is a block", () => {
    const source = src(
      "fn apply(f: (int) -> int, x: int) -> int:",
      "  return f(x)",
      "print(apply(n => n * 2, 4))",
    );
    expect(signatures(source)[0]?.params).toEqual(["int"]);
  });
});

describe("switch subjects and case labels", () => {
  const switchOn = (declared: string, label: string, value: string) =>
    src(
      `fn name(v: ${declared}) -> string:`,
      "  switch v:",
      `    case ${label}:`,
      '      return "hit"',
      "    default:",
      '      return "miss"',
      `print(name(${value}))`,
    );

  it("accepts an int subject", () => {
    expect(diagnose(switchOn("int", "1", "1"))).toEqual([]);
  });

  it("accepts a string subject", () => {
    expect(diagnose(switchOn("string", '"a"', '"a"'))).toEqual([]);
  });

  it("accepts a float subject", () => {
    expect(diagnose(switchOn("float", "1.5", "1.5"))).toEqual([]);
  });

  it("accepts a bool subject", () => {
    expect(diagnose(switchOn("bool", "true", "true"))).toEqual([]);
  });

  it("reports a case label that can never equal the subject", () => {
    expect(diagnose(switchOn("int", '"a"', "1"))).toEqual([
      "Type 'string' is not comparable to switch subject type 'int'",
    ]);
  });

  it("says nothing about a subject whose type is unknown", () => {
    const source = src(
      "fn name(v) -> string:",
      "  switch v:",
      "    case 1:",
      '      return "hit"',
      "  return \"miss\"",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("still checks the statements inside a case", () => {
    const source = src(
      "fn name(v: int) -> string:",
      "  switch v:",
      "    case 1:",
      "      n: int = \"text\"",
      "      return \"hit\"",
      "  return \"miss\"",
    );
    expect(diagnose(source)).toEqual(["Type 'string' is not assignable to 'int'"]);
  });

  it("still checks the subject expression itself", () => {
    const source = src(
      "fn name(v: int) -> string:",
      "  switch missing:",
      "    case 1:",
      '      return "hit"',
      "  return \"miss\"",
    );
    expect(diagnose(source)).toEqual(["undefined name 'missing'"]);
  });

  it("keeps requiring a bool for an if condition", () => {
    const source = src("fn f(v: int) -> int:", "  if v:", "    return 1", "  return 0");
    expect(diagnose(source)).toEqual([
      "Type 'int' is not assignable to condition type 'bool'",
    ]);
  });

  it("keeps requiring a bool for a while condition", () => {
    const source = src("fn f(v: int) -> int:", "  while v:", "    return 1", "  return 0");
    expect(diagnose(source)).toEqual([
      "Type 'int' is not assignable to condition type 'bool'",
    ]);
  });
});

describe("collection iteration", () => {
  it("accepts iterating a set directly", () => {
    expect(diagnose(src("s = Set()", "s.add(1)", "for v of s:", "  print(v)"))).toEqual([]);
  });

  it("accepts iterating a map directly", () => {
    expect(diagnose(src("m = Map()", 'm.set("a", 1)', "for e of m:", "  print(e)"))).toEqual([]);
  });

  it("still rejects iterating something that is not a sequence", () => {
    expect(diagnose(src("n: int = 1", "for v of n:", "  print(v)"))).toEqual([
      "Type 'int' is not iterable",
    ]);
  });
});

describe("spread arguments", () => {
  it("lets a spread stand in for the parameters it fills", () => {
    const source = src(
      "fn add(a: int, b: int) -> int:",
      "  return a + b",
      "xs: int[] = [1, 2]",
      "print(add(...xs))",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("reports a spread whose elements do not fit the parameters", () => {
    const source = src(
      "fn add(a: int, b: int) -> int:",
      "  return a + b",
      'xs: string[] = ["a"]',
      "print(add(...xs))",
    );
    expect(diagnose(source)).toEqual([
      "Type 'string' is not assignable to parameter 'a: int'",
      "Type 'string' is not assignable to parameter 'b: int'",
    ]);
  });

  it("still reports spreading something that is not iterable", () => {
    const source = src(
      "fn add(a: int, b: int) -> int:",
      "  return a + b",
      "n: int = 1",
      "print(add(...n))",
    );
    expect(diagnose(source)).toEqual(["Type 'int' is not iterable"]);
  });

  it("gathers a spread into a rest parameter", () => {
    const source = src(
      "fn total(...ns: int) -> int:",
      "  return 0",
      "xs: int[] = [1, 2]",
      "print(total(...xs))",
    );
    expect(diagnose(source)).toEqual([]);
  });
});

describe("nullable narrowing", () => {
  const NODE = [
    "class Node:",
    "  public value: int",
    "  public next: Node | null",
    "  public constructor(value: int, next: Node | null):",
    "    this.value = value",
    "    this.next = next",
  ];

  const reads = (...body: string[]) =>
    src(...NODE, "fn f(n: Node | null) -> int:", ...body);

  it("reads a member after a guard that returns", () => {
    expect(diagnose(reads("  if n == null:", "    return 0", "  return n.value"))).toEqual([]);
  });

  it("reads a member after a guard that throws", () => {
    expect(
      diagnose(reads("  if n == null:", '    throw Error("empty")', "  return n.value")),
    ).toEqual([]);
  });

  it("reads a member after a guard that continues", () => {
    const source = src(
      ...NODE,
      "fn f(ns: (Node | null)[]) -> int:",
      "  total: int = 0",
      "  for n of ns:",
      "    if n == null:",
      "      continue",
      "    total += n.value",
      "  return total",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("reads a member in the else branch of a null check", () => {
    expect(
      diagnose(reads("  if n == null:", "    return 0", "  else:", "    return n.value")),
    ).toEqual([]);
  });

  it("reads a member in an else branch that no arm exits through", () => {
    const source = reads(
      "  total: int = 0",
      "  if n == null:",
      "    total = 0",
      "  else:",
      "    total = n.value",
      "  return total",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("hands the last arm of an else-if chain every earlier refutation", () => {
    const source = src(
      ...NODE,
      "fn f(a: Node | null, b: Node | null) -> int:",
      "  if a == null:",
      "    return 0",
      "  else if b == null:",
      "    return a.value",
      "  return a.value + b.value",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("carries narrowing through a run of guards", () => {
    const source = src(
      ...NODE,
      "fn f(a: Node | null, b: Node | null) -> int:",
      "  if a == null:",
      "    return 0",
      "  if b == null:",
      "    return a.value",
      "  return a.value + b.value",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("narrows a nullable string the same way it narrows a class", () => {
    const source = src(
      "fn f(s: string | null) -> int:",
      "  if s == null:",
      "    return 0",
      "  return s.length",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("keeps narrowing for the statements after a guard at the top level", () => {
    const source = src(
      ...NODE,
      "n: Node | null = Node(1, null)",
      "if n == null:",
      '  print("none")',
      "else:",
      "  print(n.value)",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("lets an assignment widen a narrowed binding back to its declared type", () => {
    const source = reads(
      "  if n == null:",
      "    return 0",
      "  n = n.next",
      "  if n == null:",
      "    return 1",
      "  return n.value",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("narrows a binding to what the assignment just gave it", () => {
    expect(
      diagnose(
        src(
          "class Box:",
          "  public constructor(v: int):",
          "    this.v = v",
          "fn read() -> int:",
          "  b = null",
          "  b = Box(3)",
          "  return b.v",
        ),
      ),
    ).toEqual([]);
  });

  it("joins what the branches leave behind", () => {
    expect(
      diagnose(
        src(
          "class Box:",
          "  public constructor(v: int):",
          "    this.v = v",
          "held = null",
          "fn read() -> int:",
          "  if held == null:",
          "    held = Box(3)",
          "  return held.v",
        ),
      ),
    ).toEqual([]);
  });

  it("reads a member after a branch that assigns and one that returns", () => {
    expect(
      diagnose(reads("  if n == null:", "    return 0", "  else:", "    n = n.next", "  return n.value")),
    ).toEqual([]);
  });

  it("still refuses a member the branches leave nullable", () => {
    expect(
      diagnose(reads("  if n == null:", "    return 0", "  else:", "    n = n.next", "  return n.next.value")),
    ).toEqual(["Cannot access member 'value' on nullable type 'Node | null'"]);
  });

  it("still reports a member read when the guard does not exit", () => {
    expect(diagnose(reads("  if n == null:", '    print("empty")', "  return n.value"))).toEqual([
      "Cannot access member 'value' on nullable type 'Node | null'",
    ]);
  });

  it("still reports a member read inside the branch where the value is null", () => {
    expect(diagnose(reads("  if n == null:", "    return n.value", "  return 0"))).toEqual([
      "Cannot access member 'value' on nullable type 'null'",
    ]);
  });

  it("leaves a loop condition alone, since a break can leave it true", () => {
    const source = reads(
      "  while n != null:",
      "    if n.value > 0:",
      "      break",
      "    return 0",
      "  return n.value",
    );
    expect(diagnose(source)).toEqual([
      "Cannot access member 'value' on nullable type 'Node | null'",
    ]);
  });
});

describe("taking one element after a guard that the array holds some", () => {
  const takes = (guard: string, member: string) =>
    src(
      'queue: string[] = ["a", "b"]',
      guard,
      `  item: string = queue.${member}()`,
      "  print(item)",
    );

  it("takes the front of a queue a while loop guards", () => {
    expect(diagnose(takes("while queue.length > 0:", "shift"))).toEqual([]);
  });

  it("takes the back of a stack a while loop guards", () => {
    expect(diagnose(takes("while queue.length != 0:", "pop"))).toEqual([]);
  });

  it("takes one under a guard written the other way round", () => {
    expect(diagnose(takes("while 0 < queue.length:", "shift"))).toEqual([]);
  });

  it("takes one under a guard that asks for at least one", () => {
    expect(diagnose(takes("while queue.length >= 1:", "shift"))).toEqual([]);
  });

  it("takes one under a guard that asks for more than one", () => {
    expect(diagnose(takes("if queue.length > 1:", "pop"))).toEqual([]);
  });

  it("takes one in the arm where an emptiness guard did not hold", () => {
    const source = src(
      'queue: string[] = ["a"]',
      "if queue.length == 0:",
      '  print("empty")',
      "else:",
      "  item: string = queue.shift()",
      "  print(item)",
    );

    expect(diagnose(source)).toEqual([]);
  });

  it("takes one under a guard that also checks something else", () => {
    const source = src(
      'queue: string[] = ["a"]',
      "rounds = 0",
      "while queue.length > 0 and rounds < 3:",
      "  item: string = queue.shift()",
      "  rounds = rounds + 1",
      "  print(item)",
    );

    expect(diagnose(source)).toEqual([]);
  });

  it("takes one off a field the method guarded", () => {
    const source = src(
      "class Queue:",
      "  public items: string[]",
      "  public constructor():",
      "    this.items = []",
      "  public take() -> string:",
      "    if this.items.length == 0:",
      '      return ""',
      "    first: string = this.items.shift()",
      "    return first",
      "print(Queue().take())",
    );

    expect(diagnose(source)).toEqual([]);
  });

  it("still refuses to take one with nothing guarding the array", () => {
    const source = src('queue: string[] = ["a"]', "item: string = queue.shift()", "print(item)");

    expect(diagnose(source)).toEqual([
      "Type 'string | undefined' is not assignable to 'string'",
    ]);
  });

  it("still refuses to take one when the guard counts another array", () => {
    const source = src(
      'queue: string[] = ["a"]',
      'other: string[] = ["b"]',
      "while other.length > 0:",
      "  item: string = queue.shift()",
      "  print(item)",
    );

    expect(diagnose(source)).toEqual([
      "Type 'string | undefined' is not assignable to 'string'",
    ]);
  });

  it("still refuses to take one when the guard says the array is empty", () => {
    const source = src(
      'queue: string[] = ["a"]',
      "if queue.length == 0:",
      "  item: string = queue.shift()",
      "  print(item)",
    );

    expect(diagnose(source)).toEqual([
      "Type 'string | undefined' is not assignable to 'string'",
    ]);
  });
});

describe("names that a built-in already has", () => {
  it("refuses a top-level name the program still calls as a built-in", () => {
    expect(diagnose(src("sum = 5", "print(sum([1, 2]))"))).toEqual([
      "Cannot redeclare built-in 'sum'",
    ]);
  });

  it("refuses a name a class field still calls as a built-in", () => {
    expect(
      diagnose(src("sum = 5", "class Totals:", "  held = sum([1, 2])", "print(Totals())")),
    ).toContain("Cannot redeclare built-in 'sum'");
  });

  it("refuses a name a class member still calls as a built-in", () => {
    expect(
      diagnose(
        src(
          "sum = 5",
          "class Totals:",
          "  public constructor():",
          "    this.held = sum([1, 2])",
          "print(Totals())",
        ),
      ),
    ).toContain("Cannot redeclare built-in 'sum'");
  });

  it("lets a top-level name shadow a built-in nothing calls", () => {
    expect(diagnose(src("stack = 5", "print(stack)"))).toEqual([]);
  });

  it("lets a function keep a local of the same name", () => {
    expect(
      diagnose(src("fn total() -> float:", "  sum: float = 1.5", "  return sum", "print(total())")),
    ).toEqual([]);
  });

  it("lets a method keep a local of the same name", () => {
    expect(
      diagnose(
        src(
          "class Cart:",
          "  public total() -> float:",
          "    sum: float = 2.5",
          "    return sum",
          "print(Cart().total())",
        ),
      ),
    ).toEqual([]);
  });
});

describe("a field that starts out null", () => {
  it("takes what a later assignment gives it", () => {
    expect(
      diagnose(
        src(
          "class Task:",
          "  public constructor(title: string):",
          "    this.title = title",
          "    this.tag = null",
          "  public label(tag: string) -> void:",
          "    this.tag = tag",
          't = Task("write")',
          't.tag = "work"',
          "print(t.tag)",
        ),
      ),
    ).toEqual([]);
  });

  it("reads through a field another object assigns", () => {
    expect(
      diagnose(
        src(
          "class Node:",
          "  public constructor(value: int):",
          "    this.value = value",
          "    this.next = null",
          "head = Node(1)",
          "head.next = Node(2)",
          "print(head.next.value)",
        ),
      ),
    ).toEqual([]);
  });

  it("keeps a declared field type as declared", () => {
    expect(
      diagnose(
        src(
          "class Holder:",
          "  public slot: int = 0",
          "  public constructor():",
          '    this.slot = "text"',
          "print(Holder().slot)",
        ),
      ),
    ).toEqual(["Type 'string' is not assignable to 'int'"]);
  });
});

describe("an index that is not a whole number", () => {
  it("names the remedy for a division used as an index", () => {
    expect(
      diagnose(src("xs = [1, 2, 3, 4]", "mid = (0 + 3) / 2", "print(xs[mid])")),
    ).toEqual([
      "Type 'float' is not assignable to index type 'int' (a division answers a float: wrap it in Math.floor)",
    ]);
  });
});

describe("an array field with nothing in it yet", () => {
  it("takes its element type from what the class pushes", () => {
    expect(
      diagnose(
        src(
          "class Log:",
          "  public constructor():",
          "    this.lines = []",
          "  public add(line: string) -> void:",
          "    this.lines.push(line)",
          "l = Log()",
          'l.add("hi")',
          "n: int = l.lines",
        ),
      ),
    ).toEqual(["Type 'string[]' is not assignable to 'int'"]);
  });

  it("joins what several pushes give it", () => {
    expect(
      diagnose(
        src(
          "class Mixed:",
          "  public constructor():",
          "    this.values = []",
          "  public keep(n: int, x: float) -> void:",
          "    this.values.push(n)",
          "    this.values.push(x)",
          "m = Mixed()",
          "s: string = m.values",
        ),
      ),
    ).toEqual(["Type 'float[]' is not assignable to 'string'"]);
  });

  it("leaves a declared element type alone", () => {
    expect(
      diagnose(
        src(
          "class Fixed:",
          "  public names: string[] = []",
          "  public keep(name: string) -> void:",
          "    this.names.push(name)",
          "n: int = Fixed().names",
        ),
      ),
    ).toEqual(["Type 'string[]' is not assignable to 'int'"]);
  });
});

describe("a field the class only ever sets to null", () => {
  it("stays open for what the rest of the program puts in it", () => {
    expect(
      diagnose(
        src(
          "class Node:",
          "  public constructor(value: int):",
          "    this.value = value",
          "    this.next = null",
          "head = Node(1)",
          "head.next = Node(2)",
          "print(head.next.value)",
        ),
      ),
    ).toEqual([]);
  });

  it("keeps a declared nullable field as declared", () => {
    expect(
      diagnose(
        src(
          "class Holder:",
          "  public slot: int | null = null",
          "  public constructor():",
          "    this.slot = null",
          'h = Holder()',
          'h.slot = "text"',
        ),
      ),
    ).toEqual(["Type 'string' is not assignable to 'int | null'"]);
  });
});

describe("an element type only the method bodies reveal", () => {
  it("takes the class a method pushes into the field", () => {
    expect(
      diagnose(
        src(
          "class Task:",
          "  public constructor(id: int):",
          "    this.id = id",
          "class Board:",
          "  public constructor():",
          "    this.tasks = []",
          "  public add(id: int) -> Task:",
          "    task = Task(id)",
          "    this.tasks.push(task)",
          "    return task",
          "b = Board()",
          "b.add(1)",
          "n: int = b.tasks",
        ),
      ),
    ).toEqual(["Type 'Task[]' is not assignable to 'int'"]);
  });

  it("fills a null field in from what the program stores there", () => {
    expect(
      diagnose(
        src(
          "class Task:",
          "  public constructor(id: int):",
          "    this.id = id",
          "    this.tag = null",
          "t = Task(1)",
          't.tag = "work"',
          "n: int = t.tag",
        ),
      ),
    ).toEqual(["Type 'string' is not assignable to 'int'"]);
  });
});

describe("a return the checker cannot type", () => {
  it("leaves a value it could not tell the type of alone", () => {
    expect(
      diagnose(
        src(
          "class Registry:",
          "  public constructor():",
          "    this.byName = Map()",
          "  public register(name: string, factory: (int) -> int) -> void:",
          "    this.byName.set(name, factory)",
          "  public build(name: string, seed: int) -> int:",
          "    factory = this.byName.get(name)",
          "    return factory(seed)",
          "r = Registry()",
          'r.register("double", n => n * 2)',
          'print(r.build("double", 21))',
        ),
      ),
    ).toEqual([]);
  });

  it("still reports a return whose type it can tell", () => {
    expect(diagnose(src("fn one() -> int:", '  return "text"', "print(one())"))).toEqual([
      "Type 'string' is not assignable to return type 'int'",
    ]);
  });
});

describe("types the checker used to widen away", () => {
  it("keeps the element type when a nested array is flattened", () => {
    expect(diagnose(src("xs: int[][] = [[1], [2]]", "f: int[] = xs.flat()", "print(f.length)"))).toEqual([]);
  });

  it("flattens an array of text arrays to text", () => {
    expect(diagnose(src('xs: string[][] = [["a"]]', "f: string[] = xs.flat()", "print(f.length)"))).toEqual([]);
  });

  it("answers an array of the same element when one is reversed", () => {
    expect(diagnose(src("xs: int[] = [1]", "r: int[] = xs.reverse()", "print(r.length)"))).toEqual([]);
  });

  it("answers text when an array is joined", () => {
    expect(diagnose(src("xs: int[] = [1]", 's: string = xs.join("-")', "print(s)"))).toEqual([]);
  });

  it("keeps whole numbers whole through Math.min", () => {
    expect(diagnose(src("a: int = 3", "m: int = Math.min(a, 4)", "print(m)"))).toEqual([]);
  });

  it("keeps whole numbers whole through Math.max", () => {
    expect(diagnose(src("m: int = Math.max(3, 4, 5)", "print(m)"))).toEqual([]);
  });

  it("still widens Math.min when one argument is fractional", () => {
    expect(diagnose(src("m: int = Math.min(3, 4.5)", "print(m)"))).toEqual([
      "Type 'float' is not assignable to 'int'",
    ]);
  });

  it("walks what a generator yields", () => {
    expect(diagnose(src("fn* g() -> int:", "  yield 1", "for x of g():", "  print(x)"))).toEqual([]);
  });

  it("binds the loop variable to what the generator yields", () => {
    expect(
      diagnose(src("fn* g() -> string:", '  yield "a"', "for s of g():", "  t: string = s", "  print(t)")),
    ).toEqual([]);
  });

  it("still refuses a loop variable the generator does not yield", () => {
    expect(
      diagnose(src("fn* g() -> int:", "  yield 1", "for x of g():", "  s: string = x", "  print(s)")),
    ).toEqual(["Type 'int' is not assignable to 'string'"]);
  });

  it("accepts appending to text through concat", () => {
    expect(diagnose(src('a: string = "ab"', 'b: string = a.concat("cd")', "print(b)"))).toEqual([]);
  });
});
