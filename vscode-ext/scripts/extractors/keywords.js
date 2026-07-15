import { readFileSync } from 'node:fs';

const CONTROL_FLOW_PATTERN = /\b(?:atIdentifier|expectIdentifier|matchIdentifier)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g;
const LITERAL_BUILTIN_NAMES = ['true', 'false', 'null', 'and', 'or', 'not'];

export function extractKeywords(parserSourcePath) {
  const text = readFileSync(parserSourcePath, 'utf8');
  const found = new Set();
  for (const match of text.matchAll(CONTROL_FLOW_PATTERN)) {
    found.add(match[1]);
  }
  for (const name of LITERAL_BUILTIN_NAMES) found.add(name);
  return [...found].sort();
}

export function classifyKeywords(keywords) {
  const declarationKeywords = new Set(['model', 'fn', 'forward', 'train', 'validate', 'optimizer']);
  const controlKeywords = new Set(['if', 'else', 'for', 'while', 'in', 'break', 'continue', 'return']);
  const operatorKeywords = new Set(['and', 'or', 'not']);
  const constantKeywords = new Set(['true', 'false', 'null']);
  const groups = {
    declaration: [],
    control: [],
    operator: [],
    constant: [],
    other: [],
  };
  for (const k of keywords) {
    if (declarationKeywords.has(k)) groups.declaration.push(k);
    else if (controlKeywords.has(k)) groups.control.push(k);
    else if (operatorKeywords.has(k)) groups.operator.push(k);
    else if (constantKeywords.has(k)) groups.constant.push(k);
    else groups.other.push(k);
  }
  return groups;
}
