import type { AnalyzedDocument, Position } from "../analyzer/index.ts";
import type { ProviderContext } from "../providers/types.ts";

export function isMemberAccess(document: AnalyzedDocument, position: Position): boolean {
  const line = document.lines[position.line] ?? "";
  return /\.\s*[A-Za-z0-9_$]*$/.test(line.slice(0, position.character));
}

export function resolveReceiverType(context: ProviderContext, document: AnalyzedDocument, position: Position): string | null {
  const before = (document.lines[position.line] ?? "").slice(0, position.character);
  const trailing = before.match(/\.\s*[A-Za-z0-9_$]*$/);
  if (!trailing) return null;
  const receiver = extractReceiver(before.slice(0, before.length - trailing[0].length));
  return receiver ? resolveExprType(context, document, receiver, position) : null;
}

function extractReceiver(text: string): string {
  let depth = 0;
  let start = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth === 0) { start = i + 1; break; }
      depth--;
    } else if (depth === 0 && /[\s=,;{}+\-*/%<>!&|?:]/.test(ch)) { start = i + 1; break; }
  }
  return text.slice(start).trim();
}

function resolveExprType(context: ProviderContext, document: AnalyzedDocument, expr: string, position: Position): string | null {
  const base = expr.match(/^([A-Za-z_$][\w$]*)/);
  if (!base) return null;
  let type: string | null =
    document.symbols.resolve(base[1], position)?.typeName ??
    context.languageData.globalNamespaces[base[1]] ??
    base[1];
  let rest = expr.slice(base[1].length);
  while (rest.length) {
    const step = rest.match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (!step || !type) break;
    rest = rest.slice(step[0].length);
    const called = /^\s*\(/.test(rest);
    if (called) rest = skipBalancedParens(rest);
    const element = arrayElement(type);
    const method = context.types.lookupMethod(element ? "Array" : type, step[1]);
    const field = document.symbols.resolveField(type, step[1]);
    const memberType = method?.method.returns ?? field?.typeName ?? null;
    if (!memberType) return null;
    type = called ? returnTypeAfterArrow(memberType) : memberType;
  }
  return type;
}

function returnTypeAfterArrow(type: string): string {
  const parts = type.split("->");
  return parts.length > 1 ? parts[parts.length - 1].trim() : type;
}

function arrayElement(type: string): string | null {
  return type.endsWith("[]") ? type.slice(0, -2) : null;
}

function skipBalancedParens(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") { depth--; if (depth === 0) return text.slice(i + 1); }
  }
  return "";
}
