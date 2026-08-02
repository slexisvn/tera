import { Parser, type ParserOptions } from "./index.js";
import { tokenize } from "../lexer/offside.js";
import type { ASTNode } from "../ast/index.js";
import { applySyntaxTransforms } from "./extensions.js";

export function parse(source: string, options: ParserOptions = {}): ASTNode {
  const tokens = tokenize(source);
  const parser = new Parser(tokens, { ...options, source });
  return applySyntaxTransforms(parser.parse(), parser.syntaxPlugins);
}

export type { ParserOptions } from "./index.js";
