import languageData from '../vscode-ext/language-data.json' with { type: 'json' };
import { buildMethodReturns } from './method_returns.js';

let cachedMethodReturns = null;

export function defaultMethodReturns() {
  if (!cachedMethodReturns) cachedMethodReturns = buildMethodReturns(languageData);
  return cachedMethodReturns;
}
