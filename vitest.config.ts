import { defineConfig } from "vitest/config";

const EVERYTHING = ["tests/**/*.test.ts"];
const END_TO_END = ["tests/e2e/**/*.test.ts"];
const WITHOUT_END_TO_END = ["tests/e2e/**"];

const shared = {
  environment: "node",
  testTimeout: 60000,
  isolate: false,
  globalSetup: "tests/helpers/global-setup.ts",
  maxWorkers: process.env.TERA_TEST_WORKERS ?? "40%",
} as const;

interface Tier {
  readonly name: string;
  readonly level: "off" | "native" | "full";
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

const TIERS: readonly Tier[] = [
  { name: "unit", level: "off", include: EVERYTHING, exclude: WITHOUT_END_TO_END },
  { name: "e2e", level: "off", include: END_TO_END },
  { name: "native", level: "native", include: EVERYTHING },
  { name: "full", level: "full", include: EVERYTHING },
];

export default defineConfig({
  test: {
    projects: TIERS.map(({ name, level, include, exclude }) => ({
      test: {
        ...shared,
        name,
        include: [...include],
        ...(exclude ? { exclude: [...exclude] } : {}),
        env: { TERA_NATIVE: level },
      },
    })),
  },
});
