import type { CFGFunction } from "../../ir/index.js";
import type { AotBackend } from "../../target/backend.js";
import type { Emitter } from "../../target/emitter.js";
import { cTarget } from "./target.js";
import { emitNumericFunction } from "./emit.js";

export class CBackendEmitError extends Error {
  constructor(reason: string) {
    super(`C backend cannot emit: ${reason}`);
    this.name = "CBackendEmitError";
  }
}

export const cBackend: AotBackend = {
  id: "c",
  mode: "aot",
  target: cTarget,
  loweringPipeline: () => [],
  createEmitter(graph: CFGFunction): Emitter {
    return {
      emit: () => {
        const result = emitNumericFunction(graph);
        if (!result.ok) throw new CBackendEmitError(result.reason);
        return {
          kind: "c",
          symbol: result.symbol,
          prototype: result.prototype,
          source: result.source,
          headerPreamble: result.headerPreamble,
          sourcePreamble: result.sourcePreamble,
          translationUnitPreamble: result.translationUnitPreamble,
        };
      },
    };
  },
};
