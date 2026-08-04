export type SessionState = {
  source(): string;
  append(code: string): void;
  reset(): void;
};

export function createSessionState(): SessionState {
  let source = "";
  return {
    source: () => source,
    append(code) {
      const trimmed = code.trim();
      if (!trimmed) return;
      source = source ? `${source}\n${trimmed}` : trimmed;
    },
    reset() {
      source = "";
    },
  };
}
