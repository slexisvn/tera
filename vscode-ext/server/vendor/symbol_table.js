const DECL_VISITORS = {
  ModelDeclaration: (node, scope, ctx) => {
    const namePos = addNamedDecl(scope, node, 'model', 'model', ctx);
    const child = ctx.openScope(node.name, scope, node);
    addParamSymbols(child, ctx, node.params, namePos, node);
    ctx.visitAll(node.body, child);
  },
  FunctionDeclaration: (node, scope, ctx) => {
    const namePos = addNamedDecl(scope, node, 'function', 'fn', ctx, renderType(node.returnType));
    const child = ctx.openScope(node.name, scope, node);
    addParamSymbols(child, ctx, node.params, namePos, node);
    ctx.visitAll(node.body, child);
  },
  ForwardDeclaration: (node, scope, ctx) => visitForwardLike(node, scope, ctx, 'forward'),
  TrainDeclaration: (node, scope, ctx) => visitForwardLike(node, scope, ctx, 'train'),
  ValidateDeclaration: (node, scope, ctx) => visitForwardLike(node, scope, ctx, 'validate'),
  OptimizerDeclaration: (node, scope, ctx) => {
    const child = ctx.openScope('optimizer', scope, node);
    ctx.visitAll(node.body, child);
  },
  Assign: (node, scope, ctx) => {
    const typeName = renderType(node.annotation) ?? bestInferred(ctx, node);
    addSymbol(scope, node.name, 'variable', node, typeName);
  },
  DestructureAssign: (node, scope, ctx) => {
    const positions = findIdentifierPositions(ctx.sourceLines, node, node.names);
    for (let i = 0; i < node.names.length; i++) {
      const pos = positions[i] ?? { line: node.line, column: node.column };
      const typeName = lookupInferred(ctx, node.names[i], node.line);
      scope.symbols.push({ name: node.names[i], kind: 'variable', line: pos.line, column: pos.column, typeName });
    }
    updateScopeRange(scope, node);
  },
  CompoundAssign: (node, scope, ctx) => addSymbol(scope, node.name, 'variable', node, lookupInferred(ctx, node.name, node.line)),
  If: (node, scope, ctx) => {
    ctx.visitAll(node.body, scope);
    for (const e of node.elifs) ctx.visitAll(e.body, scope);
    if (node.elseBody) ctx.visitAll(node.elseBody, scope);
  },
  For: (node, scope, ctx) => {
    const pos = findIdentifierAfterKeyword(ctx.sourceLines, node, 'for', node.variable);
    const typeName = lookupInferred(ctx, node.variable, node.line);
    scope.symbols.push({ name: node.variable, kind: 'variable', line: pos.line, column: pos.column, typeName });
    updateScopeRange(scope, node);
    ctx.visitAll(node.body, scope);
  },
  While: (node, scope, ctx) => ctx.visitAll(node.body, scope),
};

function visitForwardLike(node, scope, ctx, kind) {
  const child = ctx.openScope(kind, scope, node);
  const startPos = findIdentifierAfterKeyword(ctx.sourceLines, node, kind, kind);
  const anchor = { line: startPos.line, column: startPos.column + kind.length - 1 };
  addParamSymbols(child, ctx, node.params, anchor, node);
  ctx.visitAll(node.body, child);
}

function addParamSymbols(scope, ctx, paramNames, afterPos, node) {
  if (!paramNames.length) return;
  const positions = findIdentifierPositions(ctx.sourceLines, { line: afterPos.line, column: afterPos.column + 1 }, paramNames);
  for (let i = 0; i < paramNames.length; i++) {
    const pos = positions[i] ?? { line: node.line, column: node.column };
    const typeName = renderType(node.paramTypes?.[i]);
    scope.symbols.push({ name: paramNames[i], kind: 'parameter', line: pos.line, column: pos.column, typeName });
  }
  updateScopeRange(scope, node);
}

function renderType(node) {
  if (!node) return null;
  if (node.kind === 'ArrayType') return `${renderType(node.element)}[]`;
  if (node.kind === 'UnionType') return node.members.map(renderType).join(' | ');
  if (node.kind === 'GenericType') return `${node.name}<${node.args.map(renderType).join(', ')}>`;
  return node.name ?? null;
}

export function buildSymbolTable(program, sourceText = '', inferredTypes = null) {
  const sourceLines = sourceText.split('\n');
  const root = makeScope('<module>', null, { line: 1, column: 1 });
  const scopes = [root];

  const ctx = {
    sourceLines,
    inferredTypes,
    openScope(name, parent, node) {
      const s = makeScope(name, parent, node);
      scopes.push(s);
      parent.children.push(s);
      return s;
    },
    visit(node, scope) {
      if (!node) return;
      updateScopeRange(scope, node);
      const visitor = DECL_VISITORS[node.type];
      if (visitor) visitor(node, scope, ctx);
    },
    visitAll(nodes, scope) {
      if (!nodes) return;
      for (const n of nodes) ctx.visit(n, scope);
    },
  };

  ctx.visitAll(program.body, root);
  root.endLine = Math.max(root.endLine, lastLine(program) ?? root.endLine);
  propagateEndLines(root);

  return {
    scopes,
    root,
    flat: scopes.flatMap(s => s.symbols),
    findScopeAt: position => findScopeAt(root, position),
    resolve: (name, position) => resolveSymbol(root, name, position),
    resolveField: (typeName, fieldName) => resolveField(scopes, typeName, fieldName),
  };
}

function makeScope(name, parent, anchor) {
  const startLine = anchor.line ?? 1;
  return {
    name,
    parent,
    children: [],
    symbols: [],
    startLine,
    endLine: startLine,
  };
}

function addSymbol(scope, name, kind, node, typeName = null) {
  const line = node.line ?? scope.startLine;
  const column = node.column ?? 1;
  scope.symbols.push({ name, kind, line, column, typeName });
  updateScopeRange(scope, node);
}

function lookupInferred(ctx, name, line) {
  if (!ctx.inferredTypes || line == null) return null;
  return ctx.inferredTypes.get(`${name}:${line}`) ?? null;
}

function bestInferred(ctx, node) {
  const inferred = lookupInferred(ctx, node.name, node.line);
  if (inferred && inferred !== 'Module') return inferred;
  return inferType(node.value) ?? inferred;
}

function inferType(value) {
  if (!value || value.type !== 'Call') return null;
  const callee = value.callee;
  if (callee?.type === 'Identifier') return callee.name;
  return null;
}

function addNamedDecl(scope, node, kind, keyword, ctx, typeName = null) {
  const position = findIdentifierAfterKeyword(ctx.sourceLines, node, keyword, node.name);
  scope.symbols.push({
    name: node.name,
    kind,
    line: position.line,
    column: position.column,
    typeName,
  });
  updateScopeRange(scope, node);
  return position;
}

function findIdentifierAfterKeyword(sourceLines, node, keyword, name) {
  const fallback = { line: node.line ?? 1, column: node.column ?? 1 };
  const lineIndex = (node.line ?? 1) - 1;
  const line = sourceLines[lineIndex];
  if (!line) return fallback;
  const keywordStart = (node.column ?? 1) - 1;
  const afterKeyword = line.indexOf(keyword, keywordStart);
  if (afterKeyword < 0) return fallback;
  const searchFrom = afterKeyword + keyword.length;
  const nameIndex = findWord(line, name, searchFrom);
  if (nameIndex < 0) return fallback;
  return { line: node.line, column: nameIndex + 1 };
}

function findIdentifierPositions(sourceLines, start, names) {
  const positions = [];
  let line = (start.line ?? 1) - 1;
  let column = (start.column ?? 1) - 1;
  for (const name of names) {
    let found = null;
    while (line < sourceLines.length) {
      const idx = findWord(sourceLines[line] ?? '', name, column);
      if (idx >= 0) {
        found = { line: line + 1, column: idx + 1 };
        column = idx + name.length;
        break;
      }
      line++;
      column = 0;
    }
    positions.push(found);
  }
  return positions;
}

function findWord(line, name, fromIndex) {
  let i = fromIndex;
  while (i <= line.length - name.length) {
    const idx = line.indexOf(name, i);
    if (idx < 0) return -1;
    const before = idx === 0 ? '' : line[idx - 1];
    const after = idx + name.length >= line.length ? '' : line[idx + name.length];
    if (!isIdentChar(before) && !isIdentChar(after)) return idx;
    i = idx + 1;
  }
  return -1;
}

function isIdentChar(ch) {
  return ch && /[A-Za-z0-9_]/.test(ch);
}

function updateScopeRange(scope, node) {
  const line = node.line ?? scope.startLine;
  if (line > scope.endLine) scope.endLine = line;
}

function propagateEndLines(scope) {
  for (const child of scope.children) {
    propagateEndLines(child);
    if (child.endLine > scope.endLine) scope.endLine = child.endLine;
  }
}

function lastLine(program) {
  let max = 0;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.line === 'number' && node.line > max) max = node.line;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(program);
  return max;
}

function findScopeAt(scope, position) {
  const line = position.line + 1;
  for (const child of scope.children) {
    if (line >= child.startLine && line <= child.endLine) {
      return findScopeAt(child, position);
    }
  }
  return scope;
}

function resolveField(scopes, typeName, fieldName) {
  if (!typeName) return null;
  const scope = scopes.find(s => s.name === typeName);
  if (!scope) return null;
  return scope.symbols.find(s => s.name === fieldName) ?? null;
}

function resolveSymbol(rootScope, name, position) {
  const line = (position.line ?? 0) + 1;
  const col = (position.character ?? 0) + 1;
  const precedes = s => s.line < line || (s.line === line && s.column <= col);
  const later = (a, b) => (b.line > a.line || (b.line === a.line && b.column > a.column)) ? b : a;
  let cursor = findScopeAt(rootScope, position);
  while (cursor) {
    const matches = cursor.symbols.filter(s => s.name === name);
    if (matches.length) {
      const before = matches.filter(precedes);
      return before.length ? before.reduce(later) : matches[0];
    }
    cursor = cursor.parent;
  }
  return null;
}
