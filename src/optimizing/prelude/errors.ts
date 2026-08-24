import { astChildren, NodeType, type ASTNode } from "../../frontend/ast/index.js";

export const ERROR_GLOBAL = "Error";
export const ERROR_MESSAGE_FIELD = "message";
export const ERROR_DISPLAY_PREFIX = `${ERROR_GLOBAL}: `;

const MESSAGE_TYPE = "string";

type Spelling = (node: ASTNode) => boolean;

const namesError: Spelling = (node) =>
  node.type === NodeType.Identifier && node.name === ERROR_GLOBAL;

const declaresError: Spelling = (node) =>
  node.type === NodeType.ClassDeclaration && node.name === ERROR_GLOBAL;

function holds(node: ASTNode, spelled: Spelling): boolean {
  if (node === null || node === undefined) return false;
  return spelled(node) || astChildren(node).some((child) => holds(child, spelled));
}

export function errorPrelude(roots: readonly ASTNode[]): string {
  const anyRoot = (spelled: Spelling): boolean => roots.some((root) => holds(root, spelled));
  if (!anyRoot(namesError) || anyRoot(declaresError)) return "";
  return `${[
    `class ${ERROR_GLOBAL}:`,
    `  public ${ERROR_MESSAGE_FIELD}: ${MESSAGE_TYPE}`,
    `  public constructor(${ERROR_MESSAGE_FIELD}: ${MESSAGE_TYPE}):`,
    `    this.${ERROR_MESSAGE_FIELD} = ${ERROR_MESSAGE_FIELD}`,
  ].join("\n")}\n`;
}
