import type { TestProject } from "vitest/node";
import { detectCompiler } from "./c-toolchain.js";
import { NATIVE_TIER_VARIABLE } from "./native-tier.js";

declare module "vitest" {
  interface ProvidedContext {
    cCompiler: string | null;
  }
}

export default function setup(project: TestProject): void {
  const tier = project.config.env?.[NATIVE_TIER_VARIABLE] ?? process.env[NATIVE_TIER_VARIABLE];
  project.provide("cCompiler", tier === "full" ? detectCompiler() : null);
}
