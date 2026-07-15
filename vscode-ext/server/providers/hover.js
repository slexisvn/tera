import { wordRangeAt } from '../analyzer/position.js';

export const id = 'hover';

export function register(connection, ctx) {
  connection.onHover(params => {
    try {
      return computeHover(ctx, params);
    } catch (err) {
      connection.console.error(`hover error: ${err.message}`);
      return null;
    }
  });
}

function computeHover(ctx, params) {
    const doc = ctx.analyzer.get(params.textDocument.uri);
    if (!doc) return null;
    const word = wordRangeAt(doc.text, params.position);
    if (!word) return null;

    const method = findMethodHover(doc, word, params.position, ctx.languageData);
    if (method) return method;

    const builtin = ctx.languageData.builtins.find(b => b.name === word.text);
    if (builtin) {
      const lines = [];
      if (builtin.signature) lines.push('```tera', builtin.signature.display, '```');
      else lines.push(`\`${builtin.name}\``);
      lines.push('', `_${builtin.kind}_`);
      if (builtin.description) lines.push('', builtin.description);
      return { contents: { kind: 'markdown', value: lines.join('\n') }, range: word.range };
    }

    const symbol = doc.symbols.resolve(word.text, params.position);
    if (symbol) {
      const lines = [`\`${symbol.name}\` — *${symbol.kind}*`];
      if (symbol.typeName) lines.push('', `type: \`${symbol.typeName}\``);
      return {
        contents: { kind: 'markdown', value: lines.join('\n') },
        range: word.range,
      };
    }

    if (ctx.languageData.keywords.includes(word.text)) {
      return {
        contents: { kind: 'markdown', value: `\`${word.text}\` — *keyword*` },
        range: word.range,
      };
    }
    return null;
}

function findMethodHover(doc, word, position, languageData) {
  const member = findMemberAt(doc, word, position);
  if (!member) return null;
  const receiverType = typeOf(member.object, doc, languageData);
  const lookup = lookupMethod(receiverType, word.text, languageData)
    ?? findUniqueMethod(word.text, languageData);
  if (lookup) {
    const lines = [
      '```tera',
      `${lookup.ownerName}.${lookup.method.signature.display}`,
      '```',
      '',
      `_${lookup.method.isGetter ? 'property' : 'method'} of ${lookup.ownerName}_`,
    ];
    if (lookup.method.description) lines.push('', lookup.method.description);
    return { contents: { kind: 'markdown', value: lines.join('\n') }, range: word.range };
  }
  return fieldHover(doc, word, receiverType, languageData);
}

function fieldHover(doc, word, receiverType, languageData) {
  const field = doc.symbols.resolveField?.(receiverType, word.text);
  if (!field) return null;
  const lines = [`\`${receiverType}.${field.name}\` — *field of ${receiverType}*`];
  if (field.typeName) lines.push('', `type: \`${field.typeName}\``);
  const builtin = field.typeName && languageData.builtins.find(b => b.name === field.typeName);
  if (builtin) {
    if (builtin.signature) lines.push('', '```tera', builtin.signature.display, '```');
    if (builtin.description) lines.push('', builtin.description);
  }
  return { contents: { kind: 'markdown', value: lines.join('\n') }, range: word.range };
}

function findMemberAt(doc, word, position) {
  const tokens = doc.tokens ?? [];
  const index = tokens.findIndex(tok =>
    tok.type === 'identifier' &&
    tok.line - 1 === position.line &&
    position.character >= tok.column - 1 &&
    position.character < tok.column - 1 + tok.value.length);
  if (index <= 0) return null;
  const dot = tokens[index - 1];
  if (dot.value !== '.') return null;
  return findMember(doc.ast, member =>
    member.property === word.text && member.line === dot.line && member.column === dot.column);
}

function findMember(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Member' && predicate(node)) return node;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findMember(item, predicate);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findMember(value, predicate);
      if (found) return found;
    }
  }
  return null;
}

function typeOf(node, doc, languageData) {
  if (!node) return null;
  switch (node.type) {
    case 'Identifier': {
      const symbol = doc.symbols.resolve(node.name, { line: node.line - 1, character: node.column - 1 });
      return symbol?.typeName ?? node.name;
    }
    case 'Call': {
      const callee = node.callee;
      if (callee?.type === 'Identifier') {
        const builtin = languageData.builtins.find(b => b.name === callee.name);
        if (!builtin) return null;
        if (builtin.returns) return builtin.returns;
        return builtin.methods?.length ? builtin.name : null;
      }
      if (callee?.type === 'Member') {
        const lookup = lookupMethod(typeOf(callee.object, doc, languageData), callee.property, languageData);
        return lookup?.method.returns ?? null;
      }
      return null;
    }
    case 'Member': {
      const lookup = lookupMethod(typeOf(node.object, doc, languageData), node.property, languageData);
      return lookup?.method.returns ?? null;
    }
    case 'Binary': {
      if (node.op === '@') return 'Tensor';
      const left = typeOf(node.left, doc, languageData);
      const right = typeOf(node.right, doc, languageData);
      if (left === 'Tensor' || right === 'Tensor') return 'Tensor';
      return null;
    }
    case 'Unary':
      return typeOf(node.value, doc, languageData);
    default:
      return null;
  }
}

function findUniqueMethod(name, languageData) {
  const owners = [];
  for (const [typeName, methods] of Object.entries(languageData.pseudoTypes ?? {})) {
    const method = methods.find(m => m.name === name);
    if (method) owners.push({ ownerName: typeName, method });
  }
  return owners.length === 1 ? owners[0] : null;
}

function lookupMethod(typeName, methodName, languageData, seen = new Set()) {
  if (!typeName || seen.has(typeName)) return null;
  seen.add(typeName);
  const builtin = languageData.builtins.find(b => b.name === typeName);
  const own = builtin?.methods?.find(m => m.name === methodName);
  if (own) return { ownerName: typeName, method: own };
  // A constructor builtin (e.g. DataFrame) and the value type's pseudoType can
  // share a name; the methods live on the pseudoType.
  const found = languageData.pseudoTypes?.[typeName]?.find(m => m.name === methodName);
  if (found) return { ownerName: typeName, method: found };
  if (builtin?.returns && builtin.returns !== typeName) {
    return lookupMethod(builtin.returns, methodName, languageData, seen);
  }
  return null;
}
