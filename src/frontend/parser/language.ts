import { Parser } from "./index.js";
import { tokenize } from "../lexer/offside.js";
import type { ASTNode } from "../ast/index.js";

export function parse(source: string): ASTNode {
  const tokens = tokenize(source);
  const parser = new Parser(tokens, { source });
  return parser.parse();
}
