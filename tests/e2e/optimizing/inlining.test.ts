import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const againstOracle = (source: string) => differential(source, { tiers: ["production"] });

const drive = (callee: readonly string[], call: string, iterations: number) =>
  src(
    ...callee,
    "fn work(n: int) -> int:",
    "  acc = 0",
    "  i = 0",
    "  while (i < n):",
    `    acc = ${call}`,
    "    i = (i + 1)",
    "  return acc",
    `work(${iterations})`,
  );

describe("inlining a callee that contains control flow", () => {
  it("terminates when the inlined callee loops over a counter", () => {
    expect(
      againstOracle(
        drive(
          [
            "fn inner(k: int) -> int:",
            "  acc = 0",
            "  i = 0",
            "  while (i < k):",
            "    acc = (acc + i)",
            "    i = (i + 1)",
            "  return acc",
          ],
          "inner(9)",
          12000,
        ),
      ),
    ).toBe(36);
  }, 30000);

  it("terminates when the inlined callee loops over an array", () => {
    expect(
      againstOracle(
        src(
          "fn total(a) -> int:",
          "  acc = 0",
          "  i = 0",
          "  while (i < a.length):",
          "    acc = (acc + a[i])",
          "    i = (i + 1)",
          "  return acc",
          "fn work(n: int) -> int:",
          "  data = [1, 2, 3, 4]",
          "  acc = 0",
          "  i = 0",
          "  while (i < n):",
          "    acc = total(data)",
          "    i = (i + 1)",
          "  return acc",
          "work(12000)",
        ),
      ),
    ).toBe(10);
  }, 30000);

  it("terminates when the inlined callee loops over a string", () => {
    expect(
      againstOracle(
        drive(
          [
            "fn checksum(s: string) -> int:",
            "  acc = 0",
            "  i = 0",
            "  while (i < s.length):",
            "    acc = (acc + s.char_code_at(i))",
            "    i = (i + 1)",
            "  return acc",
          ],
          'checksum("abc")',
          12000,
        ),
      ),
    ).toBe(294);
  }, 30000);

  it("carries the loop counter of the inlined callee across its back edge", () => {
    expect(
      againstOracle(
        drive(
          [
            "fn last_index(k: int) -> int:",
            "  i = 0",
            "  while (i < k):",
            "    i = (i + 1)",
            "  return i",
          ],
          "last_index(7)",
          12000,
        ),
      ),
    ).toBe(7);
  }, 30000);

  it("keeps both arms of a branch inside the inlined callee distinct", () => {
    expect(
      againstOracle(
        drive(
          [
            "fn pick(c: int) -> int:",
            "  r = 0",
            "  if (c > 0):",
            "    r = 10",
            "  else:",
            "    r = 20",
            "  return r",
          ],
          "(acc + pick((i % 2)))",
          300,
        ),
      ),
    ).toBe(4500);
  }, 30000);

  it("keeps a loop and a branch inside the same inlined callee correct", () => {
    expect(
      againstOracle(
        drive(
          [
            "fn odds(k: int) -> int:",
            "  acc = 0",
            "  i = 0",
            "  while (i < k):",
            "    if ((i % 2) == 1):",
            "      acc = (acc + i)",
            "    i = (i + 1)",
            "  return acc",
          ],
          "odds(10)",
          12000,
        ),
      ),
    ).toBe(25);
  }, 30000);
});
