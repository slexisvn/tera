import { buildSnippet } from "../../src/shared/snippet.ts";
import type { BuiltinSource } from "./language-data.ts";

const SNIPPET_KINDS = new Set([
  "module", "sequential", "optimizer", "scheduler", "callback", "logger", "metric",
  "trainer", "factory", "data",
  "ml_model", "ml_transform", "ml_cluster", "ml_split",
]);

export type Snippet = {
  prefix: string;
  body: string[];
  description: string;
};

export function buildSnippets(config: { builtins: BuiltinSource[] }): Record<string, Snippet> {
  const snippets: Record<string, Snippet> = {};
  for (const builtin of config.builtins) {
    if (!SNIPPET_KINDS.has(builtin.kind) || !builtin.signature) continue;
    snippets[builtin.name] = {
      prefix: builtin.name,
      body: [buildSnippet(builtin.name, builtin.signature.params)],
      description: `${builtin.kind}: ${builtin.name}`,
    };
  }
  return snippets;
}
