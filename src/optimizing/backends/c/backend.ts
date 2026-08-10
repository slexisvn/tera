import type { CFGFunction } from "../../ir/index.js";
import type { AotBackend, LinkableFunction } from "../../target/backend.js";
import type { Emitter } from "../../target/emitter.js";
import type { AotLinkOptions, AotOutputFile } from "../../target/artifact.js";
import type { AnalysisManager } from "../../infra/analysis-manager.js";
import { BackendLoweringError } from "../../target/errors.js";
import { typeInferenceAnalysisId } from "../../analyses/type-inference.js";
import { cTarget } from "./target.js";
import { targetLegalizationPipeline } from "../../target/legalization.js";
import { emitNumericFunction } from "./emit.js";

export class CBackendEmitError extends BackendLoweringError {
  constructor(reason: string) {
    super(`C backend cannot emit: ${reason}`);
    this.name = "CBackendEmitError";
  }
}

interface CFunction {
  readonly prototype: string;
  readonly definition: string;
  readonly headerPreamble: string;
  readonly translationUnitPreamble: string;
}

function includeGuard(headerName: string): string {
  const token = headerName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return /^[A-Z_]/.test(token) ? token : `H_${token}`;
}

function stripSourcePreamble(source: string, preamble: string): string {
  if (preamble.length === 0) return source;
  const prefix = `${preamble}\n\n`;
  return source.startsWith(prefix) ? source.slice(prefix.length) : source;
}

function joinSections(sections: Iterable<string>): string {
  return [...sections].filter((section) => section.length > 0).join("\n\n");
}

function cFunctionsOf(functions: readonly LinkableFunction[]): CFunction[] {
  const result: CFunction[] = [];
  for (const fn of functions) {
    const artifact = fn.emitted.artifact;
    if (artifact.kind !== "c") continue;
    result.push({
      prototype: artifact.prototype,
      definition: stripSourcePreamble(artifact.source, artifact.sourcePreamble),
      headerPreamble: artifact.headerPreamble,
      translationUnitPreamble: artifact.translationUnitPreamble,
    });
  }
  return result;
}

export const cBackend: AotBackend = {
  id: "c",
  mode: "aot",
  target: cTarget,
  loweringPipeline: () => targetLegalizationPipeline(cTarget),
  createEmitter(graph: CFGFunction, analyses: AnalysisManager<CFGFunction>): Emitter {
    return {
      emit: () => {
        const result = emitNumericFunction(graph, analyses.get(typeInferenceAnalysisId));
        if (!result.ok) throw new CBackendEmitError(result.reason);
        return {
          symbol: result.symbol,
          references: result.references,
          artifact: {
            kind: "c",
            prototype: result.prototype,
            source: result.source,
            headerPreamble: result.headerPreamble,
            sourcePreamble: result.sourcePreamble,
            translationUnitPreamble: result.translationUnitPreamble,
          },
        };
      },
    };
  },
  link(
    functions: readonly LinkableFunction[],
    options: AotLinkOptions,
  ): readonly AotOutputFile[] {
    const headerName = `${options.moduleName}.h`;
    const sourceName = `${options.moduleName}.c`;
    const linked = cFunctionsOf(functions);
    const guard = includeGuard(headerName);
    const prototypes = linked.map((fn) => fn.prototype).join("\n");
    const headerPreamble = joinSections(new Set(linked.map((fn) => fn.headerPreamble)));
    const sourcePreamble = joinSections(
      new Set(linked.map((fn) => fn.translationUnitPreamble)),
    );
    const header =
      `#ifndef ${guard}\n#define ${guard}\n\n` +
      (headerPreamble.length > 0 ? `${headerPreamble}\n\n` : "") +
      (prototypes.length > 0 ? `${prototypes}\n\n` : "") +
      `#endif\n`;
    const source = joinSections([
      `#include "${headerName}"`,
      sourcePreamble,
      linked.map((fn) => fn.definition).join("\n"),
    ]);
    return [
      { name: headerName, contents: header },
      { name: sourceName, contents: source },
    ];
  },
};
