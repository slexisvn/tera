export const id = 'formatter';

export function register(connection, ctx) {
  connection.onDocumentFormatting(params => {
    const doc = ctx.analyzer.get(params.textDocument.uri);
    if (!doc) return [];
    const options = params.options ?? { tabSize: 2, insertSpaces: true };
    const formatted = stripTrailingWhitespace(doc.text, options);
    if (formatted === doc.text) return [];
    const lines = doc.text.split('\n');
    return [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1]?.length ?? 0 },
      },
      newText: formatted,
    }];
  });
}

function stripTrailingWhitespace(text) {
  return text
    .split('\n')
    .map(line => line.replace(/[\t ]+$/, ''))
    .join('\n');
}
