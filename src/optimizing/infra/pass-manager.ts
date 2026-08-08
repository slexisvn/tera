import type { AnalysisId, AnalysisManager } from "./analysis-manager.js";
import type { CompilerOptions } from "../options.js";

export interface TransformOutcome {
  readonly changed: boolean;
}

export type Preservation =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "allExcept"; readonly invalidated: ReadonlyArray<AnalysisId<unknown>> };

export interface TransformPass<G> {
  readonly name: string;
  readonly preserves: Preservation;
  run(graph: G, analyses: AnalysisManager<G>, options: CompilerOptions): TransformOutcome;
}

export class PassManager<G> {
  constructor(
    private readonly analyses: AnalysisManager<G>,
    private readonly options: CompilerOptions,
  ) {}

  run(graph: G, pipeline: Iterable<TransformPass<G>>): boolean {
    let anyChanged = false;
    for (const pass of pipeline) {
      const outcome = pass.run(graph, this.analyses, this.options);
      if (!outcome.changed) continue;
      anyChanged = true;
      this.applyInvalidation(pass.preserves);
    }
    return anyChanged;
  }

  private applyInvalidation(preservation: Preservation): void {
    if (preservation.kind === "all") return;
    if (preservation.kind === "none") {
      this.analyses.invalidateAll();
      return;
    }
    for (const id of preservation.invalidated) this.analyses.invalidate(id);
  }
}
