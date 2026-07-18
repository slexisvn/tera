import type { AnalyzedDocument } from "./analyzer/index.ts";

export type AnalyzerEvents = {
  analyzed: { uri: string; document: AnalyzedDocument };
  closed: { uri: string };
};

type Listener<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<Events[K]>)(payload);
    }
  }
}

export type AnalyzerBus = EventBus<AnalyzerEvents>;
