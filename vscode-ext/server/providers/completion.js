import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver';
import { lineAt } from '../analyzer/position.js';

export const id = 'completion';

const KIND_TO_LSP = {
  model: CompletionItemKind.Class,
  function: CompletionItemKind.Function,
  parameter: CompletionItemKind.Variable,
  variable: CompletionItemKind.Variable,
  module: CompletionItemKind.Class,
  factory: CompletionItemKind.Function,
  reduction: CompletionItemKind.Function,
  optimizer: CompletionItemKind.Class,
  scheduler: CompletionItemKind.Class,
  callback: CompletionItemKind.Class,
  logger: CompletionItemKind.Class,
  metric: CompletionItemKind.Class,
  trainer: CompletionItemKind.Class,
  data: CompletionItemKind.Function,
  sequential: CompletionItemKind.Class,
  autograd: CompletionItemKind.Function,
  shape: CompletionItemKind.Function,
  utility: CompletionItemKind.Function,
  device: CompletionItemKind.EnumMember,
  dtype: CompletionItemKind.EnumMember,
  constant: CompletionItemKind.Constant,
};

export function register(connection, ctx) {
  connection.onCompletion(params => {
    try {
      const doc = ctx.analyzer.get(params.textDocument.uri);
      const result = doc
        ? collectCompletions(doc, params.position, ctx.languageData)
        : { isIncomplete: false, items: [] };
      connection.console.info(`completion ${params.textDocument.uri} @${params.position.line}:${params.position.character} → ${result.items.length} items`);
      return result;
    } catch (err) {
      connection.console.error(`completion error: ${err.message}\n${err.stack}`);
      return { isIncomplete: false, items: [] };
    }
  });
}

function visibleSymbols(symbols, position) {
  const scope = symbols.findScopeAt(position);
  const out = [];
  let cursor = scope;
  while (cursor) {
    out.push(...cursor.symbols);
    cursor = cursor.parent;
  }
  return out;
}

function collectCompletions(doc, position, languageData) {
  const member = readMemberContext(doc.text, position);
  if (member) {
    return { isIncomplete: false, items: collectMemberCompletions(doc, member, position, languageData) };
  }
  const items = [];
  const call = findEnclosingCall(doc.text, position);
  if (call) {
    const builtin = languageData.builtins.find(b => b.name === call.callee);
    if (builtin?.signature?.params?.length) {
      const usedNames = new Set(call.usedArgs);
      for (const p of builtin.signature.params) {
        if (usedNames.has(p.name)) continue;
        items.push({
          label: `${p.name}=`,
          kind: CompletionItemKind.Field,
          detail: paramHint(p),
          insertText: `${p.name}=`,
          sortText: `0_${p.name}`,
          filterText: p.name,
        });
      }
    }
  }
  for (const name of languageData.keywords) {
    items.push({ label: name, kind: CompletionItemKind.Keyword, sortText: `1_${name}` });
  }
  for (const b of languageData.builtins) {
    const item = {
      label: b.name,
      kind: KIND_TO_LSP[b.kind] ?? CompletionItemKind.Function,
      detail: b.signature?.display ?? b.kind,
      sortText: `2_${b.name}`,
    };
    if (b.description) {
      item.documentation = { kind: 'markdown', value: b.description };
    }
    if (b.signature) {
      item.insertText = buildSnippet(b.name, b.signature.params);
      item.insertTextFormat = InsertTextFormat.Snippet;
    }
    items.push(item);
  }
  for (const sym of dedupeSymbols(visibleSymbols(doc.symbols, position))) {
    items.push({
      label: sym.name,
      kind: KIND_TO_LSP[sym.kind] ?? CompletionItemKind.Variable,
      detail: sym.kind,
      sortText: `3_${sym.name}`,
    });
  }
  return { isIncomplete: false, items };
}

function buildSnippet(name, params) {
  if (!params.length) return `${name}()`;
  const required = params.filter(p => !p.optional);
  if (!required.length) return `${name}($0)`;
  const slots = required.map((p, i) => `\${${i + 1}:${p.name}}`);
  return `${name}(${slots.join(', ')})$0`;
}

function dedupeSymbols(symbols) {
  const seen = new Set();
  const out = [];
  for (const s of symbols) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out;
}

function resolveMethods(typeName, languageData, seen = new Set()) {
  if (!typeName || seen.has(typeName)) return [];
  seen.add(typeName);
  const builtin = languageData.builtins.find(b => b.name === typeName);
  if (builtin?.methods?.length) return builtin.methods;
  // A constructor builtin (e.g. DataFrame) and the value type's pseudoType can
  // share a name; the methods live on the pseudoType.
  const pseudo = languageData.pseudoTypes?.[typeName];
  if (pseudo) return pseudo;
  if (builtin?.returns && builtin.returns !== typeName) return resolveMethods(builtin.returns, languageData, seen);
  return [];
}

function readMemberContext(text, position) {
  const line = lineAt(text, position.line);
  const before = line.slice(0, position.character);
  const match = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (!match) return null;
  return { receiver: match[1] };
}

function collectMemberCompletions(doc, member, position, languageData) {
  const symbol = doc.symbols.resolve(member.receiver, position);
  const typeName = symbol?.typeName ?? member.receiver;
  // A user model instance: offer its own fields plus the generic Module methods.
  const modelScope = doc.symbols.scopes.find(s => s.name === typeName);
  const methods = modelScope ? (languageData.pseudoTypes?.Model ?? []) : resolveMethods(typeName, languageData);
  const items = methods.map(m => {
    const item = {
      label: m.name,
      kind: m.isGetter ? CompletionItemKind.Property : CompletionItemKind.Method,
      detail: m.signature.display,
      sortText: `1_${m.name}`,
    };
    if (m.description) {
      item.documentation = { kind: 'markdown', value: m.description };
    }
    if (m.isGetter) {
      item.insertText = m.name;
    } else if (m.signature.params.length) {
      item.insertText = buildSnippet(m.name, m.signature.params);
      item.insertTextFormat = InsertTextFormat.Snippet;
    } else {
      item.insertText = `${m.name}()`;
      item.insertTextFormat = InsertTextFormat.Snippet;
    }
    return item;
  });
  if (modelScope) {
    for (const field of modelScope.symbols) {
      if (field.kind !== 'variable') continue;
      items.push({
        label: field.name,
        kind: CompletionItemKind.Field,
        detail: field.typeName ? `${field.name}: ${field.typeName}` : 'field',
        sortText: `0_${field.name}`,
      });
    }
  }
  return items;
}

function paramHint(p) {
  if (p.defaultValue) return `default ${p.defaultValue}`;
  if (p.rest) return 'variadic';
  if (p.optional) return 'optional';
  return 'required';
}

function findEnclosingCall(text, position) {
  const lines = text.split('\n');
  let depth = 0;
  let line = position.line;
  let col = position.character - 1;
  const used = [];
  let segment = '';
  while (line >= 0) {
    const lineText = lines[line] ?? '';
    if (line !== position.line) col = lineText.length - 1;
    while (col >= 0) {
      const ch = lineText[col];
      if (ch === ')' || ch === ']') depth++;
      else if (ch === '(' || ch === '[') {
        if (depth === 0) {
          if (ch !== '(') return null;
          collectUsedArg(segment, used);
          const callee = readIdentifierEndingAt(lineText, col - 1);
          if (!callee) return null;
          return { callee, usedArgs: used.reverse() };
        }
        depth--;
      } else if (ch === ',' && depth === 0) {
        collectUsedArg(segment, used);
        segment = '';
        col--;
        continue;
      } else if (ch === '"' || ch === "'") {
        const result = skipStringBackward(lineText, col, ch);
        col = result;
        continue;
      }
      segment = ch + segment;
      col--;
    }
    line--;
  }
  return null;
}

function collectUsedArg(segment, used) {
  const match = segment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (match) used.push(match[1]);
}

function skipStringBackward(line, startCol, quote) {
  let i = startCol - 1;
  while (i >= 0) {
    if (line[i] === quote && line[i - 1] !== '\\') return i - 1;
    i--;
  }
  return -1;
}

function readIdentifierEndingAt(line, endCol) {
  let i = endCol;
  while (i >= 0 && /\s/.test(line[i])) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(line[i])) i--;
  const start = i + 1;
  if (start === end) return null;
  return line.slice(start, end);
}
