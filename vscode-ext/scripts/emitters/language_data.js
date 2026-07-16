const SCALAR_KINDS = new Set(['device', 'dtype', 'constant']);

export function buildLanguageData({ keywords, keywordGroups, operators, builtins, pseudoTypes = {} }) {
  return {
    version: 1,
    keywords,
    keywordGroups,
    operators,
    pseudoTypes: serializePseudoTypeMethods(pseudoTypes),
    builtins: builtins.map(b => ({
      name: b.name,
      kind: b.kind,
      description: b.description ?? null,
      returns: b.returns ?? null,
      effect: b.effect ?? 'sync',
      signature: b.signature ? {
        params: b.signature.params,
        display: formatDisplay(b.name, b.signature.params, b.kind, b.returns),
      } : null,
      methods: (b.methods ?? []).map(m => ({
        name: m.name,
        description: m.description ?? null,
        returns: m.returns ?? null,
        effect: m.effect ?? 'sync',
        signature: {
          params: m.params,
          display: formatDisplay(m.name, m.params, b.kind, m.returns),
        },
      })),
    })),
  };
}

function serializePseudoTypeMethods(types) {
  const out = {};
  for (const [name, entry] of Object.entries(types)) {
    out[name] = (entry.methods ?? []).map(m => ({
      name: m.name,
      description: m.description ?? null,
      returns: m.returns ?? null,
      effect: m.effect ?? 'sync',
      isGetter: m.isGetter ?? false,
      signature: {
        params: m.params,
        display: m.isGetter ? m.name : formatDisplay(m.name, m.params, 'method', m.returns),
      },
    }));
  }
  return out;
}

function formatDisplay(name, params, kind, returns = null) {
  if (!params.length && SCALAR_KINDS.has(kind)) return name;
  const parts = params.map(p => {
    const prefix = p.rest ? '...' : '';
    const typed = p.type ? `${p.name}: ${p.type}` : p.name;
    if (p.defaultValue !== null && p.defaultValue !== undefined) {
      return `${prefix}${typed}${p.type ? ' = ' : '='}${p.defaultValue}`;
    }
    if (p.optional && !p.rest) return `${prefix}${p.name}?${p.type ? `: ${p.type}` : ''}`;
    return `${prefix}${typed}`;
  });
  const arrow = returns ? ` -> ${returns}` : '';
  return `${name}(${parts.join(', ')})${arrow}`;
}
