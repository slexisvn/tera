import { parse } from './parser.js';
import { buildBuiltinTypes, collectBuiltinNames, MODULE_CALLS } from './type_signatures.js';
import { typecheckWithTypes, HOST_GLOBALS } from './typechecker.js';

function buildEnv(methodReturns, globals = new Map()) {
  const builtinTypes = buildBuiltinTypes();
  for (const [name, type] of globals) builtinTypes.set(name, type);
  return {
    builtinNames: new Set([...collectBuiltinNames(), ...HOST_GLOBALS]),
    builtinTypes,
    methodReturns,
    moduleCalls: MODULE_CALLS,
  };
}

export function parseAndElaborate(source, { methodReturns, globals } = {}) {
  const program = typeof source === 'string' ? parse(source) : source;
  const result = typecheckWithTypes(program, buildEnv(methodReturns, globals));
  return { program, ...result, effect: program.effect ?? 'sync' };
}
