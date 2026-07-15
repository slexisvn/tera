import { wordRangeAt } from '../analyzer/position.js';

export const id = 'definition';

export function register(connection, ctx) {
  connection.onDefinition(params => {
    try {
      return compute(ctx, params);
    } catch (err) {
      connection.console.error(`definition error: ${err.message}`);
      return null;
    }
  });
}

function compute(ctx, params) {
    const doc = ctx.analyzer.get(params.textDocument.uri);
    if (!doc) return null;
    const word = wordRangeAt(doc.text, params.position);
    if (!word) return null;
    const sym = doc.symbols.resolve(word.text, params.position);
    if (!sym) return null;
    const line = Math.max(0, sym.line - 1);
    const character = Math.max(0, sym.column - 1);
    return {
      uri: params.textDocument.uri,
      range: {
        start: { line, character },
        end: { line, character: character + sym.name.length },
      },
    };
}
