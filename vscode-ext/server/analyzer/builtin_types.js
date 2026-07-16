import { STRING, functionType } from '../vendor/types.js';
import { resolveReturn, buildMethodReturns, moduleCallReturn } from '../vendor/method_returns.js';
import { HOST_GLOBALS } from '../vendor/typechecker.js';

const SCALAR_KINDS = new Set(['device', 'dtype', 'constant']);
const TENSOR_MODULE_KINDS = new Set(['module', 'sequential']);
// Documented + highlighted, but NOT global names: only valid inside the scope
// that binds them (e.g. `log` is bound only inside train/validate steps by the
// type checker). Excluding them here makes a top-level call an "undefined name".
const STEP_SCOPED_KINDS = new Set(['step']);

export function buildBuiltinEnv(languageData) {
  const builtinTypes = new Map();
  const builtinNames = new Set();
  const moduleCalls = new Map();
  for (const builtin of languageData.builtins ?? []) {
    if (STEP_SCOPED_KINDS.has(builtin.kind)) continue;
    builtinNames.add(builtin.name);
    builtinTypes.set(builtin.name, SCALAR_KINDS.has(builtin.kind) ? STRING : functionType([], resolveReturn(builtin.returns), true, 0, null, builtin.effect ?? 'sync', true));
    if (TENSOR_MODULE_KINDS.has(builtin.kind)) moduleCalls.set(builtin.name, moduleCallReturn(builtin.name));
  }
  for (const name of languageData.keywords ?? []) builtinNames.add(name);
  for (const name of Object.keys(languageData.pseudoTypes ?? {})) builtinNames.add(name);
  for (const name of HOST_GLOBALS) builtinNames.add(name);
  return { builtinNames, builtinTypes, methodReturns: buildMethodReturns(languageData), moduleCalls };
}
