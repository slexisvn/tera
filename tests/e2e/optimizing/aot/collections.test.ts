import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function declines(source: string): void {
  expect(() =>
    nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
      backend: "x64-windows",
      format: "executable",
    }),
  ).toThrow(/cannot emit/);
}

describe("AOT maps and sets", () => {
  itRunsPe("counts words through a string-keyed map", () => {
    agrees(
      src(
        "counts = Map()",
        'for word of ["a", "b", "a", "c", "a", "b"]:',
        "  counts.set(word, (counts.get(word) ?? 0) + 1)",
        'print(counts.get("a"), counts.get("b"), counts.get("z"), counts.size)',
      ),
    );
  });

  itRunsPe("answers null for a key the map never held", () => {
    agrees(
      src(
        "prices = Map()",
        'prices.set("apple", 1.5)',
        'print(prices.get("apple"), prices.get("pear"), prices.size)',
      ),
    );
  });

  itRunsPe("keeps integer keys and string values apart", () => {
    agrees(
      src(
        "labels = Map()",
        'labels.set(1, "one")',
        'labels.set(2, "two")',
        "print(labels.get(2), labels.get(9), labels.has(1), labels.has(7))",
      ),
    );
  });

  itRunsPe("walks keys in insertion order", () => {
    agrees(
      src(
        "ages = Map()",
        'ages.set("ann", 31)',
        'ages.set("bob", 27)',
        'ages.set("ann", 32)',
        "for name of ages.keys():",
        "  print(name, ages.get(name))",
        "print(ages.size)",
      ),
    );
  });

  itRunsPe("grows past its first table", () => {
    agrees(
      src(
        "big = Map()",
        "for i of range(0, 40):",
        "  big.set(i, i * i)",
        "print(big.size, big.get(0), big.get(39))",
      ),
    );
  });

  itRunsPe("drops keys a delete removed", () => {
    agrees(
      src(
        "m = Map()",
        'm.set("a", 1)',
        'm.set("b", 2)',
        'm.set("c", 3)',
        'print(m.delete("b"), m.delete("z"), m.size, m.has("b"))',
        "for k of m.keys():",
        "  print(k, m.get(k))",
        'm.set("b", 9)',
        'print(m.size, m.get("b"))',
      ),
    );
  });

  itRunsPe("reuses the table after many deletes", () => {
    agrees(
      src(
        "big = Map()",
        "for i of range(0, 50):",
        "  big.set(i, i)",
        "for i of range(0, 50):",
        "  if i % 2 == 0:",
        "    big.delete(i)",
        "print(big.size, big.has(7), big.has(8), big.get(49))",
      ),
    );
  });

  itRunsPe("dedupes members of a set", () => {
    agrees(
      src(
        "seen = Set()",
        "for n of [1, 2, 2, 3, 3, 3, 4]:",
        "  seen.add(n)",
        "print(seen.size, seen.has(3), seen.has(9))",
        "for v of seen.values():",
        "  print(v)",
      ),
    );
  });

  itRunsPe("dedupes strings and forgets deleted members", () => {
    agrees(
      src(
        "tags = Set()",
        'for w of ["red", "green", "red", "blue"]:',
        "  tags.add(w)",
        'print(tags.size, tags.delete("green"), tags.size)',
        "for t of tags.values():",
        "  print(t)",
      ),
    );
  });

  itRunsPe("widens a map whose values mix whole and fractional numbers", () => {
    agrees(
      src(
        "m = Map()",
        'm.set("a", 1)',
        'm.set("b", 2.5)',
        'print(m.get("a"), m.get("b"))',
      ),
    );
  });

  itRunsPe("leaves a class of the same name alone", () => {
    agrees(
      src(
        "class Map:",
        "  public n: int",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public get(k: int) -> int:",
        "    return this.n + k",
        "m = Map(5)",
        "print(m.get(2))",
      ),
    );
  });

  it("declines a listing that is printed rather than iterated", () => {
    declines(src("m = Map()", 'm.set("a", 1)', "print(m.keys())"));
  });

  it("declines a map that escapes to a call", () => {
    declines(src("m = Map()", 'm.set("a", 1)', "print(m)"));
  });

  itRunsPe("reads a map through a function that declares it", () => {
    agrees(
      src(
        "fn lookup(table: Map, key: string) -> int:",
        "  return table.get(key) ?? 0",
        "counts = Map()",
        'counts.set("a", 4)',
        'counts.set("b", 7)',
        'print(lookup(counts, "a"), lookup(counts, "b"), lookup(counts, "z"))',
      ),
    );
  });

  itRunsPe("reads a map through a method on another class", () => {
    agrees(
      src(
        "class Lookup:",
        "  public key: string",
        "  public constructor(key: string):",
        "    this.key = key",
        "  public of(table: Map) -> int:",
        "    return table.get(this.key) ?? 0",
        "prices = Map()",
        'prices.set("apple", 3)',
        'print(Lookup("apple").of(prices), Lookup("pear").of(prices))',
      ),
    );
  });

  itRunsPe("fills a map inside one function and reads it in another", () => {
    agrees(
      src(
        "fn fill(table: Map, word: string) -> void:",
        "  table.set(word, (table.get(word) ?? 0) + 1)",
        "counts = Map()",
        'for word of ["a", "b", "a"]:',
        "  fill(counts, word)",
        'print(counts.get("a"), counts.get("b"), counts.size)',
      ),
    );
  });

  it("declines a map handed to a function that does not declare one", () => {
    declines(
      src(
        "fn show(value: int) -> int:",
        "  return value",
        "m = Map()",
        'm.set("a", 1)',
        "print(show(m.size), m)",
      ),
    );
  });

  itRunsPe("walks a set of ints without naming its values", () => {
    agrees(
      src(
        "seen = Set()",
        "for n of [1, 2, 2, 3]:",
        "  seen.add(n)",
        "total = 0",
        "for v of seen:",
        "  total = total + v",
        "print(total, seen.size)",
      ),
    );
  });

  itRunsPe("walks a set of text without naming its values", () => {
    agrees(
      src(
        "tags = Set()",
        'for w of ["red", "green", "red"]:',
        "  tags.add(w)",
        "for v of tags:",
        "  print(v)",
      ),
    );
  });

  itRunsPe("walks a set the same way whether or not values is spelled out", () => {
    agrees(
      src(
        "seen = Set()",
        "seen.add(4)",
        "seen.add(5)",
        "for v of seen:",
        "  print(v)",
        "for v of seen.values():",
        "  print(v)",
      ),
    );
  });

  itRunsPe("walks a set that a function was handed", () => {
    agrees(
      src(
        "fn total(values: Set) -> int:",
        "  sum_of = 0",
        "  for v of values:",
        "    sum_of = sum_of + v",
        "  return sum_of",
        "seen = Set()",
        "seen.add(6)",
        "seen.add(7)",
        "print(total(seen))",
      ),
    );
  });

  itRunsPe("keeps a set of fractions", () => {
    agrees(
      src(
        "t = Set()",
        "t.add(1.5)",
        "t.add(2.5)",
        "t.add(1.5)",
        "print(t.has(1.5))",
        "print(t.has(3.5))",
        "print(t.size)",
      ),
    );
  });

  itRunsPe("keys a map by a fraction", () => {
    agrees(
      src(
        "m = Map()",
        "m.set(1.5, 10)",
        "m.set(2.5, 20)",
        "print(m.get(1.5))",
        "print(m.get(2.5))",
        "print(m.size)",
      ),
    );
  });

  itRunsPe("walks a map through entries", () => {
    agrees(
      src(
        "m = Map()",
        'm.set("a", 1)',
        'm.set("b", 2)',
        "total = 0",
        "for e of m.entries():",
        "  total = total + e[1]",
        "print(total)",
      ),
    );
  });

  itRunsPe("walks a map directly the way it walks entries", () => {
    agrees(
      src(
        "m = Map()",
        'm.set("a", 1)',
        'm.set("b", 2)',
        "keys = 0",
        "values = 0",
        "for e of m:",
        "  keys = keys + e[0].length",
        "  values = values + e[1]",
        "print(keys)",
        "print(values)",
      ),
    );
  });

  itRunsPe("walks an int-keyed map directly", () => {
    agrees(
      src(
        "m = Map()",
        "m.set(1, 10)",
        "m.set(2, 20)",
        "total = 0",
        "for e of m:",
        "  total = total + e[0] + e[1]",
        "print(total)",
      ),
    );
  });

  it("says what it could not lay out when a map is held in a static field", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      `${src(
        "class C:",
        "  public static cache = Map()",
        "  public static put(k: string, v: int) -> void:",
        "    C.cache.set(k, v)",
        'C.put("a", 1)',
      )}
`,
      { backend: "c" },
    );
    const reasons = program.skipped.map((fn) => fn.reason).join("; ");

    expect(reasons).toContain("C.cache is a value the compiler could not lay out");
    expect(reasons).not.toContain("async and await");
  });
});
