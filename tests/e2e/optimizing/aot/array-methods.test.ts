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
  ["puts an int at the front", src("xs: int[] = [3, 5, 7]", "xs.unshift(1)", 'print(xs.join(","))')],
  ["answers the length after putting one at the front", src("xs: int[] = [3, 5]", "print(xs.unshift(1))")],
  ["puts one at the front of an empty array", src("xs: int[] = []", "xs.unshift(2)", 'print(xs.join(","), xs.length)')],
  ["puts a string at the front", src('xs: string[] = ["b", "c"]', 'xs.unshift("a")', 'print(xs.join(","))')],
  ["puts a float at the front", src("xs: float[] = [1.5, 2.5]", "xs.unshift(0.5)", 'print(xs.join(","))')],
  ["reads back the element it moved aside", src("xs: int[] = [3, 5]", "xs.unshift(1)", "print(xs[0], xs[1], xs[2])")],
  [
    "puts one at the front over and over",
    src("xs: int[] = []", "for i of range(5):", "  xs.unshift(i)", 'print(xs.join(","))'),
  ],
  [
    "puts one at the front of an array that grew",
    src("xs: int[] = [2]", "xs.push(3)", "xs.unshift(1)", 'print(xs.join(","))'),
  ],
  [
    "takes back from the front what it put there",
    src("xs: int[] = [2, 3]", "xs.unshift(1)", "print(xs.shift())", 'print(xs.join(","))'),
  ],
  [
    "takes a range out of the middle",
    src("xs: int[] = [3, 5, 7, 9]", 'print(xs.splice(1, 2).join(","))', 'print(xs.join(","))'),
  ],
  [
    "takes everything from a position when no count is given",
    src("xs: int[] = [1, 2, 3]", 'print(xs.splice(1).join(","))', 'print(xs.join(","))'),
  ],
  [
    "counts a negative start from the end",
    src("xs: int[] = [1, 2, 3, 4, 5]", 'print(xs.splice(-2, 1).join(","))', 'print(xs.join(","))'),
  ],
  [
    "stops a count that runs past the end",
    src("xs: int[] = [1, 2, 3]", 'print(xs.splice(1, 99).join(","))', 'print(xs.join(","))'),
  ],
  [
    "takes nothing for a count of zero",
    src("xs: int[] = [1, 2, 3]", 'print(`[${xs.splice(1, 0).join(",")}]`)', 'print(xs.join(","))'),
  ],
  [
    "takes nothing for a count below zero",
    src("xs: int[] = [1, 2, 3]", 'print(`[${xs.splice(1, -5).join(",")}]`)', 'print(xs.join(","))'),
  ],
  [
    "takes nothing from a start past the end",
    src("xs: int[] = [1, 2]", 'print(`[${xs.splice(9, 1).join(",")}]`)', 'print(xs.join(","))'),
  ],
  [
    "empties the array from the front",
    src("xs: int[] = [1, 2, 3]", 'print(xs.splice(0).join(","))', "print(xs.length)"),
  ],
  [
    "takes a range out of an empty array",
    src("xs: int[] = []", 'print(`[${xs.splice(0, 3).join(",")}]`, xs.length)'),
  ],
  [
    "takes a range of strings out",
    src('xs: string[] = ["a", "b", "c", "d"]', 'print(xs.splice(1, 2).join(","))', 'print(xs.join(","))'),
  ],
  [
    "takes a range of floats out and reads what moved down",
    src("xs: float[] = [1.5, 2.5, 3.5, 4.5]", 'print(xs.splice(2, 1).join(","))', "print(xs[0], xs[2])"),
  ],
  [
    "drains an array two at a time",
    src("xs: int[] = [0, 1, 2, 3, 4, 5]", "while xs.length > 2:", '  print(xs.splice(0, 2).join("-"))', 'print(xs.join(","))'),
  ],
  [
    "puts one value in place of the range it removed",
    src("xs: int[] = [1, 2, 3, 4]", 'print(xs.splice(1, 2, 9).join(","))', 'print(xs.join(","))'),
  ],
  [
    "puts several values in place of one",
    src("xs: int[] = [1, 2, 3]", 'print(xs.splice(1, 1, 7, 8, 9).join(","))', 'print(xs.join(","))'),
  ],
  [
    "puts values in without removing any",
    src("xs: int[] = [1, 4]", 'print(`[${xs.splice(1, 0, 2, 3).join(",")}]`)', 'print(xs.join(","))'),
  ],
  [
    "puts values in at a position counted from the end",
    src("xs: int[] = [1, 2, 3, 4]", 'print(xs.splice(-2, 1, 9).join(","))', 'print(xs.join(","))'),
  ],
  [
    "puts values in past the end of what it holds",
    src("xs: int[] = [1, 2]", 'print(`[${xs.splice(9, 3, 8, 9).join(",")}]`)', 'print(xs.join(","))'),
  ],
  [
    "puts a value into an empty array",
    src("xs: int[] = []", 'print(`[${xs.splice(0, 3, 7).join(",")}]`)', 'print(xs.join(","), xs.length)'),
  ],
  [
    "puts strings in place of the ones it removed",
    src(
      'xs: string[] = ["a", "b", "c", "d"]',
      'print(xs.splice(1, 2, "x", "y", "z").join(","))',
      'print(xs.join(","))',
    ),
  ],
  [
    "puts floats in and reads back what moved up",
    src(
      "xs: float[] = [1.5, 2.5, 3.5]",
      'print(xs.splice(1, 1, 9.25, 8.75).join(","))',
      "print(xs[0], xs[1], xs[2], xs[3], xs.length)",
    ),
  ],
  [
    "keeps the order of the values it put in over several calls",
    src(
      "xs: int[] = [0, 5]",
      "xs.splice(1, 0, 1, 2)",
      "xs.splice(3, 0, 3, 4)",
      'print(xs.join(","), xs.length)',
    ),
  ],
];

describe("array mutation methods", () => {
  for (const [name, source] of MUTATION_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }

  itRunsPe("answers undefined for popping an empty array, the way the interpreter does", () => {
    peAgrees(src("xs: int[] = []", "print(xs.pop())"));
  });

  itRunsPe("answers undefined for shifting an empty array too", () => {
    peAgrees(src("xs: int[] = []", "print(xs.shift())"));
  });

  itRunsPe("answers undefined only once the array has drained", () => {
    peAgrees(
      src("xs: int[] = [1]", "print(xs.pop())", "print(xs.pop())", "print(xs.length)"),
    );
  });

  itNative(
    "answers undefined for an empty pop through the C backend",
    native.agrees(src("xs: int[] = []", "print(xs.pop())")),
  );

  it("says what a splice needs when the array has no element type to pin down", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("fn go(xs: any) -> int:", "  xs.splice(0, 1, 9)", "  return 0", "print(go([1, 2]))", ""),
      { backend: "x64-windows", format: "assembly" },
    );

    expect(program.skipped.map((one) => one.reason).join(" | ")).toContain(
      "splice compiles over an array whose element type the compiler could pin down",
    );
  });

  it("refuses a splice whose values arrive spread out of an array, naming the spread", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("xs: int[] = [1, 2, 3]", "ys: int[] = [8, 9]", "xs.splice(1, 1, ...ys)", "print(xs)", ""),
      { backend: "x64-windows", format: "assembly" },
    );

    expect(program.skipped.map((one) => one.reason).join(" | ")).toContain(
      "a call spreads an array into a function whose argument count the compiler cannot tell",
    );
  });

  itRunsPe("still faults draining an array whose elements are not numbers", () => {
    const run = runPe(image(src('xs: string[] = ["a"]', "print(xs.pop())", "print(xs.pop())")));

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("a\n");
    expect(run.stderr).toContain("cannot pop an empty array");
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

describe("AOT loops that take one element at a time", () => {
  const DRAINED: readonly (readonly [string, string])[] = [
    [
      "walks a queue from the front until it runs out",
      src(
        'queue: string[] = ["a", "b", "c"]',
        "while queue.length > 0:",
        "  item: string = queue.shift()",
        "  print(item)",
      ),
    ],
    [
      "adds up a stack from the back until it runs out",
      src(
        "stack: int[] = [1, 2, 3]",
        "total = 0",
        "while stack.length > 0:",
        "  top: int = stack.pop()",
        "  total = total + top",
        "print(total)",
      ),
    ],
    [
      "keeps what it took off one array in another",
      src(
        'queue: string[] = ["a", "b", "c"]',
        "seen: string[] = []",
        "while queue.length > 0:",
        "  item: string = queue.shift()",
        "  seen.push(item)",
        "print(seen.length)",
        "print(seen[2])",
      ),
    ],
  ];

  for (const [what, source] of DRAINED) {
    itRunsPe(what, () => peAgrees(source));
  }
});

describe("AOT arrays a loop fills from what it already holds", () => {
  itRunsPe("sorts by moving elements it read back into the same array", () =>
    peAgrees(
      src(
        "fn sorted(values: int[]) -> int[]:",
        "  out: int[] = []",
        "  for value of values:",
        "    at = 0",
        "    while at < out.length and out[at] < value:",
        "      at = at + 1",
        "    out.push(value)",
        "    back = out.length - 1",
        "    while back > at:",
        "      swap: int = out[back - 1]",
        "      out[back] = swap",
        "      out[back - 1] = value",
        "      back = back - 1",
        "  return out",
        "for x of sorted([5, 3, 9, 1, 7]):",
        "  print(x)",
      ),
    ),
  );
});

describe("an array variable a loop reassigns", () => {
  itRunsPe("keeps working on the array the loop handed back", () => {
    peAgrees(
      src(
        "queue: int[] = [1]",
        "seen: int[] = []",
        "while queue.length > 0:",
        "  held = queue.shift()",
        "  seen.push(held)",
        "  if held < 5:",
        "    queue.push(held + 1)",
        "  if seen.length > 8:",
        "    queue = []",
        'print(seen.join(","))',
        "print(queue.length)",
      ),
    );
  });

  itRunsPe("works on whichever of two arrays a branch chose", () => {
    peAgrees(
      src(
        "left: int[] = [1, 2]",
        "right: int[] = [3]",
        "picked = left",
        "if right.length > 0:",
        "  picked = right",
        "picked.push(9)",
        'print(picked.join(","))',
      ),
    );
  });
});
