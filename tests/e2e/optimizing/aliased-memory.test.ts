import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

describe("a hot function reading two arrays of the same shape", () => {
  it("compares the elements of each array rather than one array twice", () => {
    expect(
      differential(
        src(
          "fn compare(a: int[], b: int[]) -> int:",
          "  i: int = a.length - 1",
          "  while i >= 0:",
          "    if a[i] != b[i]:",
          "      if a[i] > b[i]:",
          "        return 1",
          "      return -1",
          "    i -= 1",
          "  return 0",
          "",
          "fn halve(a: int[]) -> void:",
          "  carry: int = 0",
          "  i: int = a.length - 1",
          "  while i >= 0:",
          "    value: int = carry * 32768 + a[i]",
          "    a[i] = value >> 1",
          "    carry = value & 1",
          "    i -= 1",
          "",
          "left: int[] = [0, 0, 0, 0, 29824, 19521, 727]",
          "right: int[] = [0, 0, 0, 24340, 10651, 23676, 700]",
          "marks: string = \"\"",
          "i: int = 53",
          "while i >= 0:",
          "  marks = marks + compare(right, left).to_string() + \",\"",
          "  halve(left)",
          "  i -= 1",
          "marks",
        ),
      ),
    ).toEqual("-1," + "1,".repeat(53));
  });

  it("reads the second array at every index, not the first one twice", () => {
    expect(
      differential(
        src(
          "fn gap(a: int[], b: int[], i: int) -> int:",
          "  return a[i] - b[i]",
          "",
          "left: int[] = [10, 20, 30]",
          "right: int[] = [1, 2, 3]",
          "total: int = 0",
          "n: int = 0",
          "while n < 400:",
          "  total = total + gap(left, right, n % 3)",
          "  n += 1",
          "total",
        ),
      ),
    ).toEqual(7191);
  });
});

describe("a hot function reading one array at two indexes", () => {
  it("reads each index rather than reusing the first load", () => {
    expect(
      differential(
        src(
          "fn spread(a: int[], i: int, j: int) -> int:",
          "  return a[i] - a[j]",
          "",
          "data: int[] = [10, 20, 30, 40]",
          "total: int = 0",
          "n: int = 0",
          "while n < 400:",
          "  total = total + spread(data, 0, 3)",
          "  n += 1",
          "total",
        ),
      ),
    ).toEqual(-12000);
  });
});

describe("a hot function reading two objects of the same class", () => {
  it("reads each object's own field", () => {
    expect(
      differential(
        src(
          "class Box:",
          "  public constructor(v: int):",
          "    this.value = v",
          "",
          "fn gap(p: Box, q: Box) -> int:",
          "  return p.value - q.value",
          "",
          "one: Box = Box(3)",
          "two: Box = Box(8)",
          "total: int = 0",
          "n: int = 0",
          "while n < 400:",
          "  total = total + gap(one, two)",
          "  n += 1",
          "total",
        ),
      ),
    ).toEqual(-2000);
  });
});

describe("a hot function storing into two arrays of the same shape", () => {
  it("keeps the store to the first array alive", () => {
    expect(
      differential(
        src(
          "fn stash(a: int[], b: int[]) -> int:",
          "  a[0] = 5",
          "  b[0] = 7",
          "  return a[0]",
          "",
          "left: int[] = [1, 2]",
          "right: int[] = [3, 4]",
          "total: int = 0",
          "n: int = 0",
          "while n < 400:",
          "  total = total + stash(left, right)",
          "  n += 1",
          "total",
        ),
      ),
    ).toEqual(2000);
  });

  it("keeps a store that only a different index of the same array follows", () => {
    expect(
      differential(
        src(
          "fn stash(a: int[], i: int, j: int) -> int:",
          "  a[i] = 5",
          "  a[j] = 7",
          "  return a[i]",
          "",
          "data: int[] = [1, 2]",
          "total: int = 0",
          "n: int = 0",
          "while n < 400:",
          "  total = total + stash(data, 0, 1)",
          "  n += 1",
          "total",
        ),
      ),
    ).toEqual(2000);
  });
});
