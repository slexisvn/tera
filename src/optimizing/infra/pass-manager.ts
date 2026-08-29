import type { AnalysisId, AnalysisManager } from "./analysis-manager.js";
import type { PassTracing } from "./pass-trace.js";
import { remarks, type Remark } from "./pass-remarks.js";
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
  readonly optional?: boolean;
  readonly requires?: ReadonlyArray<AnalysisId<unknown>>;
  run(graph: G, analyses: AnalysisManager<G>, options: CompilerOptions): TransformOutcome;
}

const NOTHING_INVALIDATED: readonly AnalysisId<unknown>[] = [];
const NO_REMARKS: readonly Remark[] = [];
const NOTHING_BROKEN: readonly string[] = [];

export type GraphMaintenance<G> = (graph: G) => void;
export type GraphVerification<G> = (graph: G, pass: string) => readonly string[];

export class VerificationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "VerificationError";
  }
}

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
    let anyChanged = false;
    for (const pass of pipeline) {
      if (this.step(graph, pass)) anyChanged = true;
    }
    return anyChanged;
  }

  private step(graph: G, pass: TransformPass<G>): boolean {
    const tracing = this.tracing;
    const ordinal = this.ordinal++;
    const nodesBefore = tracing === null ? 0 : tracing.probe.nodeCount(graph);

    if (pass.optional === true && this.options.optBisect !== null && !this.options.optBisect.allow()) {
      if (tracing !== null) tracing.trace({
        ordinal,
        pass: pass.name,
        changed: false,
        skipped: true,
        elapsedMs: 0,
        nodesBefore,
        nodesAfter: nodesBefore,
        requires: pass.requires ?? NOTHING_INVALIDATED,
        invalidated: NOTHING_INVALIDATED,
        remarks: NO_REMARKS,
        verification: NOTHING_BROKEN,
        graph,
      });
      return false;
    }

    for (const id of pass.requires ?? []) this.analyses.get(id);
    let outcome: TransformOutcome;
    let noted: readonly Remark[];
    if (tracing !== null) remarks.open(pass.name);
    const started = tracing === null ? 0 : performance.now();
    try {
      outcome = pass.run(graph, this.analyses, this.options);
    } finally {
      noted = remarks.close();
    }
    const elapsedMs = tracing === null ? 0 : performance.now() - started;

    if (outcome.changed && this.maintain !== null) this.maintain(graph);
    const verification =
      outcome.changed && this.verify !== null ? this.verify(graph, pass.name) : NOTHING_BROKEN;
    const invalidated = outcome.changed
      ? this.applyInvalidation(pass.preserves)
      : NOTHING_INVALIDATED;

    if (tracing !== null) tracing.trace({
      ordinal,
      pass: pass.name,
      changed: outcome.changed,
      skipped: false,
      elapsedMs,
      nodesBefore,
      nodesAfter: tracing.probe.nodeCount(graph),
      requires: pass.requires ?? NOTHING_INVALIDATED,
      invalidated,
      remarks: noted,
      verification,
      graph,
    });

    if (verification.length > 0) throw new VerificationError(verification);
    return outcome.changed;
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
