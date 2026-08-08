export type AnalysisId<T> = symbol & { readonly __analysisResult?: T };

export function analysisId<T>(name: string): AnalysisId<T> {
  return Symbol(name) as AnalysisId<T>;
}

export interface AnalysisPass<G, T> {
  readonly id: AnalysisId<T>;
  run(graph: G, analyses: AnalysisManager<G>): T;
}

export class AnalysisRegistry<G> {
  private readonly passes = new Map<symbol, AnalysisPass<G, unknown>>();

  register<T>(pass: AnalysisPass<G, T>): void {
    this.passes.set(pass.id, pass as AnalysisPass<G, unknown>);
  }

  resolve<T>(id: AnalysisId<T>): AnalysisPass<G, T> {
    const pass = this.passes.get(id);
    if (pass === undefined) {
      throw new Error(`No analysis registered for ${id.description ?? "anonymous"}`);
    }
    return pass as AnalysisPass<G, T>;
  }
}

export class AnalysisManager<G> {
  private readonly cache = new Map<symbol, unknown>();

  constructor(
    private readonly graph: G,
    private readonly registry: AnalysisRegistry<G>,
  ) {}

  get<T>(id: AnalysisId<T>): T {
    if (this.cache.has(id)) return this.cache.get(id) as T;
    const result = this.registry.resolve(id).run(this.graph, this);
    this.cache.set(id, result);
    return result;
  }

  invalidate(id: AnalysisId<unknown>): void {
    this.cache.delete(id);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
