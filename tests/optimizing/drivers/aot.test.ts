import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irReturn,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import {
  AotLinkError,
  AotUndeclaredParameterError,
  compileModule,
} from "../../../src/optimizing/drivers/aot.js";
import { cTarget } from "../../../src/optimizing/backends/c/target.js";
import type { AotBackend, LinkableFunction } from "../../../src/optimizing/target/backend.js";
import type {
  AotLinkOptions,
  AotOutputFile,
  BackendArtifact,
} from "../../../src/optimizing/target/artifact.js";
import { BackendLoweringError } from "../../../src/optimizing/target/errors.js";

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

function capturingBackend(seen: { options?: AotLinkOptions }): AotBackend {
  const base = textModuleBackend();
  return {
    ...base,
    link: (functions: readonly LinkableFunction[], options: AotLinkOptions) => {
      seen.options = options;
      return base.link(functions, options);
    },
  };
}

function refusingBackend(message: string): AotBackend {
  const base = textModuleBackend();
  return {
    ...base,
    link: () => {
      throw new BackendLoweringError(message);
    },
  };
}

function takingOneParameter(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  const parameter = graph.addParameter(0);
  const block = graph.addBlock();
  block.addNode(irReturn(parameter));
  return graph;
}

describe("compileModule refuses a module it cannot compile ahead of time", () => {
  it("refuses a parameter whose type the source never declared, naming the function", () => {
    const module = moduleFromGraphs([takingOneParameter("loose")], "module");

    expect(() => compileModule(module, textModuleBackend())).toThrow(AotUndeclaredParameterError);
  });

  it("carries every undeclared parameter it found on the error it raises", () => {
    const module = moduleFromGraphs(
      [takingOneParameter("loose"), takingOneParameter("looser")],
      "module",
    );
    let caught: AotUndeclaredParameterError | null = null;
    try {
      compileModule(module, textModuleBackend());
    } catch (error) {
      caught = error as AotUndeclaredParameterError;
    }

    expect(caught?.undeclared.map((fn) => fn.name)).toEqual(["loose", "looser"]);
    expect(caught?.message).toContain("every parameter to have a declared type");
  });

  it("wraps a backend that refuses to link as an AotLinkError", () => {
    const module = moduleFromGraphs([returnsConstant("answer", 42)], "module");

    expect(() => compileModule(module, refusingBackend("nothing to link"))).toThrow(AotLinkError);
    expect(() => compileModule(module, refusingBackend("nothing to link"))).toThrow(
      "nothing to link",
    );
  });

  it("hands the skipped list to whoever catches the link failure", () => {
    const module = moduleFromGraphs([returnsConstant("answer", 42)], "module");
    let caught: AotLinkError | null = null;
    try {
      compileModule(module, refusingBackend("nothing to link"), {
        skipped: [{ name: "helper", reason: "backend said no" }],
      });
    } catch (error) {
      caught = error as AotLinkError;
    }

    expect(caught?.skipped).toEqual([{ name: "helper", reason: "backend said no" }]);
  });
});

describe("what compileModule tells the backend to link", () => {
  it("passes the module name the caller chose", () => {
    const seen: { options?: AotLinkOptions } = {};
    compileModule(moduleFromGraphs([returnsConstant("answer", 42)], "module"), capturingBackend(seen), {
      moduleName: "chosen",
    });

    expect(seen.options?.moduleName).toBe("chosen");
  });

  it("falls back to a default module name when the caller chose none", () => {
    const seen: { options?: AotLinkOptions } = {};
    compileModule(moduleFromGraphs([returnsConstant("answer", 42)], "module"), capturingBackend(seen));

    expect(seen.options?.moduleName).toBe("program");
  });

  it("passes the output shape the caller asked for through untouched", () => {
    const seen: { options?: AotLinkOptions } = {};
    compileModule(moduleFromGraphs([returnsConstant("answer", 42)], "module"), capturingBackend(seen), {
      format: "object",
      entry: "answer",
      result: "exit",
      heapBytes: 4096,
    });

    expect(seen.options?.format).toBe("object");
    expect(seen.options?.entry).toBe("answer");
    expect(seen.options?.result).toBe("exit");
    expect(seen.options?.heapBytes).toBe(4096);
  });

  it("passes the functions it skipped so the backend can explain a missing entry", () => {
    const seen: { options?: AotLinkOptions } = {};
    compileModule(moduleFromGraphs([returnsConstant("answer", 42)], "module"), capturingBackend(seen), {
      skipped: [{ name: "helper", reason: "backend said no" }],
    });

    expect(seen.options?.skipped).toEqual([{ name: "helper", reason: "backend said no" }]);
  });

  it("resolves each module initializer through the backend's own symbol naming", () => {
    const seen: { options?: AotLinkOptions } = {};
    const program = compileModule(
      moduleFromGraphs([returnsConstant("answer", 42)], "module"),
      capturingBackend(seen),
      { moduleInits: ["init_a", "init_b"] },
    );

    expect(seen.options?.moduleInits).toEqual(["init_a", "init_b"]);
    expect(program.moduleInits).toEqual(["init_a", "init_b"]);
  });

  it("reports no initializers when the caller named none", () => {
    const program = compileModule(
      moduleFromGraphs([returnsConstant("answer", 42)], "module"),
      textModuleBackend(),
    );

    expect(program.moduleInits).toEqual([]);
  });

  it("links exactly the functions it reports as compiled", () => {
    const seen: { options?: AotLinkOptions } = {};
    const program = compileModule(
      moduleFromGraphs([returnsConstant("one", 1), returnsConstant("two", 2)], "module"),
      capturingBackend(seen),
    );

    expect(program.compiled.map((fn) => fn.name)).toEqual(["one", "two"]);
    expect(program.skipped).toEqual([]);
  });
});
