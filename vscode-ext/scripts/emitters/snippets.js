const SNIPPET_KINDS = new Set([
  'module', 'optimizer', 'scheduler', 'callback', 'logger', 'metric',
  'trainer', 'factory', 'data',
]);

export function buildSnippets({ builtins }) {
  const snippets = {};
  for (const b of builtins) {
    if (!SNIPPET_KINDS.has(b.kind)) continue;
    if (!b.signature) continue;
    const body = buildBody(b.name, b.signature.params);
    snippets[b.name] = {
      prefix: b.name,
      body: [body],
      description: `${b.kind}: ${b.name}`,
    };
  }
  return snippets;
}

function buildBody(name, params) {
  if (!params.length) return `${name}()`;
  const required = params.filter(p => !p.optional);
  if (!required.length) return `${name}($0)`;
  const slots = required.map((p, i) => `\${${i + 1}:${p.name}}`);
  return `${name}(${slots.join(', ')})$0`;
}
