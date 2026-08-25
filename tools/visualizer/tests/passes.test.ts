import { describe, expect, it } from "vitest";
import { middleEndPassNames } from "tera/optimizing/drivers/text-driver.js";
import { compilerOptions } from "tera/optimizing/options.js";
import { createBackendRegistry } from "tera/optimizing/backends/index.js";
import { noteFor, PASS_NOTES } from "../src/content/passes";

const FRONTEND_KEYS = ["tokenize", "parse", "typecheck", "bytecode", "ir-builder", "codegen"];

const MACHINE_STAGES = [
  "instruction-selection",
  "scheduling",
  "two-address-lowering",
  "register-allocation",
  "frame-code",
  "peephole",
];

const MODULE_STAGES = [
  "uniquify-graph-names",
  "name-callee-constants",
  "module-captures",
  "drop-function-bindings",
  "error-surface",
  "module-start",
  "promote-run-once-globals",
  "closure-conversion",
  "promise-surface",
  "argument-specialization",
  "name-function-values",
  "adopt-inferred-types",
  "declare-global-variables",
  "split-generators",
  "module-inlining",
];

function realPassNames(): ReadonlySet<string> {
  const options = compilerOptions("max");
  const names = new Set<string>([
    ...middleEndPassNames(options),
    ...MACHINE_STAGES,
    ...MODULE_STAGES,
    ...FRONTEND_KEYS,
  ]);
  for (const backend of createBackendRegistry().list()) {
    for (const pass of backend.loweringPipeline(options)) names.add(pass.name);
  }
  return names;
}

describe("the teaching notes against the passes that really run", () => {
  it("writes no note for a pass name the compiler does not have", () => {
    const real = realPassNames();
    const invented = Object.keys(PASS_NOTES).filter((name) => !real.has(name));

    expect(invented).toEqual([]);
  });

  it("covers every middle-end pass, counting reruns through their base note", () => {
    const missing = middleEndPassNames(compilerOptions("max")).filter((name) => noteFor(name) === null);

    expect(missing).toEqual([]);
  });

  it("explains a rerun by pointing at the base pass and saying why it runs again", () => {
    const rerun = noteFor("sccp-after-escape")!;

    expect(rerun.what).toBe(PASS_NOTES.sccp!.what);
    expect(rerun.rerun).toContain("escape analysis");
  });

  it("keeps the base note free of a rerun line", () => {
    expect(noteFor("sccp")!.rerun).toBeUndefined();
  });

  it("marks the passes that only one tier can run", () => {
    expect(noteFor("allocation-sinking")!.tier).toBe("jit");
    expect(noteFor("ic-lowering")!.tier).toBe("jit");
    expect(noteFor("loop-unswitching")!.tier).toBe("aot");
    expect(noteFor("capability-check")!.tier).toBe("aot");
  });

  it("answers null for a name nothing wrote a note for", () => {
    expect(noteFor("no-such-pass")).toBeNull();
    expect(noteFor(null)).toBeNull();
  });
});
