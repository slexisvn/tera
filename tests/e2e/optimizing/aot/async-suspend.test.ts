import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";
import { AotLinkError } from "../../../../src/optimizing/drivers/aot.js";

const src = (...lines: string[]) => lines.join("\n");

const G = src("async fn g() -> int:", "  return 1");
const GS = src("async fn g() -> string:", '  return "gv"');
const F = src(
  "async fn f() -> int:",
  '  print("a")',
  "  x = await g()",
  '  print("b")',
  "  return x",
);
const CELL = src("class Cell:", "  public constructor(v: int):", "    this.v = v");
const BAD = src("fn bad() -> int:", '  throw "boom"', "  return 0");

function printedBy(source: string): readonly string[] {
  const printed: string[] = [];
  nodeEngine({ typecheck: "off", output: (line) => printed.push(line) }).runNative(
    `${source}\n`,
  );
  return printed;
}

function compiled(source: string) {
  return nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
}

function compiledToC(source: string) {
  return nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "source",
  });
}

function declined(source: string): string {
  try {
    const program = compiled(source);
    return program.skipped.map((entry) => entry.reason).join("; ");
  } catch (error) {
    if (error instanceof AotLinkError) return error.message;
    throw error;
  }
}

const MATCHES: ReadonlyArray<readonly [string, string]> = [
  [
    "two coroutines resume in the order they suspended",
    src(
      G,
      F,
      "async fn h() -> int:",
      '  print("h1")',
      "  y = await g()",
      '  print("h2")',
      "  return y",
      "p = f()",
      "q = h()",
      'print("mid")',
      "print(await p)",
      "print(await q)",
    ),
  ],
  [
    "a suspending function keeps its arguments across the suspend",
    src(
      "async fn g(v: int) -> int:",
      "  return v + 1",
      "async fn f(n: int) -> int:",
      "  x = await g(n)",
      "  return x",
      "p = f(4)",
      "print(await p)",
    ),
  ],
  [
    "a suspending function returning a float",
    src(
      "async fn g() -> float:",
      "  return 1.5",
      "async fn f() -> float:",
      "  x = await g()",
      "  return x",
      "p = f()",
      "print(await p)",
    ),
  ],
  [
    "a promise nobody awaits still runs before the program exits",
    src(G, F, "p = f()", 'print("c")'),
  ],
  [
    "two suspends in one function",
    src(
      G,
      "async fn f() -> int:",
      "  x = await g()",
      "  y = await g()",
      "  return x + y",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "three suspends interleave with the caller at every step",
    src(
      G,
      "async fn f() -> int:",
      '  print("a")',
      "  x = await g()",
      '  print("b")',
      "  y = await g()",
      '  print("c")',
      "  z = await g()",
      "  return x + y + z",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a suspend inside the taken arm of an if",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  if n > 0:",
      "    return await g()",
      "  return 0",
      "p = f(1)",
      "q = f(0)",
      'print("mid")',
      "print(await p)",
      "print(await q)",
    ),
  ],
  [
    "a value defined before an if is still live where the arms join",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  base = n * 3",
      "  if n > 0:",
      "    base = base + await g()",
      "  return base + 1",
      "p = f(2)",
      "q = f(0)",
      'print("mid")',
      "print(await p)",
      "print(await q)",
    ),
  ],
  [
    "both arms of an if suspend",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  if n > 0:",
      "    a = await g()",
      "    return a + 10",
      "  b = await g()",
      "  return b + 20",
      "p = f(1)",
      "q = f(0)",
      'print("mid")',
      "print(await p)",
      "print(await q)",
    ),
  ],
  [
    "a suspend inside a while loop",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + await g()",
      "    i = i + 1",
      "  return total",
      "p = f(3)",
      "q = f(0)",
      'print("mid")',
      "print(await p)",
      "print(await q)",
    ),
  ],
  [
    "suspends before, inside and after a loop",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  a = await g()",
      "  i = 0",
      "  while i < n:",
      "    a = a + await g()",
      "    i = i + 1",
      "  b = await g()",
      "  return a + b",
      "p = f(2)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a loop returns out of the middle of an iteration",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  i = 0",
      "  while i < 10:",
      "    x = await g()",
      "    if i == n:",
      "      return i * 100 + x",
      "    i = i + 1",
      "  return 0 - 1",
      "p = f(3)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "nested loops around a suspend",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    j = 0",
      "    while j < 2:",
      "      total = total + await g()",
      "      j = j + 1",
      "    i = i + 1",
      "  return total",
      "p = f(3)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "two suspends with parameters and a float result",
    src(
      "async fn g() -> float:",
      "  return 1.5",
      "async fn f(n: float) -> float:",
      "  x = await g()",
      "  y = await g()",
      "  return x + y + n",
      "p = f(0.25)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a string built across a suspend",
    src(
      G,
      "async fn f() -> string:",
      '  s = "left"',
      "  x = await g()",
      '  return s + "right"',
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a string a coroutine builds after it resumes",
    src(
      GS,
      "async fn f() -> string:",
      "  q = g()",
      "  x = await q",
      '  return x + "!"',
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a string promise awaited twice",
    src(
      GS,
      "async fn f() -> string:",
      "  q = g()",
      "  x = await q",
      "  y = await q",
      "  return x + y",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a string coroutine awaited directly twice",
    src(
      GS,
      "async fn f() -> string:",
      "  x = await g()",
      "  y = await g()",
      "  return x + y",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a string built from two awaits of a coroutine that suspends itself",
    src(
      GS,
      "async fn h(n: int) -> string:",
      "  x = await g()",
      "  return x + n.to_string()",
      "async fn f(n: int) -> string:",
      "  a = await h(n)",
      "  b = await h(n + 1)",
      "  return a + b",
      "p = f(1)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a string promise parked on a suspending callee",
    src(
      "async fn h() -> string:",
      '  return "deep"',
      "async fn g() -> string:",
      '  print("g1")',
      "  y = await h()",
      '  print("g2")',
      '  return y + "!"',
      "async fn f() -> string:",
      "  q = g()",
      "  x = await q",
      '  return x + "?"',
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a string built in a loop before the suspend",
    src(
      G,
      "async fn f(n: int) -> string:",
      '  s = ""',
      "  i = 0",
      "  while i < n:",
      '    s = s + "x"',
      "    i = i + 1",
      "  y = await g()",
      "  return s + y.to_string()",
      "p = f(3)",
      "q = f(0)",
      'print("mid")',
      "print(await p)",
      "print(await q)",
    ),
  ],
  [
    "a string built from every value a loop awaits",
    src(
      GS,
      "async fn f(n: int) -> string:",
      '  s = "s"',
      "  i = 0",
      "  while i < n:",
      "    s = s + await g()",
      "    i = i + 1",
      "  return s",
      "p = f(3)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "two coroutines with a string argument and a string result",
    src(
      G,
      "async fn f(tag: string) -> string:",
      "  x = await g()",
      "  return tag + x.to_string()",
      'p = f("a")',
      'r = f("b")',
      'print("mid")',
      "print(await p)",
      "print(await r)",
    ),
  ],
  [
    "two coroutines that each suspend twice",
    src(
      G,
      "async fn f(tag: int) -> int:",
      "  x = await g()",
      "  print(tag)",
      "  y = await g()",
      "  print(tag)",
      "  return x + y + tag",
      "p = f(10)",
      "q = f(20)",
      'print("mid")',
      "print(await p)",
      "print(await q)",
    ),
  ],
  [
    "an object read after the suspend that created it",
    src(
      CELL,
      G,
      "async fn f(n: int) -> int:",
      "  c = Cell(n)",
      "  x = await g()",
      "  return c.v + x",
      "p = f(6)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a suspending function in a program that catches a throw somewhere else",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  x = await g()",
      "  return x + n",
      "p = f(2)",
      "try:",
      '  throw "x"',
      "catch e:",
      "  print(e)",
      "print(await p)",
    ),
  ],
  [
    "a suspending function alongside another function that catches its own throw",
    src(
      G,
      "fn safe() -> int:",
      "  try:",
      '    throw "boom"',
      "  catch e:",
      "    return 9",
      "  return 0",
      "async fn f(n: int) -> int:",
      "  x = await g()",
      "  return x + n",
      "p = f(2)",
      "print(safe())",
      "print(await p)",
    ),
  ],
  [
    "a suspend inside a loop in a program that catches a throw somewhere else",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + await g()",
      "    i = i + 1",
      "  return total",
      "p = f(3)",
      "try:",
      '  throw "x"',
      "catch e:",
      "  print(e)",
      "print(await p)",
    ),
  ],
  [
    "nested loops around a suspend in a program that catches a throw somewhere else",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    j = 0",
      "    while j < 2:",
      "      total = total + await g()",
      "      j = j + 1",
      "    i = i + 1",
      "  return total",
      "p = f(3)",
      "try:",
      '  throw "x"',
      "catch e:",
      "  print(e)",
      "print(await p)",
    ),
  ],
  [
    "a coroutine that catches a throw from the function it calls",
    src(
      G,
      BAD,
      "async fn f() -> int:",
      "  x = await g()",
      "  try:",
      "    x = x + bad()",
      "  catch e:",
      "    print(e)",
      "  return x + 6",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a suspend inside a try block that catches nothing",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  try:",
      "    x = await g()",
      "    return x + n",
      "  catch e:",
      "    return 0 - 1",
      "p = f(1)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "an await of a value that is not a promise does not yield to the queue",
    src(
      "async fn f() -> int:",
      '  print("f1")',
      "  x = await 0",
      '  print("f2")',
      "  return x + 7",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a coroutine awaiting a promise it stored",
    src(
      G,
      "async fn f() -> int:",
      "  q = g()",
      "  x = await q",
      "  return x + 6",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a stored promise with prints on both sides of the await",
    src(
      G,
      "async fn f() -> int:",
      '  print("a")',
      "  q = g()",
      '  print("b")',
      "  x = await q",
      '  print("c")',
      "  return x + 6",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "two stored promises awaited in the order they were made",
    src(
      G,
      "async fn f() -> int:",
      "  q = g()",
      "  r = g()",
      "  x = await q",
      "  y = await r",
      "  return x + y + 5",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a stored promise from a coroutine that itself suspends",
    src(
      "async fn h() -> int:",
      "  return 1",
      "async fn g() -> int:",
      '  print("g1")',
      "  y = await h()",
      '  print("g2")',
      "  return y",
      "async fn f() -> int:",
      "  q = g()",
      "  x = await q",
      "  return x + 6",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "the same stored promise awaited twice",
    src(
      G,
      "async fn f() -> int:",
      "  q = g()",
      "  x = await q",
      "  y = await q",
      "  return x + y + 5",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a chain of four coroutines each awaiting the next",
    src(
      "async fn d() -> int:",
      "  return 1",
      "async fn c() -> int:",
      "  q = d()",
      "  return await q + 1",
      "async fn b() -> int:",
      "  q = c()",
      "  return await q + 1",
      "async fn a() -> int:",
      "  q = b()",
      "  return await q + 1",
      "p = a()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "two coroutines each parked on their own promise",
    src(
      G,
      "async fn f(tag: int) -> int:",
      "  q = g()",
      "  x = await q",
      "  print(tag)",
      "  return x + tag",
      "p = f(10)",
      "r = f(20)",
      'print("mid")',
      "print(await p)",
      "print(await r)",
    ),
  ],
  [
    "a stored promise awaited only after a loop",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  q = g()",
      "  i = 0",
      "  total = 0",
      "  while i < n:",
      "    total = total + i",
      "    i = i + 1",
      "  x = await q",
      "  return total + x",
      "p = f(4)",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a promise awaited inside one arm of an if",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  q = g()",
      "  if n > 0:",
      "    x = await q",
      "    return x + 100",
      "  return 0",
      "p = f(1)",
      "r = f(0)",
      'print("mid")',
      "print(await p)",
      "print(await r)",
    ),
  ],
  [
    "a top level promise stored before it is awaited",
    src(G, "q = g()", 'print("mid")', "print(await q)"),
  ],
  [
    "a collection while a frame is parked on a promise",
    src(
      CELL,
      "fn churn(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + Cell(i % 7).v",
      "    i = i + 1",
      "  return total",
      "async fn h() -> int:",
      "  return 1",
      "async fn g() -> int:",
      "  y = await h()",
      "  return y + 1",
      "async fn f(n: int) -> int:",
      "  c = Cell(n)",
      "  q = g()",
      "  x = await q",
      "  return c.v + x",
      "p = f(4)",
      "print(churn(300000))",
      "print(await p)",
    ),
  ],
  [
    "a collection while a frame is parked on a string promise",
    src(
      CELL,
      "fn churn(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + Cell(i % 7).v",
      "    i = i + 1",
      "  return total",
      "async fn h() -> string:",
      '  return "h"',
      "async fn g() -> string:",
      "  y = await h()",
      '  return y + "g"',
      "async fn f(n: int) -> string:",
      "  c = Cell(n)",
      "  q = g()",
      "  x = await q",
      "  return x + c.v.to_string()",
      "p = f(4)",
      "print(churn(300000))",
      "print(await p)",
    ),
  ],
  [
    "a collection while a frame is suspended part way through a loop",
    src(
      CELL,
      "fn churn(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + Cell(i % 7).v",
      "    i = i + 1",
      "  return total",
      G,
      "async fn f(n: int) -> int:",
      "  c = Cell(n)",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + c.v + await g()",
      "    i = i + 1",
      "  return total",
      "p = f(4)",
      "print(churn(300000))",
      "print(await p)",
    ),
  ],
  [
    "a coroutine that throws a value of its own past a suspend",
    src(
      G,
      "async fn f() -> int:",
      "  x = await g()",
      '  throw "boom"',
      "  return x",
      "p = f()",
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
    ),
  ],
  [
    "a coroutine whose callee throws past it",
    src(
      G,
      BAD,
      "async fn f() -> int:",
      "  x = await g()",
      "  return x + bad()",
      "p = f()",
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
    ),
  ],
  [
    "a rejection reaches the caller after everything either side printed",
    src(
      G,
      "async fn f() -> int:",
      '  print("f1")',
      "  x = await g()",
      '  print("f2")',
      '  throw "boom"',
      "  return x",
      "p = f()",
      'print("mid")',
      "try:",
      "  print(await p)",
      "catch e:",
      '  print("caught " + e)',
      'print("after")',
    ),
  ],
  [
    "the same rejected promise awaited twice",
    src(
      G,
      "async fn f() -> int:",
      "  x = await g()",
      '  throw "boom"',
      "  return x",
      "p = f()",
      "try:",
      "  print(await p)",
      "catch e:",
      '  print("c1 " + e)',
      "try:",
      "  print(await p)",
      "catch e:",
      '  print("c2 " + e)',
    ),
  ],
  [
    "a coroutine that catches the rejection of the coroutine it awaited",
    src(
      G,
      "async fn h() -> int:",
      "  x = await g()",
      '  throw "deep"',
      "  return x",
      "async fn f() -> int:",
      "  q = h()",
      "  try:",
      "    x = await q",
      "    return x",
      "  catch e:",
      '    print("f caught " + e)',
      "  return 5",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a rejection that crosses two coroutines uncaught in the middle",
    src(
      G,
      "async fn h() -> int:",
      "  x = await g()",
      '  throw "deep"',
      "  return x",
      "async fn f() -> int:",
      "  q = h()",
      "  x = await q",
      "  return x + 1",
      "p = f()",
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
    ),
  ],
  [
    "a waiter parked on a promise is woken by its rejection",
    src(
      "async fn h() -> int:",
      "  return 2",
      "async fn g() -> int:",
      "  y = await h()",
      '  throw "late"',
      "  return y",
      "async fn f() -> int:",
      "  q = g()",
      "  try:",
      "    x = await q",
      "    return x",
      "  catch e:",
      '    print("f caught " + e)',
      "  return 7",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "a rejection from a coroutine that settles a string",
    src(
      GS,
      "async fn f() -> string:",
      "  x = await g()",
      '  throw "boom"',
      "  return x",
      "p = f()",
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
    ),
  ],
  [
    "a throw out of the middle of a loop that suspends",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + await g()",
      "    if total > 2:",
      '      throw "over"',
      "    i = i + 1",
      "  return total",
      "p = f(5)",
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
    ),
  ],
  [
    "a try inside a coroutine around the await that rejects",
    src(
      G,
      "async fn h() -> int:",
      "  x = await g()",
      '  throw "inner"',
      "  return x",
      "async fn f() -> int:",
      "  q = h()",
      "  try:",
      "    return await q",
      "  catch e:",
      '    print("caught " + e)',
      "  return 3",
      "p = f()",
      'print("mid")',
      "print(await p)",
    ),
  ],
  [
    "two coroutines of the same shape where only one rejects",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  x = await g()",
      "  if n > 0:",
      '    throw "odd"',
      "  return x + n",
      "p = f(1)",
      "q = f(0)",
      'print("mid")',
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
      "print(await q)",
    ),
  ],
  [
    "an object stays live across a suspend that ends in a rejection",
    src(
      CELL,
      G,
      "async fn f(n: int) -> int:",
      "  c = Cell(n)",
      "  x = await g()",
      "  if c.v > 3:",
      '    throw "big"',
      "  return c.v + x",
      "p = f(6)",
      "q = f(1)",
      'print("mid")',
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
      "print(await q)",
    ),
  ],
  [
    "a collection while a frame is parked on a promise that rejects",
    src(
      CELL,
      "fn churn(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + Cell(i % 7).v",
      "    i = i + 1",
      "  return total",
      "async fn h() -> int:",
      "  return 1",
      "async fn g() -> int:",
      "  y = await h()",
      '  throw "gone"',
      "  return y",
      "async fn f(n: int) -> int:",
      "  c = Cell(n)",
      "  q = g()",
      "  try:",
      "    x = await q",
      "    return c.v + x",
      "  catch e:",
      '    print("caught " + e)',
      "  return c.v",
      "p = f(4)",
      "print(churn(300000))",
      "print(await p)",
    ),
  ],
  [
    "a coroutine that rejects with a string it built",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  x = await g()",
      '  throw "boom" + n.to_string()',
      "  return x",
      "p = f(7)",
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
    ),
  ],
  [
    "a rejection built from the value the coroutine awaited",
    src(
      GS,
      "async fn f(n: int) -> string:",
      "  x = await g()",
      "  if n > 2:",
      "    throw x + n.to_string()",
      "  return x",
      "p = f(5)",
      "q = f(1)",
      'print("mid")',
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(e)",
      "print(await q)",
    ),
  ],
];

const DECLINES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "a promise used as a plain value",
    src(G, "fn mid() -> int:", "  return g()", "print(mid())"),
    "used as a plain value",
  ],
  [
    "a promise that escapes into a value the compiler cannot follow",
    src(
      G,
      "async fn f(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    q = g()",
      "    total = total + await q",
      "    i = i + 1",
      "  return total",
      "p = f(3)",
      "print(await p)",
    ),
    "used as a plain value",
  ],
  [
    "a caught rejection kept across a call that can rebuild the string behind it",
    src(
      G,
      'fn label(n: int) -> string:',
      '  return "y" + n.to_string()',
      "async fn f(n: int) -> int:",
      "  x = await g()",
      '  throw "boom" + n.to_string()',
      "  return x",
      "p = f(7)",
      "try:",
      "  print(await p)",
      "catch e:",
      "  print(label(1))",
      "  print(e)",
    ),
    "keeps the value it caught across a call to label",
  ],
];

describe("AOT suspending coroutines", () => {
  for (const [shape, source] of MATCHES) {
    itRunsPe(`prints what the interpreter prints for ${shape}`, () => {
      const program = compiled(source);
      expect([shape, program.skipped]).toEqual([shape, []]);

      const run = runPe(program.files[0]!.contents as Uint8Array);
      expect([shape, run.status, run.stdout]).toEqual([
        shape,
        0,
        `${printedBy(source).join("\n")}\n`,
      ]);
    });
  }

  for (const [shape, source, reason] of DECLINES) {
    it(`declines ${shape} rather than reordering it`, () => {
      expect([shape, declined(source)]).toEqual([shape, expect.stringContaining(reason)]);
    });
  }
});

const UNREPORTED = src(
  G,
  "async fn f() -> int:",
  "  x = await g()",
  '  throw "boom"',
  "  return x",
);

describe("AOT rejections nobody awaits", () => {
  itRunsPe("reports the rejection the way the interpreter does and fails the program", () => {
    const run = runPe(
      compiled(src(UNREPORTED, "p = f()", "try:", '  throw "other"', "catch e:", "  print(e)"))
        .files[0]!.contents as Uint8Array,
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([
      1,
      "other\n",
      "Uncaught (in promise) boom\n",
    ]);
  });

  itRunsPe("stays silent once the rejection has been awaited", () => {
    const run = runPe(
      compiled(src(UNREPORTED, "p = f()", "try:", "  print(await p)", "catch e:", "  print(e)"))
        .files[0]!.contents as Uint8Array,
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([0, "boom\n", ""]);
  });

  itRunsPe("reports every rejection nobody awaited, in the order they settled", () => {
    const run = runPe(
      compiled(
        src(
          G,
          "async fn f(tag: string) -> int:",
          "  x = await g()",
          "  throw tag",
          "  return x",
          'p = f("first")',
          'q = f("second")',
          "try:",
          '  throw "other"',
          "catch e:",
          "  print(e)",
        ),
      ).files[0]!.contents as Uint8Array,
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([
      1,
      "other\n",
      "Uncaught (in promise) first\nUncaught (in promise) second\n",
    ]);
  });

  itRunsPe("reports the one rejection nobody awaited and keeps quiet about the rest", () => {
    const run = runPe(
      compiled(
        src(
          G,
          "async fn f(tag: string) -> int:",
          "  x = await g()",
          "  throw tag",
          "  return x",
          'p = f("watched")',
          'q = f("dropped")',
          "try:",
          "  print(await p)",
          "catch e:",
          "  print(e)",
        ),
      ).files[0]!.contents as Uint8Array,
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([
      1,
      "watched\n",
      "Uncaught (in promise) dropped\n",
    ]);
  });

  itRunsPe("reports a rejection nobody catches even with no try anywhere", () => {
    const run = runPe(
      compiled(src(UNREPORTED, "p = f()", 'print("done")')).files[0]!.contents as Uint8Array,
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([
      1,
      "done\n",
      "Uncaught (in promise) boom\n",
    ]);
  });
});

const THROUGH_C: readonly string[] = [
  "two coroutines resume in the order they suspended",
  "two suspends in one function",
  "a suspend inside a while loop",
  "suspends before, inside and after a loop",
  "a coroutine awaiting a promise it stored",
  "a stored promise from a coroutine that itself suspends",
  "a chain of four coroutines each awaiting the next",
  "a collection while a frame is suspended part way through a loop",
  "a collection while a frame is parked on a promise",
  "a suspend inside a loop in a program that catches a throw somewhere else",
  "a string a coroutine builds after it resumes",
  "a string built from two awaits of a coroutine that suspends itself",
  "a string promise parked on a suspending callee",
  "a string built in a loop before the suspend",
  "a collection while a frame is parked on a string promise",
  "a coroutine that throws a value of its own past a suspend",
  "a coroutine whose callee throws past it",
  "a waiter parked on a promise is woken by its rejection",
  "a rejection from a coroutine that settles a string",
  "a throw out of the middle of a loop that suspends",
  "a collection while a frame is parked on a promise that rejects",
  "a coroutine that rejects with a string it built",
  "a rejection built from the value the coroutine awaited",
];

describe("AOT suspending coroutines through the C backend", () => {
  it("names only shapes the match table still carries", () => {
    const known = new Set(MATCHES.map(([shape]) => shape));
    expect(THROUGH_C.filter((shape) => !known.has(shape))).toEqual([]);
  });

  for (const shape of THROUGH_C) {
    itNative(`prints what the interpreter prints for ${shape}`, () => {
      const source = MATCHES.find(([name]) => name === shape)![1];
      const program = compiledToC(source);
      expect([shape, program.skipped]).toEqual([shape, []]);

      const run = runCProgram(cSource(program));
      expect([shape, run.status, run.stdout]).toEqual([
        shape,
        0,
        `${printedBy(source).join("\n")}\n`,
      ]);
    });
  }
});
