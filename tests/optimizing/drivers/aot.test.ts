import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irReturn,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { compileModule } from "../../../src/optimizing/drivers/aot.js";
import { cTarget } from "../../../src/optimizing/backends/c/target.js";
import type { AotBackend, LinkableFunction } from "../../../src/optimizing/target/backend.js";
import type {
  AotOutputFile,
  BackendArtifact,
} from "../../../src/optimizing/target/artifact.js";

interface TextModuleArtifact extends BackendArtifact {
  readonly kind: "text-module";
  readonly module: string;
}

function isTextModule(artifact: BackendArtifact): artifact is TextModuleArtifact {
  return artifact.kind === "text-module";
}

beforeEach(() => resetIRNodeIds());

function returnsConstant(name: string, value: number): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  const constant = irConstant(value);
  block.addNode(constant);
  block.addNode(irReturn(constant));
  return graph;
}

function textModuleBackend(references: Record<string, readonly string[]> = {}): AotBackend {
  return {
    id: "text-module",
    mode: "aot",
    target: cTarget,
    symbolOf: (name: string) => name,
    loweringPipeline: () => [],
    createEmitter: (graph) => ({
      emit: () => ({
        symbol: graph.name,
        references: references[graph.name] ?? [],
        artifact: { kind: "text-module", module: `define @${graph.name}()` } as TextModuleArtifact,
      }),
    }),
    link: (functions: readonly LinkableFunction[]): readonly AotOutputFile[] => [
      {
        name: "module.txt",
        contents: functions
          .map((fn) => (isTextModule(fn.emitted.artifact) ? fn.emitted.artifact.module : ""))
          .join("\n"),
      },
    ],
  };
}

describe("compileModule is backend agnostic", () => {
  it("emits a backend that produces no C at all", () => {
    const program = compileModule(
      moduleFromGraphs([returnsConstant("answer", 42)], "module"),
      textModuleBackend(),
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.name)).toEqual(["answer"]);
    expect(program.files).toEqual([{ name: "module.txt", contents: "define @answer()" }]);
  });

  it("prunes unresolved callers for a non-C backend too", () => {
    const program = compileModule(
      moduleFromGraphs(
        [returnsConstant("caller", 1), returnsConstant("unrelated", 2)],
        "module",
      ),
      textModuleBackend({ caller: ["missing"] }),
    );

    expect(program.compiled.map((fn) => fn.name)).toEqual(["unrelated"]);
    expect(program.skipped).toEqual([
      { name: "caller", reason: "calls unavailable function missing" },
    ]);
    expect(program.files[0]!.contents).toBe("define @unrelated()");
  });

  it("links a dropped caller to the skipped function it was waiting for", () => {
    const program = compileModule(
      moduleFromGraphs([returnsConstant("caller", 1)], "module"),
      textModuleBackend({ caller: ["helper"] }),
      { skipped: [{ name: "helper", reason: "backend said no" }] },
    );

    expect(program.skipped).toEqual([
      { name: "helper", reason: "backend said no" },
      { name: "caller", reason: "calls unavailable function helper", missing: "helper" },
    ]);
  });

  it("lets the backend name its own output files", () => {
    const program = compileModule(
      moduleFromGraphs([returnsConstant("answer", 42)], "module"),
      textModuleBackend(),
      { moduleName: "ignored-by-this-backend" },
    );

    expect(program.files.map((file) => file.name)).toEqual(["module.txt"]);
  });
});
