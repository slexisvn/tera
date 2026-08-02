import type { Hover, HoverParams } from "vscode-languageserver/node.js";
import { isStringLiteralTextPosition } from "../../../../src/frontend/index.ts";
import type { AnalyzedDocument } from "../analyzer/index.ts";
import { wordRangeAt } from "../analyzer/position.ts";
import { isMemberAccess, resolveReceiverType } from "../language/members.ts";
import type { MethodLookup } from "../language/type-resolver.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

export default defineProvider({
  id: "hover",
  register(connection, context) {
    connection.onHover((params) => {
      try {
        return computeHover(context, params);
      } catch (error) {
        connection.console.error(`hover error: ${message(error)}`);
        return null;
      }
    });
  },
});

export function computeHover(context: ProviderContext, params: HoverParams): Hover | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return null;
  if (isStringLiteralTextPosition(document.text, params.position)) return null;

  const word = wordRangeAt(document.lines, params.position);
  if (!word) return null;

  if (isMemberAccess(document, params.position)) {
    const receiverType = resolveReceiverType(context, document, params.position);
    const hover = receiverType
      ? memberHover(context, document, receiverType, word.text, params.position)
      : uniqueMethodHover(context, word.text);
    if (hover) return { ...hover, range: word.range };
    if (receiverType) return null;
  }

  const builtin = context.types.builtin(word.text);
  if (builtin) {
    const lines = builtin.signature
      ? ["```tera", builtin.signature.display, "```"]
      : [`\`${builtin.name}\``];
    lines.push("", `_${builtin.kind}_`);
    if (builtin.description) lines.push("", builtin.description);
    return markdown(lines, word.range);
  }

  const symbol = document.symbols.resolve(word.text, params.position);
  if (symbol) {
    const lines = [`\`${symbol.name}\` — *${symbol.kind}*`];
    if (symbol.typeName) lines.push("", `type: \`${symbol.typeName}\``);
    return markdown(lines, word.range);
  }

  if (context.languageData.keywords.includes(word.text)) {
    return markdown([`\`${word.text}\` — *keyword*`], word.range);
  }

  if (context.languageData.types.includes(word.text)) {
    return markdown([`\`${word.text}\` — *type*`], word.range);
  }

  return null;
}

function memberHover(
  context: ProviderContext,
  document: AnalyzedDocument,
  receiverType: string,
  name: string,
  position: HoverParams["position"],
): Hover | null {
  const element = arrayElement(receiverType);
  const field = document.symbols.resolveField(receiverType, name, position);
  if (field && genericBase(receiverType) !== receiverType) return fieldHover(context, receiverType, field);

  const lookup = context.types.lookupMethod(element ? "Array" : receiverType, name) ?? context.types.lookupMethod(receiverType, name);
  if (lookup) return methodHover(lookup);

  if (!field) return null;
  return fieldHover(context, receiverType, field);
}

function fieldHover(context: ProviderContext, receiverType: string, field: NonNullable<ReturnType<AnalyzedDocument["symbols"]["resolveField"]>>): Hover {
  const role = field.kind === "method" ? "method" : field.kind === "property" ? "property" : "field";
  const lines = [`\`${receiverType}.${field.name}\` — *${role} of ${receiverType}*`];
  if (field.typeName) lines.push("", `type: \`${field.typeName}\``);
  const builtin = field.typeName ? context.types.builtin(field.typeName) : null;
  if (builtin?.signature) lines.push("", "```tera", builtin.signature.display, "```");
  if (builtin?.description) lines.push("", builtin.description);
  return markdown(lines);
}

function genericBase(typeName: string): string {
  const open = typeName.indexOf("<");
  return open >= 0 ? typeName.slice(0, open).trim() : typeName;
}

function arrayElement(type: string): string | null {
  return type.endsWith("[]") ? type.slice(0, -2) : null;
}

function uniqueMethodHover(context: ProviderContext, name: string): Hover | null {
  const lookup = context.types.findUniqueMethod(name);
  return lookup ? methodHover(lookup) : null;
}

function methodHover(lookup: MethodLookup): Hover {
  const lines = [
    "```tera",
    `${lookup.ownerName}.${lookup.method.signature.display}`,
    "```",
    "",
    `_${lookup.method.isGetter ? "property" : "method"} of ${lookup.ownerName}_`,
  ];
  if (lookup.method.returns) lines.push("", `${lookup.method.isGetter ? "type" : "returns"}: \`${lookup.method.returns}\``);
  if (lookup.method.description) lines.push("", lookup.method.description);
  return markdown(lines);
}

function markdown(lines: string[], range?: Hover["range"]): Hover {
  return { contents: { kind: "markdown", value: lines.join("\n") }, range };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
