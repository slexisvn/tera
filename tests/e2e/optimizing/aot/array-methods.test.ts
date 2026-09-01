import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, image, interpreted, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const PROGRAMS: readonly (readonly [string, string])[] = [
  ["finds an int", src("xs: int[] = [1, 2, 3]", "print(xs.index_of(3))")],
  ["finds the last of several matches", src("xs: int[] = [1, 2, 1]", "print(xs.last_index_of(1))")],
  ["reports a missing last match as -1", src("xs: int[] = [1, 2]", "print(xs.last_index_of(9))")],
  ["searches an empty array for a last match", src("xs: int[] = []", "print(xs.last_index_of(1))")],
  ["finds the last matching string", src('xs: string[] = ["a", "b", "a"]', 'print(xs.last_index_of("a"))')],
  ["finds the last matching float", src("xs: float[] = [1.5, 2.5, 1.5]", "print(xs.last_index_of(1.5))")],
  ["reports a missing int as -1", src("xs: int[] = [1, 2, 3]", "print(xs.index_of(9))")],
  ["reports the first of several matches", src("xs: int[] = [5, 5]", "print(xs.index_of(5))")],
  ["searches at the front", src("xs: int[] = [7, 8]", "print(xs.index_of(7))")],
  ["searches an empty array", src("xs: int[] = []", "print(xs.index_of(1))")],
  ["finds a float", src("xs: float[] = [1.5, 2.5]", "print(xs.index_of(2.5))")],
  ["misses a float", src("xs: float[] = [1.5]", "print(xs.index_of(9.5))")],
  ["finds a string", src('xs: string[] = ["a", "b"]', 'print(xs.index_of("b"))')],
  ["misses a string", src('xs: string[] = ["a"]', 'print(xs.index_of("zz"))')],
  ["tells that a value is present", src("xs: int[] = [1, 2, 3]", "print(xs.includes(2))")],
  ["tells that a value is absent", src("xs: int[] = [1, 2, 3]", "print(xs.includes(9))")],
  ["tells that an empty array holds nothing", src("xs: int[] = []", "print(xs.includes(1))")],
  ["tells that a string is present", src('xs: string[] = ["a"]', 'print(xs.includes("a"))')],
  [
    "uses the answer as a condition",
    src("xs: int[] = [1, 2]", "if xs.includes(2):", '  print("yes")', "else:", '  print("no")'),
  ],
  ["searches twice in one statement", src("xs: int[] = [1, 2]", "print(xs.index_of(1), xs.index_of(2))")],
  [
    "searches inside a loop",
    src("xs: int[] = [1, 2]", "n = 0", "while n < 3:", "  print(xs.includes(n))", "  n = n + 1"),
  ],
  [
    "searches an array held by a class",
    src(
      "class Bag:",
      "  public constructor(items: int[]):",
      "    this.items = items",
      "b = Bag([4, 5])",
      "print(b.items.index_of(5))",
    ),
  ],
  [
    "searches inside a function",
    src(
      "fn seen(xs: int[], v: int) -> bool:",
      "  return xs.includes(v)",
      "print(seen([1, 2], 2))",
    ),
  ],
  [
    "keeps searching after the array grows",
    src("xs: int[] = [1]", "xs.push(2)", "xs.push(3)", "print(xs.index_of(3))"),
  ],
];

const DOUBLE = ["fn double(v: int) -> int:", "  return v * 2"];
const ODD = ["fn odd(v: int) -> bool:", "  return v % 2 == 1"];
const ADD = ["fn add(a: int, b: int) -> int:", "  return a + b"];
const SHOW = ["fn show(v: int):", "  print(v)"];
const ASCENDING = ["fn up(a: int, b: int) -> int:", "  return a - b"];

const CALLBACK_PROGRAMS: readonly (readonly [string, string])[] = [
  ["finds the first index a predicate accepts", src(...ODD, "xs: int[] = [2, 4, 5]", "print(xs.find_index(odd))")],
  ["reports -1 when no element is accepted", src(...ODD, "xs: int[] = [2, 4]", "print(xs.find_index(odd))")],
  ["reports -1 for an empty array", src(...ODD, "xs: int[] = []", "print(xs.find_index(odd))")],
  ["tells that some element is accepted", src(...ODD, "xs: int[] = [2, 3]", "print(xs.some(odd))")],
  ["tells that no element is accepted", src(...ODD, "xs: int[] = [2, 4]", "print(xs.some(odd))")],
  ["tells that every element is accepted", src(...ODD, "xs: int[] = [1, 3]", "print(xs.every(odd))")],
  ["tells that some element is rejected", src(...ODD, "xs: int[] = [1, 2]", "print(xs.every(odd))")],
  ["treats an empty array as accepted by every", src(...ODD, "xs: int[] = []", "print(xs.every(odd))")],
  ["treats an empty array as accepted by no some", src(...ODD, "xs: int[] = []", "print(xs.some(odd))")],
  ["folds elements with an initial value", src(...ADD, "xs: int[] = [1, 2, 3]", "print(xs.reduce(add, 0))")],
  ["folds an empty array to its initial value", src(...ADD, "xs: int[] = []", "print(xs.reduce(add, 7))")],
  ["folds floats", src("fn plus(a: float, b: float) -> float:", "  return a + b", "xs: float[] = [1.5, 2.5]", "print(xs.reduce(plus, 0.0))")],
  ["visits every element in order", src(...SHOW, "xs: int[] = [4, 5, 6]", "xs.for_each(show)")],
  ["visits nothing in an empty array", src(...SHOW, "xs: int[] = []", "xs.for_each(show)", 'print("done")')],
  [
    "passes the index to a two-parameter callback",
    src(
      "fn at(v: int, i: int) -> bool:",
      "  return v == i",
      "xs: int[] = [9, 1, 2]",
      "print(xs.find_index(at))",
    ),
  ],
  [
    "uses the predicate answer as a condition",
    src(...ODD, "xs: int[] = [2, 3]", "if xs.some(odd):", '  print("yes")', "else:", '  print("no")'),
  ],
  [
    "folds inside a function that takes the array",
    src(...ADD, "fn total(xs: int[]) -> int:", "  return xs.reduce(add, 0)", "print(total([1, 2, 3]))"),
  ],
  [
    "folds an array a class holds",
    src(
      ...ADD,
      "class Bag:",
      "  public constructor(items: int[]):",
      "    this.items = items",
      "b = Bag([4, 5])",
      "print(b.items.reduce(add, 1))",
    ),
  ],
  [
    "keeps folding after the array grows",
    src(...ADD, "xs: int[] = [1]", "xs.push(2)", "xs.push(3)", "print(xs.reduce(add, 0))"),
  ],
  [
    "calls a callback that calls another function",
    src(
      ...DOUBLE,
      "fn big(v: int) -> bool:",
      "  return double(v) > 6",
      "xs: int[] = [1, 5]",
      "print(xs.find_index(big))",
    ),
  ],
  ["maps every element", src(...DOUBLE, "xs: int[] = [1, 2, 3]", "print(xs.map(double))")],
  ["maps an empty array", src(...DOUBLE, "xs: int[] = []", "print(xs.map(double))")],
  ["maps into another element type", src(
    "fn half(v: int) -> float:",
    "  return v / 2",
    "xs: int[] = [1, 3]",
    "print(xs.map(half))",
  )],
  ["reads an element of the mapped array", src(...DOUBLE, "xs: int[] = [4, 5]", "print(xs.map(double)[1])")],
  ["reports the length of the mapped array", src(...DOUBLE, "xs: int[] = [4, 5]", "print(xs.map(double).length)")],
  ["searches the mapped array", src(...DOUBLE, "xs: int[] = [1, 2]", "print(xs.map(double).index_of(4))")],
  ["leaves the source array alone", src(...DOUBLE, "xs: int[] = [1, 2]", "ys = xs.map(double)", "print(xs, ys)")],
  ["maps with the index", src(
    "fn shifted(v: int, i: int) -> int:",
    "  return v + i",
    "xs: int[] = [10, 20]",
    "print(xs.map(shifted))",
  )],
  ["keeps the elements a predicate accepts", src(...ODD, "xs: int[] = [1, 2, 3, 4]", "print(xs.filter(odd))")],
  ["keeps nothing when the predicate rejects everything", src(...ODD, "xs: int[] = [2, 4]", "print(xs.filter(odd))")],
  ["keeps everything when the predicate accepts everything", src(...ODD, "xs: int[] = [1, 3]", "print(xs.filter(odd))")],
  ["filters an empty array", src(...ODD, "xs: int[] = []", "print(xs.filter(odd))")],
  ["filters strings", src(
    "fn short(v: string) -> bool:",
    "  return v.length < 3",
    'xs: string[] = ["ab", "abcd", "c"]',
    "print(xs.filter(short))",
  )],
  ["folds the filtered array", src(...ODD, ...ADD, "xs: int[] = [1, 2, 3]", "print(xs.filter(odd).reduce(add, 0))")],
  ["maps inside a function", src(
    ...DOUBLE,
    "fn twice(xs: int[]) -> int[]:",
    "  return xs.map(double)",
    "print(twice([1, 2])[1])",
  )],
  ["folds with a three-parameter callback", src(
    "fn weighted(acc: int, v: int, i: int) -> int:",
    "  return acc + v * i",
    "xs: int[] = [10, 20, 30]",
    "print(xs.reduce(weighted, 0))",
  )],
  ["maps with an inline callback whose parameter is bare", src(
    "xs: int[] = [1, 2, 3]",
    "print(xs.map(v => v * 2))",
  )],
  ["filters with an inline callback whose parameter is bare", src(
    "xs: int[] = [1, 2, 3, 4]",
    "print(xs.filter(v => v % 2 == 0))",
  )],
  ["answers some and every from inline callbacks", src(
    "xs: int[] = [1, 2]",
    "print(xs.some(v => v > 1), xs.every(v => v > 0))",
  )],
  ["finds an index with an inline callback", src(
    "xs: int[] = [1, 2, 3]",
    "print(xs.find_index(v => v > 1))",
  )],
  ["maps bare parameters over strings", src(
    'xs: string[] = ["ab", "c"]',
    "print(xs.map(v => v.length))",
  )],
  ["maps bare parameters over floats", src(
    "xs: float[] = [1.5, 2.5]",
    "print(xs.map(v => v * 2.0))",
  )],
  ["keeps two inline callbacks apart in one chain", src(
    "xs: int[] = [1, 2, 3]",
    "print(xs.map(v => v * 2).filter(v => v > 2))",
  )],
  ["keeps two inline callbacks apart across statements", src(
    "xs: int[] = [1, 2, 3]",
    "ys = xs.map(v => v * 2)",
    "zs = xs.map(v => v + 100)",
    "print(ys, zs)",
  )],
  ["folds with an inline callback", src(
    "xs: int[] = [1, 2, 3]",
    "print(xs.reduce((acc, v) => acc + v, 0))",
  )],
  ["sorts with an inline comparator", src(
    "xs: int[] = [3, 1, 2]",
    "print(xs.sort((a, b) => a - b))",
  )],
];

const SLICE_PROGRAMS: readonly (readonly [string, string])[] = [
  ["takes a middle range", src("xs: int[] = [1, 2, 3, 4]", "print(xs.slice(1, 3))")],
  ["takes everything from an index on", src("xs: int[] = [1, 2, 3, 4]", "print(xs.slice(1))")],
  ["copies the whole array", src("xs: int[] = [1, 2, 3]", "print(xs.slice())")],
  ["counts a negative start back from the end", src("xs: int[] = [1, 2, 3, 4]", "print(xs.slice(-2))")],
  ["counts a negative end back from the end", src("xs: int[] = [1, 2, 3, 4]", "print(xs.slice(0, -1))")],
  ["answers nothing for a range past the end", src("xs: int[] = [1, 2]", "print(xs.slice(5, 9))")],
  ["clamps an end past the last element", src("xs: int[] = [1, 2]", "print(xs.slice(0, 99))")],
  ["clamps a start before the first element", src("xs: int[] = [1, 2]", "print(xs.slice(-99, 99))")],
  ["slices an empty array", src("xs: int[] = []", "print(xs.slice(0, 1))")],
  ["slices strings", src('xs: string[] = ["a", "b", "c"]', "print(xs.slice(1))")],
  ["slices floats", src("xs: float[] = [1.5, 2.5, 3.5]", "print(xs.slice(0, 2))")],
  ["leaves the array it sliced alone", src("xs: int[] = [1, 2, 3]", "ys = xs.slice(1)", "print(xs, ys)")],
  ["reports the length of a slice", src("xs: int[] = [1, 2, 3, 4]", "print(xs.slice(1, 3).length)")],
  ["slices an array it just mapped", src("xs: int[] = [1, 2, 3]", "print(xs.map(v => v * 2).slice(1))")],
];

const MUTATION_PROGRAMS: readonly (readonly [string, string])[] = [
  ["takes the first element off", src("xs: int[] = [1, 2, 3]", "print(xs.shift())", "print(xs)")],
  ["shortens the array it shifted from", src("xs: int[] = [7]", "print(xs.shift())", "print(xs.length)")],
  ["shifts twice", src("xs: int[] = [1, 2, 3]", "print(xs.shift(), xs.shift())", "print(xs)")],
  ["shifts a string", src('xs: string[] = ["a", "bb"]', "print(xs.shift())", "print(xs)")],
  ["shifts a float", src("xs: float[] = [1.5, 2.5]", "print(xs.shift())", "print(xs)")],
  ["pushes onto an array it shifted", src("xs: int[] = [1, 2]", "xs.shift()", "xs.push(9)", "print(xs)")],
  ["takes the last element off", src("xs: int[] = [1, 2, 3]", "print(xs.pop())", "print(xs)")],
  ["shortens the array it popped from", src("xs: int[] = [1, 2]", "xs.pop()", "print(xs.length)")],
  ["pops down to one element", src("xs: int[] = [1, 2]", "print(xs.pop(), xs.pop())", "print(xs.length)")],
  ["pops a string", src('xs: string[] = ["a", "bb"]', "print(xs.pop())", "print(xs)")],
  ["pops a float", src("xs: float[] = [1.5, 2.5]", "print(xs.pop())")],
  ["pops what was pushed", src("xs: int[] = [1]", "xs.push(9)", "print(xs.pop())", "print(xs)")],
  ["reverses an odd number of elements", src("xs: int[] = [1, 2, 3]", "xs.reverse()", "print(xs)")],
  ["reverses an even number of elements", src("xs: int[] = [1, 2, 3, 4]", "xs.reverse()", "print(xs)")],
  ["reverses one element", src("xs: int[] = [7]", "xs.reverse()", "print(xs)")],
  ["reverses no elements", src("xs: int[] = []", "xs.reverse()", "print(xs)")],
  ["hands back the array it reversed", src("xs: int[] = [1, 2]", "print(xs.reverse())")],
  ["reverses strings", src('xs: string[] = ["a", "b", "c"]', "xs.reverse()", "print(xs)")],
  ["reverses floats", src("xs: float[] = [1.5, 2.5]", "xs.reverse()", "print(xs)")],
  ["reverses twice back to the original", src("xs: int[] = [1, 2, 3]", "xs.reverse()", "xs.reverse()", "print(xs)")],
  ["searches a reversed array", src("xs: int[] = [1, 2, 3]", "xs.reverse()", "print(xs.index_of(1))")],
  ["sorts with a comparator", src(...ASCENDING, "xs: int[] = [3, 1, 2]", "xs.sort(up)", "print(xs)")],
  ["sorts an already sorted array", src(...ASCENDING, "xs: int[] = [1, 2, 3]", "xs.sort(up)", "print(xs)")],
  ["sorts a reversed array", src(...ASCENDING, "xs: int[] = [3, 2, 1]", "xs.sort(up)", "print(xs)")],
  ["sorts one element", src(...ASCENDING, "xs: int[] = [5]", "xs.sort(up)", "print(xs)")],
  ["sorts no elements", src(...ASCENDING, "xs: int[] = []", "xs.sort(up)", "print(xs)")],
  ["keeps equal elements", src(...ASCENDING, "xs: int[] = [2, 1, 2, 1]", "xs.sort(up)", "print(xs)")],
  ["sorts descending with the comparator reversed", src(
    "fn down(a: int, b: int) -> int:",
    "  return b - a",
    "xs: int[] = [1, 3, 2]",
    "xs.sort(down)",
    "print(xs)",
  )],
  ["sorts floats", src(
    "fn upf(a: float, b: float) -> float:",
    "  return a - b",
    "xs: float[] = [2.5, 1.5, 3.5]",
    "xs.sort(upf)",
    "print(xs)",
  )],
  ["hands back the array it sorted", src(...ASCENDING, "xs: int[] = [2, 1]", "print(xs.sort(up))")],
  ["searches a sorted array", src(...ASCENDING, "xs: int[] = [3, 1, 2]", "xs.sort(up)", "print(xs.index_of(3))")],
  ["joins ints with a separator", src("xs: int[] = [1, 2, 3]", 'print(xs.join(","))')],
  ["joins with the default separator", src("xs: int[] = [1, 2, 3]", "print(xs.join())")],
  ["joins a longer separator", src("xs: int[] = [1, 2]", 'print(xs.join(" and "))')],
  ["joins one element", src("xs: int[] = [7]", 'print(xs.join(","))')],
  ["joins no elements", src("xs: int[] = []", 'print(xs.join(","))')],
  ["joins strings", src('xs: string[] = ["a", "b", "c"]', 'print(xs.join("-"))')],
  ["joins floats", src("xs: float[] = [1.5, 2.5]", 'print(xs.join(","))')],
  ["joins with an empty separator", src("xs: int[] = [1, 2, 3]", 'print(xs.join(""))')],
  ["joins an array it just mapped", src(...DOUBLE, "xs: int[] = [1, 2]", 'print(xs.map(double).join(","))')],
  ["joins an array that grew", src("xs: int[] = [1]", "xs.push(2)", 'print(xs.join(","))')],
  ["sorts text with no comparator", src('xs: string[] = ["b", "a", "C", "ab", "Ab"]', "xs.sort()", "print(xs)")],
  ["sorts ints as text with no comparator", src("xs: int[] = [10, 9, 1, 2, -3, 100]", "xs.sort()", "print(xs)")],
  ["sorts floats as text with no comparator", src("xs: float[] = [1.5, 10.25, 2.0, -0.5]", "xs.sort()", "print(xs)")],
  ["sorts one element with no comparator", src("xs: int[] = [5]", "xs.sort()", "print(xs)")],
  ["sorts no elements with no comparator", src("xs: string[] = []", "xs.sort()", "print(xs)")],
  ["keeps equal elements with no comparator", src("xs: int[] = [2, 1, 2, 1]", "xs.sort()", "print(xs)")],
  ["hands back the array it sorted as text", src('xs: string[] = ["b", "a"]', "print(xs.sort())")],
  ["joins an array it just sorted as text", src("xs: int[] = [10, 9]", "xs.sort()", 'print(xs.join(","))')],
];

describe("array mutation methods", () => {
  for (const [name, source] of MUTATION_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }

  itRunsPe("faults on popping an empty array, where the interpreter answers undefined", () => {
    const run = runPe(image(src("xs: int[] = []", "print(xs.pop())")));

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("cannot pop an empty array");
    expect(run.stdout).toBe("");
  });
});

describe("array callback methods", () => {
  for (const [name, source] of CALLBACK_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }

  it("compiles a sort with no comparator over numbers", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("xs: int[] = [2, 1]", "xs.sort()", "print(xs)", ""),
    );

    expect(program.skipped).toEqual([]);
  });

  it("declines a sort with no comparator over values it cannot spell as text", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "class Card:",
        "  public constructor(rank: int):",
        "    this.rank = rank",
        "xs: Card[] = [Card(2), Card(1)]",
        "xs.sort()",
        "print(xs[0].rank)",
        "",
      ),
    );

    expect(program.skipped.map((entry) => entry.reason).join("; ")).toContain("comparator");
  });

  it("compiles find, whose miss answers null", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(...ODD, "xs: int[] = [1, 2]", "print(xs.find(odd))", ""),
    );

    expect(program.skipped).toEqual([]);
  });

  it("declines a reduce that has no initial value", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(...ADD, "xs: int[] = [1, 2]", "print(xs.reduce(add))", ""),
    );

    expect(program.skipped.map((entry) => entry.reason).join("; ")).toContain("reduce");
  });

  it("declines a callback whose parameters it cannot fill", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "fn wide(v: int, i: int, extra: int) -> bool:",
        "  return v == i + extra",
        "xs: int[] = [1, 2]",
        "print(xs.find_index(wide))",
        "",
      ),
    );

    expect(program.skipped.map((entry) => entry.reason).join("; ")).toContain("find_index");
  });
});

describe("array search methods", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }

  itRunsPe("scans elements in order and stops at the first match", () => {
    const run = runPe(image(src("xs: int[] = [9, 3, 3]", "print(xs.index_of(3))")));

    expect(run.stdout).toBe("1\n");
  });

  it("still declines a member no backend lowers", () => {
    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(
        src("xs: int[] = [1]", "print(xs.flat_map(x => [x]))", ""),
        { backend: "x64-windows", format: "executable" },
      ),
    ).toThrow(/flat_map/);
  });

  itRunsPe("joins two arrays end to end", () =>
    peAgrees(
      src("xs: int[] = [1, 2]", "ys: int[] = [3]", "for x of xs.concat(ys):", "  print(x)"),
    ),
  );

  itRunsPe("leaves both sources alone after joining them", () =>
    peAgrees(
      src(
        "xs: int[] = [1]",
        "ys: int[] = [2]",
        "joined = xs.concat(ys)",
        "xs.push(9)",
        "print(joined.length)",
        "print(xs.length)",
      ),
    ),
  );

  itRunsPe("joins two arrays of text", () =>
    peAgrees(
      src(
        'xs: string[] = ["a"]',
        'ys: string[] = ["b", "c"]',
        "for s of xs.concat(ys):",
        "  print(s)",
      ),
    ),
  );
});

describe("array slicing", () => {
  for (const [name, source] of SLICE_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }
});
describe("AOT array flattening", () => {
  itRunsPe("flattens nested arrays the way the interpreter does", () => {
    peAgrees(
      src(
        "print([[1, 2], [3, 4], [5]].flat())",
        "grid: int[][] = [[1], [2, 3]]",
        "print(grid.flat().length)",
        'words: string[][] = [["a", "b"], ["c"]]',
        'print(words.flat().join("-"))',
      ),
    );
  });
});

describe("iterating what an array method answers", () => {
  const WALKED: readonly (readonly [string, string])[] = [
    ["a slice", src("xs: int[] = [1, 2, 3, 4]", "for x of xs.slice(1, 3):", "  print(x)")],
    ["a filter", src("xs: int[] = [1, 2, 3]", "for x of xs.filter(v => v > 1):", "  print(x)")],
    ["a reversal", src("xs: int[] = [1, 2, 3]", "for x of xs.reverse():", "  print(x)")],
    ["a sort", src("xs: int[] = [3, 1, 2]", "for x of xs.sort((p, q) => p - q):", "  print(x)")],
    [
      "a join of two arrays",
      src("xs: int[] = [1]", "ys: int[] = [2]", "for x of xs.concat(ys):", "  print(x)"),
    ],
    [
      "a chain of two methods",
      src(
        "xs: int[] = [1, 2]",
        "ys: int[] = [3, 4]",
        "for x of xs.concat(ys).slice(1, 3):",
        "  print(x)",
      ),
    ],
    [
      "a slice held in a variable first",
      src("xs: int[] = [1, 2, 3]", "held = xs.slice(1)", "for x of held:", "  print(x)"),
    ],
    [
      "a flattening",
      src("rows: int[][] = [[1, 2], [3]]", "for x of rows.flat():", "  print(x)"),
    ],
    [
      "a join of two record arrays",
      src(
        "type R = { n: string }",
        'xs: R[] = [{ n: "x" }]',
        'ys: R[] = [{ n: "y" }]',
        "for r of xs.concat(ys):",
        "  print(r.n)",
      ),
    ],
  ];

  for (const [what, source] of WALKED) {
    itRunsPe(`walks ${what}`, () => peAgrees(source));
  }
});
