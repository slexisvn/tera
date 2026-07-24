import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const src = (...lines: string[]) => lines.join("\n");

const eagerGc = { allocationBudget: 8, youngGenSize: 16 };

const interpreted = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    gc: eagerGc,
    tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
  });

const baselined = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    gc: eagerGc,
    tieringPolicy: { jitThreshold: 1e12 },
  });

const differential = (source: string) => {
  const expected = interpreted().runNative(source);
  expect(baselined().runNative(source)).toEqual(expected);
  return expected;
};

const accumulating = (...keepBody: string[]) =>
  src(
    "fn churn(i):",
    '  return {p: "" + [i, i + 1], q: [i, i]}',
    "fn keep(i):",
    ...keepBody,
    "fn run(n):",
    "  s = 0",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    "    s = (s + keep(i)) % 1000003",
    "  return s",
    "run(400)",
  );

describe("baseline frames are garbage collection roots", () => {
  it("keeps an object held only in a baseline register alive across allocation", () => {
    expect(
      differential(
        accumulating(
          "  held = {a: i, b: i + 1}",
          "  churn(i)",
          "  churn(i + 1)",
          "  churn(i + 2)",
          "  return held.a + held.b",
        ),
      ),
    ).toEqual(160800);
  });

  it("keeps an array held only in a baseline register alive across allocation", () => {
    expect(
      differential(
        accumulating(
          "  held = [i, i + 1, i + 2]",
          "  churn(i)",
          "  churn(i + 1)",
          "  return held[0] + held[1] + held[2]",
        ),
      ),
    ).toEqual(241800);
  });

  it("keeps a string held only in a baseline register alive across allocation", () => {
    expect(
      differential(
        accumulating(
          '  held = "" + i',
          "  churn(i)",
          "  churn(i + 1)",
          "  return held.length",
        ),
      ),
    ).toEqual(1092);
  });

  it("keeps a nested object reachable after a nested allocation", () => {
    expect(
      differential(
        accumulating(
          "  held = {k: i}",
          "  held.extra = churn(i)",
          "  churn(i + 1)",
          "  return held.k + held.extra.q[0]",
        ),
      ),
    ).toEqual(160400);
  });
});
