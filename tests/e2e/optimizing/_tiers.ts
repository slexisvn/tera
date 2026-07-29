import { expect } from "vitest";
import { Engine } from "../../../src/index.js";

export const src = (...lines: string[]) => lines.join("\n");

const TIERS = {
  oracle: { osr: false, tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 } },
  baseline: { osr: false, tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 3 } },
  jit: { osr: false, tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 } },
  osr: { tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 } },
} as const;

export type Tier = keyof typeof TIERS;

const engineFor = (tier: Tier, gc?: object) =>
  new Engine({ typecheck: "off", ...(gc ? { gc } : {}), ...TIERS[tier] });

export const oracle = (gc?: object) => engineFor("oracle", gc);
export const baseline = (gc?: object) => engineFor("baseline", gc);
export const jit = (gc?: object) => engineFor("jit", gc);
export const osrEngine = (gc?: object) => engineFor("osr", gc);

export type DiffOpts = { tiers?: Tier[]; gc?: object };

export const differential = (
  source: string,
  { tiers = ["baseline", "jit", "osr"], gc }: DiffOpts = {},
) => {
  const expected = engineFor("oracle", gc).runNative(source);
  for (const tier of tiers) expect(engineFor(tier, gc).runNative(source)).toEqual(expected);
  return expected;
};

export const tierUp = (source: string, name = "run") => {
  const engine = engineFor("jit");
  expect(engine.runNative(source)).toEqual(engineFor("oracle").runNative(source));
  const fn = engine.collectFunctions().find((f) => f.name === name) as
    | (Record<string, unknown> & { compiled?: Record<string, unknown> })
    | undefined;
  return fn?.compiled ?? fn;
};
