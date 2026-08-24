import { astChildren, NodeType, type ASTNode } from "../../frontend/ast/index.js";
import { typeLiteralShape } from "../../frontend/checker/type-system.js";
import {
  jsonElementTypeOf,
  jsonParserName,
  jsonScalarTypes,
  JSON_NAMESPACE,
  JSON_PARSE_MEMBER,
  type JsonFieldSurface,
  type JsonShapeSurface,
} from "./json.js";

const DECLARATIONS: ReadonlySet<string> = new Set([
  NodeType.LetDeclaration,
  NodeType.ConstDeclaration,
  NodeType.VarDeclaration,
]);

const SCALARS = jsonScalarTypes();

type ParameterInfo = { name?: string; type?: string };

type Site = {
  readonly node: ASTNode;
  readonly declared: string;
};

function parameterInfoOf(node: ASTNode): readonly ParameterInfo[] {
  const declared = node._paramInfo;
  return Array.isArray(declared) ? (declared as ParameterInfo[]) : [];
}

function functionsByName(node: ASTNode, found: Map<string, ASTNode>): Map<string, ASTNode> {
  if (node === null || node === undefined) return found;
  if (node.type === NodeType.FunctionDeclaration && typeof node.name === "string") {
    found.set(node.name, node);
  }
  for (const child of astChildren(node)) functionsByName(child, found);
  return found;
}

function aliasesIn(node: ASTNode, found: Map<string, string>): Map<string, string> {
  if (node === null || node === undefined) return found;
  if (node.type === NodeType.TypeAliasDeclaration && typeof node.name === "string") {
    if (typeof node.declaredType === "string") found.set(node.name, node.declaredType);
  }
  for (const child of astChildren(node)) aliasesIn(child, found);
  return found;
}

export function isJsonParse(node: ASTNode): boolean {
  if (node === null || node === undefined) return false;
  if (node.type !== NodeType.CallExpression) return false;
  const callee = node.callee as ASTNode | undefined;
  if (callee === undefined || callee.type !== NodeType.MemberExpression || callee.computed) {
    return false;
  }
  const owner = callee.object as ASTNode | undefined;
  if (owner === undefined || owner.type !== NodeType.Identifier) return false;
  return owner.name === JSON_NAMESPACE && callee.property === JSON_PARSE_MEMBER;
}

function argumentTypes(
  node: ASTNode,
  functions: ReadonlyMap<string, ASTNode>,
): readonly (string | null)[] {
  const callee = node.callee as ASTNode | undefined;
  if (callee === undefined || callee.type !== NodeType.Identifier) return [];
  const target = functions.get(String(callee.name));
  if (target === undefined) return [];
  return parameterInfoOf(target).map((param) => param.type ?? null);
}

function visit(
  node: ASTNode,
  expected: string | null,
  functions: ReadonlyMap<string, ASTNode>,
  returns: string | null,
  found: Site[],
): void {
  if (node === null || node === undefined) return;
  if (isJsonParse(node)) {
    if (expected !== null) found.push({ node, declared: expected });
    for (const argument of (node.args as ASTNode[]) ?? []) {
      visit(argument, null, functions, returns, found);
    }
    return;
  }
  if (node.type === NodeType.FunctionDeclaration) {
    const answered = typeof node._returnType === "string" ? node._returnType : null;
    for (const child of astChildren(node)) visit(child, null, functions, answered, found);
    return;
  }
  if (DECLARATIONS.has(node.type)) {
    const declared = typeof node.declaredType === "string" ? node.declaredType : null;
    const init = node.init as ASTNode | undefined;
    if (init !== undefined) visit(init, declared, functions, returns, found);
    return;
  }
  if (node.type === NodeType.ReturnStatement) {
    const answered = node.argument as ASTNode | undefined;
    if (answered !== undefined) visit(answered, returns, functions, returns, found);
    return;
  }
  if (node.type === NodeType.CallExpression) {
    const declared = argumentTypes(node, functions);
    const args = (node.args as ASTNode[]) ?? [];
    args.forEach((argument, at) => {
      visit(argument, declared[at] ?? null, functions, returns, found);
    });
    const callee = node.callee as ASTNode | undefined;
    if (callee !== undefined) visit(callee, null, functions, returns, found);
    return;
  }
  for (const child of astChildren(node)) visit(child, null, functions, returns, found);
}

function sitesIn(roots: readonly ASTNode[]): { sites: Site[]; aliases: Map<string, string> } {
  const functions = new Map<string, ASTNode>();
  const aliases = new Map<string, string>();
  for (const root of roots) {
    functionsByName(root, functions);
    aliasesIn(root, aliases);
  }
  const sites: Site[] = [];
  for (const root of roots) visit(root, null, functions, null, sites);
  return { sites, aliases };
}

function fieldsOf(
  name: string,
  aliases: ReadonlyMap<string, string>,
): readonly JsonFieldSurface[] | null {
  const spelled = aliases.get(name);
  if (spelled === undefined) return null;
  const shape = typeLiteralShape(spelled);
  if (shape === null || shape.fields.size === 0) return null;
  if ((shape.indexers ?? []).length > 0) return null;
  const fields: JsonFieldSurface[] = [];
  for (const [field, binding] of shape.fields) {
    if (binding.optional) return null;
    fields.push({ name: field, type: binding.type });
  }
  return fields;
}

function admit(
  name: string,
  aliases: ReadonlyMap<string, string>,
  admitted: Map<string, JsonShapeSurface>,
  spelling: ReadonlySet<string> = new Set(),
): boolean {
  if (admitted.has(name)) return true;
  if (spelling.has(name)) return false;
  const fields = fieldsOf(name, aliases);
  if (fields === null) return false;
  const inner = new Set([...spelling, name]);
  for (const field of fields) {
    const held = jsonElementTypeOf(field.type) ?? field.type;
    if (SCALARS.has(held)) continue;
    if (!admit(held, aliases, admitted, inner)) return false;
  }
  admitted.set(name, { name, fields });
  return true;
}

export function jsonShapesAcross(
  roots: readonly ASTNode[],
  nameable: ReadonlySet<string> | null = null,
): readonly JsonShapeSurface[] {
  const { sites, aliases } = sitesIn(roots);
  const admitted = new Map<string, JsonShapeSurface>();
  for (const site of sites) {
    if (nameable !== null && !nameable.has(site.declared)) continue;
    admit(site.declared, aliases, admitted);
  }
  return [...admitted.values()];
}

export function rewriteJsonParses(
  roots: readonly ASTNode[],
  known: ReadonlySet<string>,
): number {
  const { sites } = sitesIn(roots);
  let rewritten = 0;
  for (const site of sites) {
    if (!known.has(site.declared)) continue;
    site.node.callee = { type: NodeType.Identifier, name: jsonParserName(site.declared) };
    rewritten++;
  }
  return rewritten;
}
