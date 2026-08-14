import type { Param } from "./language-data.ts";

export function buildSnippet(name: string, params: Param[]): string {
  if (!params.length) return `${name}()`;
  const required = params.filter((param) => !param.optional && !param.rest);
  if (!required.length) return `${name}($0)`;
  const slots = required.map((param, index) => `\${${index + 1}:${param.name}}`);
  return `${name}(${slots.join(", ")})$0`;
}
