import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { cCalls } from "../../../helpers/aot-agreement.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";

const KEEPS_CALLS = compilerOptions("speed", { inlineBudget: 0 });

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  expect(program.skipped).toEqual([]);
  return program;
}

const native = cCalls({
  toC: (source: string) => cSource(compile(source)),
  interpret: (source: string, call: string) =>
    nodeEngine({ typecheck: "off" }).runNative(`${source}
${call}
`),
});

function declined(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    compilerOptions: KEEPS_CALLS,
  });
  return program.skipped.map((entry) => entry.reason).join("; ");
}

describe("AOT object literals", () => {
  itNative("reads back a field it wrote", native.matches(
      src("fn f(n: int) -> int:", "  o = { a: n, b: 2 }", "  return o.a + o.b"),
      "f",
      [5],
    ));

  itNative("carries a literal out of the function that built it", native.matches(
      src(
        "fn make(n: int):",
        "  return { a: n, b: n * 2 }",
        "fn f(n: int) -> int:",
        "  o = make(n)",
        "  return o.a + o.b",
      ),
      "f",
      [4],
    ));

  itNative("reassigns a field after the literal is built", native.matches(
      src("fn f(n: int) -> int:", "  o = { a: 1 }", "  o.a = n", "  return o.a"),
      "f",
      [9],
    ));

  itNative("mixes a float and an int field", native.matches(
      src(
        "fn f(n: int) -> float:",
        "  o = { count: n, rate: 1.5 }",
        "  return o.count + (o.rate * 2.0)",
      ),
      "f",
      [3],
    ));

  itNative("builds two literals of the same layout in different functions", native.matches(
      src(
        "fn one(n: int) -> int:",
        "  return { a: n, b: 1 }.a",
        "fn two(n: int) -> int:",
        "  return { a: n, b: 2 }.b",
        "fn f(n: int) -> int:",
        "  return one(n) + two(n)",
      ),
      "f",
      [6],
    ));

  it("declines a literal whose field holds something with no machine type", () => {
    expect(declined(src("fn f() -> int:", "  o = { a: v => v }", "  return 1"))).not.toBe("");
  });
});

describe("AOT string comparison", () => {
  itNative("branches on equality", native.matches(
      src(
        "fn price(name: string) -> int:",
        '  if name == "apple":',
        "    return 1",
        "  return 2",
        "fn f(n: int) -> int:",
        '  return price("apple") + price("pear") + n',
      ),
      "f",
      [0],
    ));

  itNative("orders two strings lexicographically", native.matches(
      src(
        "fn f(n: int) -> int:",
        "  total = n",
        '  if "ant" < "bee":',
        "    total = total + 1",
        '  if "zebra" <= "apple":',
        "    total = total + 10",
        '  if "same" >= "same":',
        "    total = total + 100",
        '  if "a" != "b":',
        "    total = total + 1000",
        "  return total",
      ),
      "f",
      [0],
    ));

  itNative("compares a built string against a spelled-out one", native.matches(
      src(
        "fn f(n: int) -> int:",
        "  built = n.to_string()",
        '  if built == "7":',
        "    return 1",
        "  return 0",
      ),
      "f",
      [7],
    ));
});

describe("AOT arrays of spelled-out strings", () => {
  itNative("indexes an array of string constants", native.matches(
      src(
        "fn pick(i: int) -> string:",
        '  names = ["ant", "bee", "cow"]',
        "  return names[i]",
        "fn f(i: int) -> int:",
        '  if pick(i) == "cow":',
        "    return 1",
        "  return 0",
      ),
      "f",
      [2],
    ));

  itNative("keeps a string the program builds into an array", native.matches(
      src(
        "fn f(i: int) -> int:",
        '  names = ["H", "O"]',
        '  names[i] = "N" + "!"',
        '  if names[i] == "N!":',
        "    return 1",
        "  return 0",
      ),
      "f",
      [1],
    ));

  itNative("reads a field a constant key names", native.matches(
      src("fn f(n: int) -> int:", "  o = { a: n, b: 2 }", "  return o[\"a\"] + o[\"b\"]"),
      "f",
      [5],
    ));

  itNative("writes a field a constant key names", native.matches(
      src("fn f(n: int) -> int:", "  o = { a: 1 }", "  o[\"a\"] = n", "  return o.a"),
      "f",
      [9],
    ));

  itNative("answers membership from the shape the literal has", native.matches(
      src(
        "fn f(n: int) -> int:",
        "  o = { a: n }",
        "  present = \"a\" in o",
        "  missing = \"z\" in o",
        "  if present and not missing:",
        "    return n",
        "  return 0",
      ),
      "f",
      [3],
    ));
  itNative("counts the keys a literal declares", native.matches(
      src("fn f(n: int) -> int:", "  o = { a: n, b: 2, c: 3 }", "  return Object.keys(o).length"),
      "f",
      [1],
    ));

  itNative("folds the values a literal holds", native.matches(
      src(
        "fn add(a: int, b: int) -> int:",
        "  return a + b",
        "fn f(n: int) -> int:",
        "  o = { a: n, b: 2, c: 3 }",
        "  return Object.values(o).reduce(add, 0)",
      ),
      "f",
      [4],
    ));
});

describe("AOT object types on parameters", () => {
  const ORDER = "type Order = { sku: string, qty: int, price: float }";

  itNative("reads a field through a declared object type alias", native.matches(
      src(
        ORDER,
        "fn total(order: Order) -> float:",
        "  return order.price * order.qty",
        "fn f(n: int) -> float:",
        '  return total({ sku: "A1", qty: n, price: 2.5 })',
      ),
      "f",
      [4],
    ));

  itNative("reads a field through an object type written in place", native.matches(
      src(
        "fn total(order: { qty: int, price: float }) -> float:",
        "  return order.price * order.qty",
        "fn f(n: int) -> float:",
        "  return total({ qty: n, price: 0.5 })",
      ),
      "f",
      [7],
    ));

  itNative("lays a literal out as declared when its fields are written out of order", native.matches(
      src(
        ORDER,
        "fn total(order: Order) -> float:",
        "  return order.price * order.qty",
        "fn f(n: int) -> float:",
        '  return total({ price: 2.5, sku: "A1", qty: n })',
      ),
      "f",
      [4],
    ));

  itNative("reads a literal back out of a local array", native.matches(
      src(
        ORDER,
        "fn qty_of(order: Order) -> int:",
        "  return order.qty",
        "fn f(n: int) -> int:",
        '  orders = [{ sku: "A1", qty: n, price: 2.0 }]',
        "  return qty_of(orders[0])",
      ),
      "f",
      [7],
    ));

  itNative("spreads one literal into another", native.matches(
      src(
        "fn f(n: int) -> int:",
        "  a = { x: n, y: 2 }",
        "  b = { ...a, y: 5, z: 7 }",
        "  return b.x + b.y + b.z",
      ),
      "f",
      [1],
    ));

  itNative("lets a later field win over the one a spread copied", native.matches(
      src(
        "fn f(n: int) -> int:",
        "  a = { x: n }",
        "  b = { ...a, x: 9 }",
        "  return b.x",
      ),
      "f",
      [1],
    ));

  it("declines an escaping object it cannot lay out the way the callee declares", () => {
    expect(
      declined(
        src(
          ORDER,
          "fn qty_of(order: Order) -> int:",
          "  if order.qty < 0:",
          "    return 0",
          "  return order.qty",
          'kept = [{ sku: "A1", qty: 1, price: 2.0 }]',
          "fn f(n: int) -> int:",
          "  return qty_of(kept[0])",
        ),
      ),
    ).toContain("passes an object laid out differently from the order it declares");
  });

  it("declines removing a field and points at a map instead", () => {
    const reason = declined(src("o = { a: 1, b: 2 }", "delete o.a", "print(o.b)"));

    expect(reason).toContain("fixed set of fields");
    expect(reason).toContain("Map");
  });

  it("names the operator rather than the opcode behind it", () => {
    expect(declined(src("o = { a: 1, b: 2 }", "delete o.a", "print(o.b)"))).not.toContain(
      "unsupported opcode",
    );
  });
});
