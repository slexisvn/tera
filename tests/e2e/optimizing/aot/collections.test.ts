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
});
