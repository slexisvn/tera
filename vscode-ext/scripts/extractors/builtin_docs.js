import { readFileSync, existsSync } from 'node:fs';

const BUILTIN_HEADING = /^##\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?(?:\s*\{([A-Za-z_][A-Za-z0-9_]*)\})?\s*$/;
const METHOD_HEADING = /^###\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?(?:\s*->\s*(.+?))?\s*$/;
const KIND_TEMPLATE_HEADING = /^##\s+@kind\/([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const PSEUDO_TYPE_HEADING = /^##\s+\$([A-Za-z_][A-Za-z0-9_]*)\s*$/;

export function extractBuiltinDocs(docPath) {
  if (!existsSync(docPath)) {
    return { builtins: new Map(), kindTemplates: new Map(), pseudoTypes: new Map() };
  }
  const text = readFileSync(docPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const builtins = new Map();
  const kindTemplates = new Map();
  const pseudoTypes = new Map();

  let current = null;
  let currentMethod = null;
  let buffer = [];

  const flushMethod = () => {
    if (!current || !currentMethod) return;
    const description = buffer.join('\n').trim() || null;
    current.methods.push({ ...currentMethod, description });
    buffer = [];
    currentMethod = null;
  };

  const flushSection = () => {
    flushMethod();
    if (!current) return;
    const description = buffer.join('\n').trim() || null;
    if (current.kind === 'builtin') {
      builtins.set(current.name, {
        name: current.name,
        kind: current.builtinKind ?? null,
        params: current.params,
        description: current.headerDesc ?? description,
        methods: current.methods,
      });
    } else if (current.kind === 'kindTemplate') {
      kindTemplates.set(current.name, { methods: current.methods });
    } else if (current.kind === 'pseudoType') {
      pseudoTypes.set(current.name, { methods: current.methods });
    }
    buffer = [];
    current = null;
  };

  for (const line of lines) {
    const kindMatch = line.match(KIND_TEMPLATE_HEADING);
    if (kindMatch) {
      flushSection();
      current = { kind: 'kindTemplate', name: kindMatch[1], methods: [], headerDesc: null };
      continue;
    }
    const pseudoMatch = line.match(PSEUDO_TYPE_HEADING);
    if (pseudoMatch) {
      flushSection();
      current = { kind: 'pseudoType', name: pseudoMatch[1], methods: [], headerDesc: null };
      continue;
    }
    const builtinMatch = line.match(BUILTIN_HEADING);
    if (builtinMatch) {
      flushSection();
      current = {
        kind: 'builtin',
        name: builtinMatch[1],
        builtinKind: builtinMatch[3] ?? null,
        params: builtinMatch[2] === undefined ? null : parseParams(builtinMatch[2]),
        methods: [],
        headerDesc: null,
      };
      continue;
    }
    const methodMatch = line.match(METHOD_HEADING);
    if (methodMatch && current) {
      if (!currentMethod) {
        current.headerDesc = buffer.join('\n').trim() || null;
        buffer = [];
      } else {
        flushMethod();
      }
      currentMethod = {
        name: methodMatch[1],
        params: methodMatch[2] === undefined ? [] : parseParams(methodMatch[2]),
        returns: methodMatch[3] ?? null,
        isGetter: methodMatch[2] === undefined,
      };
      continue;
    }
    if (current) buffer.push(line);
  }
  flushSection();
  return { builtins, kindTemplates, pseudoTypes };
}

function parseParams(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return splitTopLevel(trimmed).map(s => s.trim()).filter(Boolean).map(parseParam);
}

function parseParam(text) {
  if (text.startsWith('...')) {
    const { name, type } = splitType(text.slice(3));
    return { name, type, optional: true, rest: true, defaultValue: null };
  }
  const eqIdx = findTopLevelEquals(text);
  if (eqIdx < 0) {
    let { name, type } = splitType(text);
    const optional = name.endsWith('?');
    if (optional) name = name.slice(0, -1).trim();
    return { name, type, optional, rest: false, defaultValue: null };
  }
  const { name, type } = splitType(text.slice(0, eqIdx));
  return { name, type, optional: true, rest: false, defaultValue: text.slice(eqIdx + 1).trim() };
}

function splitType(text) {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(':');
  if (colon < 0) return { name: trimmed, type: null };
  return { name: trimmed.slice(0, colon).trim(), type: trimmed.slice(colon + 1).trim() };
}

function findTopLevelEquals(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    else if (ch === '=' && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}
