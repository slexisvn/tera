import type { Hover, HoverParams } from "vscode-languageserver/node.js";
import type { AnalyzedDocument, Position } from "../analyzer/index.ts";
import { wordRangeAt } from "../analyzer/position.ts";
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

function computeHover(context: ProviderContext, params: HoverParams): Hover | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return null;

  const word = wordRangeAt(document.lines, params.position);
  if (!word) return null;

  if (isMemberAccess(document, params.position)) {
    const receiver = readReceiver(document, params.position);
    const hover = receiver
      ? memberHover(context, document, receiver, word.text, params.position)
      : uniqueMethodHover(context, word.text);
    if (hover) return { ...hover, range: word.range };
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
  receiver: string,
  name: string,
  position: Position,
): Hover | null {
  const receiverType = document.symbols.resolve(receiver, position)?.typeName ?? receiver;

  const lookup = context.types.lookupMethod(receiverType, name) ?? context.types.findUniqueMethod(name);
  if (lookup) return methodHover(lookup);

  const field = document.symbols.resolveField(receiverType, name);
  if (!field) return null;

  const lines = [`\`${receiverType}.${field.name}\` — *field of ${receiverType}*`];
  if (field.typeName) lines.push("", `type: \`${field.typeName}\``);
  const builtin = field.typeName ? context.types.builtin(field.typeName) : null;
  if (builtin?.signature) lines.push("", "```tera", builtin.signature.display, "```");
  if (builtin?.description) lines.push("", builtin.description);
  return markdown(lines);
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
  if (lookup.method.description) lines.push("", lookup.method.description);
  return markdown(lines);
}

function isMemberAccess(document: AnalyzedDocument, position: Position): boolean {
  const line = document.lines[position.line] ?? "";
  return /\.\s*[A-Za-z0-9_$]*$/.test(line.slice(0, position.character));
}

function readReceiver(document: AnalyzedDocument, position: Position): string | null {
  const line = document.lines[position.line] ?? "";
  const before = line.slice(0, position.character);
  return before.match(/([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z0-9_$]*$/)?.[1] ?? null;
}

function markdown(lines: string[], range?: Hover["range"]): Hover {
  return { contents: { kind: "markdown", value: lines.join("\n") }, range };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
