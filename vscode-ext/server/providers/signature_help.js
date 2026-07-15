import { lineAt } from '../analyzer/position.js';

export const id = 'signatureHelp';

const CALLEE_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)$/;

export function register(connection, ctx) {
  connection.onSignatureHelp(params => {
    const doc = ctx.analyzer.get(params.textDocument.uri);
    if (!doc) return null;
    const line = lineAt(doc.text, params.position.line);
    const prefix = line.slice(0, params.position.character);
    const match = prefix.match(CALLEE_PATTERN);
    if (!match) return null;
    const builtin = ctx.languageData.builtins.find(b => b.name === match[1]);
    if (!builtin?.signature) return null;
    const activeParam = countCommas(match[2]);
    return {
      signatures: [{
        label: builtin.signature.display,
        parameters: builtin.signature.params.map(p => ({ label: p.name })),
      }],
      activeSignature: 0,
      activeParameter: Math.min(activeParam, builtin.signature.params.length - 1),
    };
  });
}

function countCommas(text) {
  let depth = 0;
  let count = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}
