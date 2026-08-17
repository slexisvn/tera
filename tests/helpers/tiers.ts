import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { nodeEngine } from "./engine.js";

export const src = (...lines: string[]) => lines.join("\n");

const TIERS = {
  oracle: { osr: false, tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 } },
  baseline: { osr: false, tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 3 } },
  jit: { osr: false, tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 } },
  osr: { tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 } },
  baselineOsr: { tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 3 } },
  production: {},
} as const;

export type Tier = keyof typeof TIERS;

const engineFor = (tier: Tier, gc?: object) =>
  nodeEngine({ typecheck: "off", ...(gc ? { gc } : {}), ...TIERS[tier] });

export const oracle = (gc?: object) => engineFor("oracle", gc);
export const baseline = (gc?: object) => engineFor("baseline", gc);
export const jit = (gc?: object) => engineFor("jit", gc);
export const osrEngine = (gc?: object) => engineFor("osr", gc);
export const baselineOsrEngine = (gc?: object) => engineFor("baselineOsr", gc);
export const production = (gc?: object) => engineFor("production", gc);

export type DiffOpts = { tiers?: Tier[]; gc?: object };

export const differential = (
  source: string,
  { tiers = ["baseline", "jit", "osr"], gc }: DiffOpts = {},
) => {
  const expected = engineFor("oracle", gc).runNative(source);
  for (const tier of tiers) expect(engineFor(tier, gc).runNative(source)).toEqual(expected);
  return expected;
};

export type ModuleFiles = Record<string, string>;

const moduleRoots: string[] = [];

export const writeModuleProject = (files: ModuleFiles): string => {
  const root = mkdtempSync(join(tmpdir(), "tera-diff-"));
  moduleRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return root;
};

export const cleanModuleProjects = (): void => {
  while (moduleRoots.length > 0) rmSync(moduleRoots.pop()!, { recursive: true, force: true });
};

export const differentialModules = (
  files: ModuleFiles,
  { tiers = ["baseline", "jit", "osr"], gc, entry = "main.tera" }: DiffOpts & { entry?: string } = {},
) => {
  const root = writeModuleProject(files);
  const run = (tier: Tier) =>
    engineFor(tier, gc).runModuleNative(join(root, entry), { root });
  const expected = run("oracle");
  for (const tier of tiers) expect(run(tier)).toEqual(expected);
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
