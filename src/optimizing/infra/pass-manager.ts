import type { AnalysisId, AnalysisManager } from "./analysis-manager.js";
import type { PassTracing } from "./pass-trace.js";
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

export type GraphMaintenance<G> = (graph: G) => void;
export type GraphVerification<G> = (graph: G, pass: string) => void;

export interface PassManagerHooks<G> {
  readonly tracing?: PassTracing<G> | null;
  readonly maintain?: GraphMaintenance<G> | null;
  readonly verify?: GraphVerification<G> | null;
}

export class PassManager<G> {
  private ordinal = 0;
  private readonly tracing: PassTracing<G> | null;
  private readonly maintain: GraphMaintenance<G> | null;
  private readonly verify: GraphVerification<G> | null;

  constructor(
    private readonly analyses: AnalysisManager<G>,
    private readonly options: CompilerOptions,
    hooks: PassManagerHooks<G> = {},
  ) {
    this.tracing = hooks.tracing ?? null;
    this.maintain = hooks.maintain ?? null;
    this.verify = hooks.verify ?? null;
  }

  run(graph: G, pipeline: Iterable<TransformPass<G>>): boolean {
    const tracing = this.tracing;
    let anyChanged = false;
    for (const pass of pipeline) {
      for (const id of pass.requires ?? []) this.analyses.get(id);
      const nodesBefore = tracing === null ? 0 : tracing.probe.nodeCount(graph);
      const outcome = pass.run(graph, this.analyses, this.options);
      if (outcome.changed && this.maintain !== null) this.maintain(graph);
      if (outcome.changed && this.verify !== null) this.verify(graph, pass.name);
      const invalidated = outcome.changed
        ? this.applyInvalidation(pass.preserves)
        : NOTHING_INVALIDATED;
      if (outcome.changed) anyChanged = true;
      if (tracing === null) continue;
      tracing.trace({
        ordinal: this.ordinal++,
        pass: pass.name,
        changed: outcome.changed,
        nodesBefore,
        nodesAfter: tracing.probe.nodeCount(graph),
        invalidated,
        graph,
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
