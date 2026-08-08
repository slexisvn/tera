import type { AnalysisId, AnalysisManager } from "./analysis-manager.js";
import type { CompilerOptions } from "../options.js";

export interface TransformOutcome {
  readonly changed: boolean;
}

export type Preservation =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "only"; readonly preserved: ReadonlyArray<AnalysisId<unknown>> }
  | { readonly kind: "allExcept"; readonly invalidated: ReadonlyArray<AnalysisId<unknown>> };

export interface TransformPass<G> {
  readonly name: string;
  readonly preserves: Preservation;
  readonly requires?: ReadonlyArray<AnalysisId<unknown>>;
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
      for (const id of pass.requires ?? []) this.analyses.get(id);
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
    if (preservation.kind === "only") {
      this.analyses.invalidateExcept(new Set(preservation.preserved));
      return;
    }
    for (const id of preservation.invalidated) this.analyses.invalidate(id);
  }
}
