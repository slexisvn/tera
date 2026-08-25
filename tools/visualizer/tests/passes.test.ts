import { describe, expect, it } from "vitest";
import { middleEndPassNames } from "tera/optimizing/drivers/text-driver.js";
import { compilerOptions } from "tera/optimizing/options.js";
import { createBackendRegistry } from "tera/optimizing/backends/index.js";
import { staticCompilerOptions } from "tera/optimizing/optimizer.js";
import { capabilityCheck } from "tera/optimizing/passes/capability-check.js";
import { CFGFunction, irCheckMap, irConstant } from "tera/optimizing/ir/index.js";
import { IR_BUILDER_STAGE } from "tera/optimizing/pipeline.js";
import { noteFor, PASS_NOTES } from "../src/content/passes";
import { VISUALIZER_PASS_NAMES } from "../src/types/stage";

const VISUALIZER_STAGES = [...VISUALIZER_PASS_NAMES, IR_BUILDER_STAGE];

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
    ...VISUALIZER_STAGES,
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

  it("covers the lowering pipeline too, which is most of what a reader clicks", () => {
    const options = compilerOptions("max");
    const missing = new Set<string>();
    for (const backend of createBackendRegistry().list()) {
      for (const pass of backend.loweringPipeline(options)) {
        if (noteFor(pass.name) === null) missing.add(pass.name);
      }
    }

    expect([...missing]).toEqual([]);
  });

  it("explains a rerun by pointing at the base pass and saying why it runs again", () => {
    const rerun = noteFor("sccp-after-escape")!;

    expect(rerun.what).toBe(PASS_NOTES.sccp!.what);
    expect(rerun.rerun).toContain("escape analysis");
  });

  it("keeps the base note free of a rerun line", () => {
    expect(noteFor("sccp")!.rerun).toBeUndefined();
  });

  it("keeps the representation passes off the backends whose values are not tagged", () => {
    const options = compilerOptions("max");

    for (const backend of createBackendRegistry().list()) {
      const named = new Set(backend.loweringPipeline(options).map((pass) => pass.name));
      const tagged = backend.target.capabilities.has("tagged-values");

      expect(named.has("representation-selection")).toBe(tagged);
      expect(named.has("representation-check")).toBe(tagged);
      expect(named.has("zero-divisor")).toBe(!tagged);
    }
  });

  it("says JIT for the representation passes because only the JIT backend is tagged", () => {
    const options = compilerOptions("max");
    const tagged = [...createBackendRegistry().list()].filter((backend) =>
      backend.target.capabilities.has("tagged-values"),
    );

    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((backend) => backend.mode === "jit")).toBe(true);
    expect(noteFor("representation-selection")!.tier).toBe("jit");
    expect(noteFor("representation-check")!.tier).toBe("jit");
  });

  it("says AOT for speculation lowering, because only the JIT settles a guess by deoptimizing", () => {
    const backends = [...createBackendRegistry().list()];
    const deopts = (mode: string) =>
      backends
        .filter((backend) => backend.mode === mode)
        .every((backend) => backend.target.speculation.kind === "deopt-to-interpreter");

    expect(deopts("jit")).toBe(true);
    expect(deopts("aot")).toBe(false);
    expect(noteFor("speculation-lowering")!.tier).toBe("aot");
  });

  it("marks the passes a budget or a capability shuts off on one tier", () => {
    expect(noteFor("allocation-sinking")!.tier).toBe("jit");
    expect(noteFor("ic-lowering")!.tier).toBe("jit");
    expect(noteFor("loop-unswitching")!.tier).toBe("aot");
    expect(noteFor("capability-check")!.tier).toBe("aot");
  });

  it("says JIT for the guard-shaped passes, because no AOT target may hold a guard", () => {
    const guarded = () => {
      const graph = new CFGFunction("guarded");
      const block = graph.addBlock();
      const receiver = irConstant(1);
      block.addNode(receiver);
      block.addNode(irCheckMap(receiver, 1));
      return graph;
    };
    const refuses = (mode: string) =>
      [...createBackendRegistry().list()]
        .filter((backend) => backend.mode === mode)
        .every((backend) => {
          try {
            capabilityCheck(guarded(), backend.target);
            return false;
          } catch {
            return true;
          }
        });

    expect(refuses("aot")).toBe(true);
    expect(refuses("jit")).toBe(false);
    for (const pass of ["allocation-shape", "redundant-checks", "loop-check-peeling"]) {
      expect(noteFor(pass)!.tier).toBe("jit");
    }
  });

  it("keeps dead-store elimination on both tiers, where allocation sinking leaves the AOT one", () => {
    const speculative = new Set(middleEndPassNames(compilerOptions("max")));
    const aheadOfTime = new Set(middleEndPassNames(staticCompilerOptions(compilerOptions("max"))));

    expect(speculative.has("allocation-sinking")).toBe(true);
    expect(aheadOfTime.has("allocation-sinking")).toBe(false);
    expect(aheadOfTime.has("dead-store-elimination")).toBe(true);
    expect(noteFor("dead-store-elimination")!.tier).toBe("both");
    expect(noteFor("allocation-sinking")!.tier).toBe("jit");
  });

  it("answers null for a name nothing wrote a note for", () => {
    expect(noteFor("no-such-pass")).toBeNull();
    expect(noteFor(null)).toBeNull();
  });
});
