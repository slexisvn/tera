import { parse } from './parser.js';
import { buildBuiltinTypes, collectBuiltinNames, MODULE_CALLS } from './type_signatures.js';
import { typecheck, typecheckWithTypes, HOST_GLOBALS } from './typechecker.js';
import { buildSymbolTable } from './symbol_table.js';

function buildEnv(methodReturns) {
  return {
    builtinNames: new Set([...collectBuiltinNames(), ...HOST_GLOBALS]),
    builtinTypes: buildBuiltinTypes(),
    methodReturns,
    moduleCalls: MODULE_CALLS,
  };
}

export function checkSource(source, { methodReturns } = {}) {
  return { diagnostics: typecheck(parse(source), buildEnv(methodReturns)) };
}

export function analyzeSource(source, { methodReturns } = {}) {
  return typecheckWithTypes(parse(source), buildEnv(methodReturns));
}

export function analyzeDocument(source, { methodReturns } = {}) {
  const program = parse(source);
  const { diagnostics, types } = typecheckWithTypes(program, buildEnv(methodReturns));
  const symbols = buildSymbolTable(program, source, types);
  return { diagnostics, types, symbols };
}
