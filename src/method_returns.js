import { ANY, INT, FLOAT, STRING, BOOL, NONE, TENSOR, listType, moduleType } from './types.js';

export const MULTI_OUTPUT_MODULES = new Set(['LSTM', 'GRU', 'LSTMCell', 'GRUCell']);

export function moduleCallReturn(name) {
  return MULTI_OUTPUT_MODULES.has(name) ? listType(TENSOR) : TENSOR;
}

export function resolveReturn(name) {
  if (!name) return ANY;
  if (name.endsWith('[]')) return listType(resolveReturn(name.slice(0, -2)));
  if (name === 'Tensor') return TENSOR;
  if (name === 'int') return INT;
  if (name === 'float') return FLOAT;
  if (name === 'string' || name === 'str') return STRING;
  if (name === 'boolean' || name === 'bool') return BOOL;
  if (name === 'none') return NONE;
  return moduleType(name);
}

function methodsOf(entry) {
  return Array.isArray(entry) ? entry : entry?.methods ?? [];
}

export function buildMethodReturns(languageData) {
  const methodReturns = new Map();
  const record = (typeName, methods) => {
    let map = methodReturns.get(typeName);
    for (const method of methods) {
      if (!method.returns) continue;
      if (!map) { map = new Map(); methodReturns.set(typeName, map); }
      map.set(method.name, resolveReturn(method.returns));
    }
  };
  for (const [typeName, entry] of Object.entries(languageData.pseudoTypes ?? {})) record(typeName, methodsOf(entry));
  for (const builtin of languageData.builtins ?? []) record(builtin.name, builtin.methods ?? []);
  return methodReturns;
}
