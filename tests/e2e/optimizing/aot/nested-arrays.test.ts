import { describe } from "vitest";
import { peAgrees } from "../../../helpers/aot-agreement.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

const MULTIPLY = src(
  "fn multiply(a: float[][], b: float[][], n: int) -> float[][]:",
  "  out: float[][] = []",
  "  for i of range(0, n):",
  "    row: float[] = []",
  "    for j of range(0, n):",
  "      acc: float = 0.0",
  "      for k of range(0, n):",
  "        acc = acc + a[i][k] * b[k][j]",
  "      row.push(acc)",
  "    out.push(row)",
  "  return out",
);

const EMPTY_GRID = src(
  "fn empty(rows: int, columns: int) -> int[][]:",
  "  grid: int[][] = []",
  "  for y of range(0, rows):",
  "    row: int[] = []",
  "    for x of range(0, columns):",
  "      row.push(0)",
  "    grid.push(row)",
  "  return grid",
);

describe("AOT arrays of arrays", () => {
  itRunsPe("indexes a matrix literal through both dimensions", () => {
    peAgrees(
      src("fn cell(m: float[][]) -> float:", "  return m[1][0]", "print(cell([[1.5, 2.5], [3.5, 4.5]]))"),
    );
  });

  itRunsPe("keeps whole numbers in a float matrix as floats", () => {
    peAgrees(
      src(
        MULTIPLY,
        "m = multiply([[1.0, 2.0], [3.0, 4.0]], [[5.0, 6.0], [7.0, 8.0]], 2)",
        "print(m[1][1])",
        "print(m[0][0])",
      ),
    );
  });

  itRunsPe("indexes rows that were pushed into an array", () => {
    peAgrees(
      src(
        "out: int[][] = []",
        "for i of range(0, 3):",
        "  row: int[] = []",
        "  row.push(i * 10)",
        "  row.push(i * 10 + 1)",
        "  out.push(row)",
        "print(out[2][1])",
      ),
    );
  });

  itRunsPe("indexes the array of arrays a function answered", () => {
    peAgrees(
      src(
        "fn build(n: int) -> int[][]:",
        "  out: int[][] = []",
        "  for i of range(0, n):",
        "    row: int[] = []",
        "    row.push(i)",
        "    out.push(row)",
        "  return out",
        "m = build(3)",
        "print(m[2][0])",
      ),
    );
  });

  itRunsPe("writes through both dimensions of a grid", () => {
    peAgrees(
      src(
        EMPTY_GRID,
        "g = empty(3, 4)",
        "g[2][3] = 7",
        "g[0][1] = 5",
        "total = 0",
        "for row of g:",
        "  for cell of row:",
        "    total = total + cell",
        "print(total)",
      ),
    );
  });

  itRunsPe("walks an array of arrays it was handed", () => {
    peAgrees(
      src(
        "fn total(rows: int[][]) -> int:",
        "  sum = 0",
        "  for row of rows:",
        "    for cell of row:",
        "      sum = sum + cell",
        "  return sum",
        "print(total([[1, 2], [3, 4], [5]]))",
      ),
    );
  });

  itRunsPe("counts nested range loops bounded by module variables", () => {
    peAgrees(
      src(
        "WIDTH = 4",
        "HEIGHT = 3",
        EMPTY_GRID,
        "g = empty(HEIGHT, WIDTH)",
        "count = 0",
        "for y of range(0, HEIGHT):",
        "  for x of range(0, WIDTH):",
        "    g[y][x] = y * WIDTH + x",
        "    count = count + 1",
        "print(count)",
        "print(g[2][3])",
      ),
    );
  });
});
