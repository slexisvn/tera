const STEP_SCOPED_KINDS = new Set(['step']);

export function buildBuiltinEnv(languageData) {
  const builtinTypes = new Map();
  const builtinNames = new Set();
  const moduleCalls = new Map();
  for (const builtin of languageData.builtins ?? []) {
    if (STEP_SCOPED_KINDS.has(builtin.kind)) continue;
    builtinNames.add(builtin.name);
    builtinTypes.set(builtin.name, builtin.returns ?? builtin.name);
    if (builtin.kind === 'module' || builtin.kind === 'sequential') moduleCalls.set(builtin.name, builtin.name);
  }
  for (const name of languageData.keywords ?? []) builtinNames.add(name);
  for (const name of Object.keys(languageData.pseudoTypes ?? {})) builtinNames.add(name);
  return { builtinNames, builtinTypes, methodReturns: buildMethodReturns(languageData), moduleCalls };
}

function buildMethodReturns(languageData) {
  const out = new Map();
  for (const [typeName, methods] of Object.entries(languageData.pseudoTypes ?? {})) {
    const entries = new Map();
    for (const method of methods ?? []) {
      if (method?.name) entries.set(method.name, method.returns ?? null);
    }
    out.set(typeName, entries);
  }
  return out;
}
