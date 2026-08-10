import type { AnalysisId, AnalysisManager } from "./analysis-manager.js";
import type { PassTracer } from "./pass-trace.js";
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

const NOTHING_INVALIDATED: readonly AnalysisId<unknown>[] = [];

export class PassManager<G> {
  private ordinal = 0;

  constructor(
    private readonly analyses: AnalysisManager<G>,
    private readonly options: CompilerOptions,
    private readonly tracer: PassTracer<G> | null = null,
  ) {}

  run(graph: G, pipeline: Iterable<TransformPass<G>>): boolean {
    const tracer = this.tracer;
    let anyChanged = false;
    for (const pass of pipeline) {
      for (const id of pass.requires ?? []) this.analyses.get(id);
      const nodesBefore = tracer === null ? 0 : tracer.probe.nodeCount(graph);
      const outcome = pass.run(graph, this.analyses, this.options);
      const invalidated = outcome.changed
        ? this.applyInvalidation(pass.preserves)
        : NOTHING_INVALIDATED;
      if (outcome.changed) anyChanged = true;
      if (tracer === null) continue;
      tracer.sink({
        ordinal: this.ordinal++,
        pass: pass.name,
        changed: outcome.changed,
        nodesBefore,
        nodesAfter: tracer.probe.nodeCount(graph),
        invalidated,
        graph: tracer.probe.dump(graph),
      });
    }
    return anyChanged;
  }

  private applyInvalidation(preservation: Preservation): readonly AnalysisId<unknown>[] {
    if (preservation.kind === "all") return NOTHING_INVALIDATED;
    if (preservation.kind === "none") return this.analyses.invalidateAll();
    if (preservation.kind === "only") {
      return this.analyses.invalidateExcept(new Set(preservation.preserved));
    }
    const invalidated: AnalysisId<unknown>[] = [];
    for (const id of preservation.invalidated) invalidated.push(...this.analyses.invalidate(id));
    return invalidated;
  }
}
