import { SemanticTokensBuilder } from 'vscode-languageserver';

export const id = 'semanticTokens';

export const legend = {
  tokenTypes: [
    'namespace', 'class', 'enumMember', 'parameter', 'variable',
    'function', 'keyword', 'method',
  ],
  tokenModifiers: ['declaration'],
};

const KIND_TO_TYPE = {
  model: 'class',
  function: 'function',
  parameter: 'parameter',
  variable: 'variable',
  module: 'class',
  optimizer: 'class',
  scheduler: 'class',
  metric: 'class',
  callback: 'class',
  logger: 'class',
  trainer: 'class',
  sequential: 'class',
  device: 'enumMember',
  dtype: 'enumMember',
  factory: 'function',
  reduction: 'function',
  utility: 'function',
  shape: 'function',
  autograd: 'function',
  data: 'function',
  step: 'function',
  constant: 'enumMember',
};

export function register(connection, ctx) {
  connection.languages.semanticTokens.on(params => {
    const doc = ctx.analyzer.get(params.textDocument.uri);
    if (!doc) return { data: [] };
    return buildTokens(doc, ctx.languageData, legend);
  });
}

function buildTokens(doc, languageData, legend) {
  const typeIndex = new Map(legend.tokenTypes.map((t, i) => [t, i]));
  const builder = new SemanticTokensBuilder();
  const builtinByName = new Map(languageData.builtins.map(b => [b.name, b]));
  const symbolByName = new Map();
  for (const s of doc.symbols.flat) symbolByName.set(s.name, s);

  const tokens = doc.tokens ?? [];
  let callDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.value === '(' || tok.value === '[') callDepth++;
    else if (tok.value === ')' || tok.value === ']') callDepth = Math.max(0, callDepth - 1);
    if (tok.type !== 'identifier') continue;
    const type = resolveTokenType(tokens, i, callDepth, builtinByName, symbolByName);
    if (!type) continue;
    const line = Math.max(0, tok.line - 1);
    const character = Math.max(0, tok.column - 1);
    builder.push(line, character, tok.value.length, typeIndex.get(type), 0);
  }
  return builder.build();
}

function resolveTokenType(tokens, i, callDepth, builtinByName, symbolByName) {
  if (callDepth > 0 && tokens[i + 1]?.value === '=') return 'parameter';
  if (tokens[i - 1]?.value === '.') return tokens[i + 1]?.value === '(' ? 'method' : null;
  return resolveType(tokens[i].value, builtinByName, symbolByName);
}

function resolveType(name, builtinByName, symbolByName) {
  const builtin = builtinByName.get(name);
  if (builtin) return KIND_TO_TYPE[builtin.kind];
  return KIND_TO_TYPE[symbolByName.get(name)?.kind];
}
