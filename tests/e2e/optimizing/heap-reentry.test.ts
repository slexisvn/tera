import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const acrossTiers = (source: string) =>
  differential(source, { tiers: ["baseline", "jit", "osr", "eager"] });

describe("heap objects observed across a call back into the interpreter", () => {
  it("sees a store a callee made to a module-level array", () => {
    expect(
      acrossTiers(
        src(
          "cells: int[] = [0, 0, 0]",
          "count: int = 0",
          "fn put(index: int, value: int) -> void:",
          "  cells[index] = value",
          "fn shrink(whole: int) -> void:",
          "  i: int = 0",
          "  while i + whole < count:",
          "    put(i, cells[i + whole])",
          "    i += 1",
          "  count -= whole",
          "  i = count - 1",
          "  while i >= 0:",
          "    cells[i] = cells[i] + 1000",
          "    i -= 1",
          "fn run(n: int) -> int:",
          "  k: int = 0",
          "  last: int = 0",
          "  while k < n:",
          "    cells[0] = 7",
          "    cells[1] = 8",
          "    cells[2] = 9",
          "    count = 3",
          "    shrink(2)",
          "    last = cells[0]",
          "    k += 1",
          "  return last",
          "run(120)",
        ),
      ),
    ).toEqual(1009);
  });

  it("sees a store a callee made to an array it received as an argument", () => {
    expect(
      acrossTiers(
        src(
          "count: int = 0",
          "fn put(target: int[], index: int, value: int) -> void:",
          "  target[index] = value",
          "fn shrink(cells: int[], whole: int) -> void:",
          "  i: int = 0",
          "  while i + whole < count:",
          "    put(cells, i, cells[i + whole])",
          "    i += 1",
          "  count -= whole",
          "  i = count - 1",
          "  while i >= 0:",
          "    cells[i] = cells[i] + 1000",
          "    i -= 1",
          "fn run(n: int) -> int:",
          "  store: int[] = [0, 0, 0]",
          "  k: int = 0",
          "  last: int = 0",
          "  while k < n:",
          "    store[0] = 7",
          "    store[1] = 8",
          "    store[2] = 9",
          "    count = 3",
          "    shrink(store, 2)",
          "    last = store[0]",
          "    k += 1",
          "  return last",
          "run(120)",
        ),
      ),
    ).toEqual(1009);
  });

  it("shows a callee the array stores the caller already made", () => {
    expect(
      acrossTiers(
        src(
          "cells: int[] = [0, 0, 0]",
          "fn peek(index: int) -> int:",
          "  return cells[index]",
          "fn work() -> int:",
          "  i: int = 0",
          "  while i < 3:",
          "    cells[i] = i + 100",
          "    i += 1",
          "  return peek(1)",
          "fn run(n: int) -> int:",
          "  k: int = 0",
          "  last: int = 0",
          "  while k < n:",
          "    cells[0] = 7",
          "    cells[1] = 8",
          "    cells[2] = 9",
          "    last = work()",
          "    k += 1",
          "  return last",
          "run(120)",
        ),
      ),
    ).toEqual(101);
  });
});
