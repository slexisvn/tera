import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { differential } from "../../helpers/tiers.js";

const formatter = readFileSync(
  fileURLToPath(new URL("./sources/decimal-formatter.tera", import.meta.url)),
  "utf8",
);

const expected = () => {
  const parts: string[] = [];
  for (const value of [0.0, 1.0, 2.5, 3.14159, 1.005, 0.3, 1234.5678]) {
    for (let digits = 0; digits <= 20; digits += 4) parts.push(`${value.toFixed(digits)};`);
  }
  return parts.join("");
};

describe("a base-10000 decimal formatter written in tera", () => {
  it("prints what toFixed prints, at every tier", () => {
    expect(differential(formatter, { tiers: ["baseline", "jit", "osr", "eager"] })).toEqual(
      expected(),
    );
  }, 30000);
});
