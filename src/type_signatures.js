import {
  installBuiltins, FACTORIES, FREE_TENSOR_FUNCTIONS, COLUMN_AGGREGATES, MODULES,
} from './builtins.js';
import { ANY, NUMBER, STRING, NONE, TENSOR, listType, moduleType, functionType } from './types.js';
import { moduleCallReturn } from './method_returns.js';
import { builtinEffect } from './effects.js';

const CONSTANT_NAMES = ['cpu', 'gpu', 'wasm', 'webgpu', 'f16', 'f32', 'f64', 'i32', 'i64', 'bool'];

export const MODULE_CALLS = new Map([...MODULES, 'Sequential'].map(name => [name, moduleCallReturn(name)]));

function returnOverrides() {
  return new Map([
    ['len', NUMBER], ['range', listType(NUMBER)], ['shape', listType(NUMBER)],
    ['dtype', STRING], ['read_text', STRING], ['trace', STRING], ['graph', STRING],
    ['print', NONE], ['backward', NONE],
    ['load_csv', moduleType('DataFrame')], ['DataFrame', moduleType('DataFrame')],
    ['Tokenizer', moduleType('Tokenizer')], ['load_tokenizer', moduleType('Tokenizer')],
  ]);
}

function builtinFunction(name, ret) {
  return functionType([], ret, true, 0, null, builtinEffect(name), true);
}

export function buildBuiltinTypes() {
  const types = new Map();
  const overrides = returnOverrides();
  const setFn = (name, ret) => types.set(name, builtinFunction(name, overrides.get(name) ?? ret));
  for (const name of FACTORIES) setFn(name, TENSOR);
  for (const name of FREE_TENSOR_FUNCTIONS) setFn(name, TENSOR);
  for (const name of COLUMN_AGGREGATES) setFn(name, ANY);
  for (const name of MODULES) setFn(name, moduleType(name));
  for (const name of overrides.keys()) if (!types.has(name)) setFn(name, ANY);
  for (const name of CONSTANT_NAMES) types.set(name, STRING);
  return types;
}

let cachedNames = null;

export function collectBuiltinNames() {
  if (cachedNames) return cachedNames;
  const names = new Set();
  const stub = { output() {}, compile() {} };
  installBuiltins(stub, name => names.add(name));
  cachedNames = names;
  return names;
}
