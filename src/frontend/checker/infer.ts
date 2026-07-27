import { NodeType, type ASTNode, type ObjectPropertyNode } from "../ast/index.js";
import { lookup, lookupSignature, type BoundProgram, type Scope } from "./binder.js";
import { binaryOperatorSemantics, isTensorType } from "./operator-types.js";
import {
  arrayElementType,
  builtinMethod,
  callSignatureForType,
  cleanType,
  compatible,
  indexedAccessType,
  instantiateShapeForType,
  instantiateSignature,
  isTupleType,
  iterableBindingType,
  leastUpperBound,
  parseFunctionType,
  removeNullish,
  resolveType,
  shapeType,
  signature,
  signatureType,
  splitTopLevel,
  substituteType,
  tupleTypes,
  unionParts,
  unionType,
  type Binding,
  type ObjectShape,
  type Signature,
  type TypeEnv,
  type TypeName,
} from "./type-system.js";

export type ObjectLiteralField = Binding & {
  value: ASTNode;
};

export function inferExpression(
  node: ASTNode | undefined,
  bound: BoundProgram,
  scope: Scope,
  expected?: Signature | null,
  expectedType?: TypeName | null,
): TypeName {
  if (!node) return "undefined";
  switch (node.type) {
    case NodeType.Literal:
      return literalType(node);
    case NodeType.Identifier: {
      const name = String(node.name);
      const sig = lookupSignature(scope, name);
      return lookup(scope, name)?.type ?? (sig ? signatureType(sig) : "unknown");
    }
    case NodeType.ArrayExpression:
      return inferArray(node, bound, scope, expectedType);
    case NodeType.ObjectExpression:
      return shapeType(objectLiteralShape(node, bound, scope));
    case NodeType.BinaryExpression:
    case NodeType.NullishCoalescingExpression:
      return inferBinary(node, bound, scope);
    case NodeType.LogicalExpression:
      return "bool";
    case NodeType.UnaryExpression:
      return inferUnary(node, bound, scope);
    case NodeType.AssignmentExpression:
      return inferExpression(node.value as ASTNode, bound, scope);
    case NodeType.CompoundAssignmentExpression:
      return inferCompound(node, bound, scope);
    case NodeType.UpdateExpression:
      return inferExpression(node.argument as ASTNode, bound, scope);
    case NodeType.MemberExpression:
    case NodeType.OptionalMemberExpression:
      return inferMember(node, bound, scope);
    case NodeType.IndexExpression:
      return inferIndexExpression(node, bound, scope);
    case NodeType.CallExpression:
    case NodeType.OptionalCallExpression:
      return inferCall(node, bound, scope);
    case NodeType.NewExpression:
      return inferNew(node, bound, scope);
    case NodeType.ArrowFunctionExpression:
      return inferArrow(node, bound, scope, expected ?? null);
    case NodeType.FunctionExpression:
      return expected ? signatureType(expected) : "Function";
    case NodeType.TemplateLiteral:
      return "string";
    case NodeType.SequenceExpression:
      return inferSequence(node, bound, scope, expected, expectedType);
    case NodeType.AwaitExpression:
      return inferExpression(node.argument as ASTNode, bound, scope, expected, expectedType);
    case NodeType.YieldExpression:
      return inferExpression(node.argument as ASTNode | undefined, bound, scope, expected, expectedType);
    case NodeType.ConditionalExpression: {
      const a = inferExpression(node.consequent as ASTNode, bound, scope, null, expectedType);
      const b = inferExpression(node.alternate as ASTNode, bound, scope, null, expectedType);
      return a === b ? a : unionType([a, b]);
    }
    default:
      return "unknown";
  }
}

function literalType(node: ASTNode): TypeName {
  if (node.kind === "number") {
    const raw = typeof node.__raw === "string" ? node.__raw : "";
    if (/[.eE]/.test(raw)) return "float";
    return Number.isInteger(node.value) ? "int" : "float";
  }
  if (node.kind === "string") return "string";
  if (node.kind === "boolean") return "bool";
  if (node.kind === "null") return "null";
  return node.value === undefined ? "undefined" : "any";
}

function inferArray(node: ASTNode, bound: BoundProgram, scope: Scope, expectedType?: TypeName | null): TypeName {
  const elements = (node.elements as Array<ASTNode | null>).filter((item): item is ASTNode => !!item);
  const elementTypes = elements.flatMap((item) => arrayElementTypes(item, bound, scope));
  const expected = expectedType ? resolveType(expectedType, bound.env) : null;
  if (expected && isTupleType(expected)) return `[${elementTypes.join(", ")}]`;
  if (!elementTypes.length) {
    const expectedElement = expected ? arrayElementType(expected) : null;
      return expectedElement ? `${expectedElement}[]` : "any[]";
  }
  const common = leastUpperBound(elementTypes, bound.env);
  return common ? `${common}[]` : `[${elementTypes.join(", ")}]`;
}

function arrayElementTypes(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName[] {
  if (node.type !== NodeType.SpreadElement) return [inferExpression(node, bound, scope)];
  const spreadType = inferExpression(node.argument as ASTNode, bound, scope);
  const resolved = resolveType(spreadType, bound.env);
  if (isTupleType(resolved)) return tupleTypes(resolved);
  return [iterableBindingType(resolved, "of", bound.env)];
}

function inferBinary(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const op = String(node.op ?? "");
  const left = inferExpression(node.left as ASTNode, bound, scope);
  const right = inferExpression(node.right as ASTNode, bound, scope);
  if (node.type === NodeType.NullishCoalescingExpression) return unionType([removeNullish(left, bound.env), right]);
  return binaryOperatorSemantics(op, left, right, bound.env).result;
}

function inferUnary(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const op = String(node.op ?? "");
  const arg = inferExpression(node.argument as ASTNode, bound, scope);
  if (op === "!" || op === "delete") return "bool";
  if (op === "typeof") return "string";
  if (op === "void") return "undefined";
  if (op === "~") return "int";
  if (op === "-" && isTensorType(arg, bound.env)) return "Tensor";
  if ((op === "-" || op === "+") && compatible(arg, "float", bound.env)) return arg === "int" ? "int" : "float";
  return "any";
}

function inferCompound(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const op = String(node.op ?? "");
  const left = inferExpression(node.target as ASTNode, bound, scope);
  const right = inferExpression(node.value as ASTNode, bound, scope);
  return binaryOperatorSemantics(op, left, right, bound.env).result;
}

export function objectLiteralShape(node: ASTNode, bound: BoundProgram, scope: Scope): ObjectShape {
  return { fields: new Map([...objectLiteralFields(node, bound, scope)].map(([name, field]) => [name, { type: field.type, optional: field.optional }])) };
}

export function objectLiteralFields(node: ASTNode, bound: BoundProgram, scope: Scope): Map<string, ObjectLiteralField> {
  const fields = new Map<string, ObjectLiteralField>();
  for (const prop of node.properties as ObjectPropertyNode[]) {
    if (prop.spread) {
      const argument = prop.argument;
      if (!argument) continue;
      const shape = instantiateShapeForType(inferExpression(argument, bound, scope), bound.env);
      if (!shape) continue;
      for (const [name, binding] of shape.fields) fields.set(name, { ...binding, value: argument });
      continue;
    }
    if (prop.computed || prop.key === undefined) continue;
    const name = typeof prop.key === "string" ? prop.key : String((prop.key as ASTNode).value ?? "");
    if (!name) continue;
    const value = prop.value ?? prop.argument;
    if (!value) continue;
    fields.set(name, { type: inferExpression(value, bound, scope), optional: false, value });
  }
  return fields;
}

function memberName(node: ASTNode): string {
  return typeof node.property === "string" ? node.property : String((node.property as ASTNode).name ?? "");
}

function inferMember(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const objectType = inferExpression(node.object as ASTNode, bound, scope);
  const optional = node.type === NodeType.OptionalMemberExpression;
  if (node.computed) {
    const out: TypeName[] = [];
    for (const part of unionParts(objectType, bound.env)) {
      const resolved = resolveType(part, bound.env);
      if (resolved === "null" || resolved === "undefined") {
        if (optional) out.push("undefined");
        else out.push("unknown");
        continue;
      }
      out.push(inferIndexedType(resolved, node.property as ASTNode, false, bound, scope));
    }
    return unionType(out);
  }
  const property = memberName(node);
  const parts = unionParts(objectType, bound.env);
  const out: TypeName[] = [];
  for (const part of parts) {
    const resolved = resolveType(part, bound.env);
    if (resolved === "null" || resolved === "undefined") {
      if (optional) out.push("undefined");
      else out.push("unknown");
      continue;
    }
    out.push(memberType(resolved, property, bound.env) ?? "unknown");
  }
  return unionType(out);
}

function inferIndexExpression(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  let current = inferExpression(node.object as ASTNode, bound, scope);
  for (const dim of node.dims as ASTNode[]) {
    current = inferIndexedType(current, indexValueNode(dim), dim.kind === "slice", bound, scope);
  }
  return current;
}

function inferIndexedType(type: TypeName, key: ASTNode | null | undefined, slice: boolean, bound: BoundProgram, scope: Scope): TypeName {
  return indexedAccessType(type, key ? inferExpression(key, bound, scope) : null, literalIndexKey(key), slice, bound.env);
}

function indexValueNode(dim: ASTNode): ASTNode | null {
  if (dim.kind === "index") return dim.value as ASTNode;
  return null;
}

export function literalIndexKey(node: ASTNode | null | undefined): string | number | null {
  if (!node) return null;
  if (node.type === NodeType.UnaryExpression && node.op === "-") {
    const value = literalIndexKey(node.argument as ASTNode);
    return typeof value === "number" ? -value : null;
  }
  if (node.type !== NodeType.Literal) return null;
  return typeof node.value === "string" || typeof node.value === "number" ? node.value : null;
}

export function instantiateForCall(sig: Signature, args: ASTNode[], bound: BoundProgram, scope: Scope, explicitTypeArgs: string[] = []): Signature {
  if (sig.typeParams.length === 0) return sig;
  const substitutions = new Map<string, TypeName>();
  for (let i = 0; i < explicitTypeArgs.length && i < sig.typeParams.length; i++) {
    substitutions.set(sig.typeParams[i], cleanType(explicitTypeArgs[i]));
  }
  let positional = 0;
  for (const rawArg of args) {
    const isNamed = rawArg.type === NodeType.NamedArgument;
    const paramName = isNamed ? String(rawArg.name) : sig.positional[positional++];
    if (!paramName) continue;
    const param = sig.params.get(paramName);
    if (!param) continue;
    const value = isNamed ? rawArg.value as ASTNode : rawArg;
    const actual = inferExpression(value, bound, scope);
    for (const typeParam of sig.typeParams) {
      if (!substitutions.has(typeParam) && new RegExp(`\\b${typeParam}\\b`).test(param.type)) {
        substitutions.set(typeParam, actual);
      }
    }
  }
  for (const typeParam of sig.typeParams) {
    if (!substitutions.has(typeParam)) substitutions.set(typeParam, "unknown");
  }
  return instantiateSignature(sig, substitutions);
}

function inferCall(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const comprehension = arrayComprehensionType(node, bound, scope);
  if (comprehension) return comprehension;
  const sig = callSignatureForCallee(node.callee as ASTNode, bound, scope);
  return sig ? instantiateForCall(sig, node.args as ASTNode[], bound, scope, typeArgsOf(node.callee as ASTNode)).returns : "unknown";
}

function inferNew(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const sig = callSignatureForCallee(node.callee as ASTNode, bound, scope);
  return sig ? instantiateForCall(sig, node.args as ASTNode[], bound, scope, typeArgsOf(node.callee as ASTNode)).returns : "unknown";
}

function inferSequence(
  node: ASTNode,
  bound: BoundProgram,
  scope: Scope,
  expected?: Signature | null,
  expectedType?: TypeName | null,
): TypeName {
  const expressions = node.expressions as ASTNode[];
  const last = expressions.at(-1);
  return last ? inferExpression(last, bound, scope, expected, expectedType) : "undefined";
}

function inferArrow(node: ASTNode, bound: BoundProgram, scope: Scope, expected: Signature | null): TypeName {
  const child: Scope = { parent: scope, locals: new Map(), signatures: new Map(), signature: expected ?? undefined };
  const params = node.params as Array<string | { name?: string }>;
  for (let i = 0; i < params.length; i++) {
    const paramName = typeof params[i] === "string" ? params[i] as string : String((params[i] as { name?: string }).name ?? `arg${i}`);
    const expectedType = expected?.params.get(expected.positional[i])?.type ?? "any";
    child.locals.set(paramName, { type: expectedType, optional: false });
  }
  const body = node.body as ASTNode | ASTNode[];
  const returnType = Array.isArray(body) || body.type === NodeType.BlockStatement ? "any" : inferExpression(body, bound, child);
  const paramTypes = params.map((_, i) => expected?.params.get(expected.positional[i])?.type ?? "any").join(", ");
  return `(${paramTypes}) -> ${returnType}`;
}

export function narrowScope(test: ASTNode | undefined, bound: BoundProgram, parent: Scope, target?: Scope): Scope {
  const child: Scope = target ?? { parent, locals: new Map(), signatures: new Map(), signature: parent.signature };
  if (!test) return child;
  if (test.type === NodeType.BinaryExpression && ["!=", "==", "!==", "==="].includes(String(test.op))) {
    const left = test.left as ASTNode;
    const right = test.right as ASTNode;
    const subject = nullishComparisonSubject(left, right);
    if (subject) {
      const binding = lookup(parent, subject);
      if (binding) {
        const nonNullish = test.op === "!=" || test.op === "!==";
        const next = nonNullish ? removeNullish(binding.type, bound.env) : unionType(unionParts(binding.type, bound.env).filter((part) => part === "null" || part === "undefined"));
        child.locals.set(subject, { ...binding, type: next });
      }
    }
  }
  return child;
}

function nullishComparisonSubject(left: ASTNode, right: ASTNode): string | null {
  if (left.type === NodeType.Identifier && right.type === NodeType.Literal && (right.kind === "null" || right.kind === "undefined")) return String(left.name);
  if (right.type === NodeType.Identifier && left.type === NodeType.Literal && (left.kind === "null" || left.kind === "undefined")) return String(right.name);
  return null;
}

export function functionSignatureForType(name: string, type: TypeName): Signature | null {
  const parsed = parseFunctionType(type);
  return parsed ? { ...parsed, name } : null;
}

export function callSignatureForCallee(callee: ASTNode, bound: BoundProgram, scope: Scope): Signature | null {
  if (callee.type === NodeType.ArrowFunctionExpression) return arrowSignature("<call>", callee, bound, scope);
  const dotted = callee.type === NodeType.Identifier ? null : dottedName(callee);
  if (dotted) {
    const scoped = lookupSignature(scope, dotted);
    if (scoped) return scoped;
  }
  if (callee.type === NodeType.Identifier) {
    const name = String(callee.name);
    const binding = lookup(scope, name);
    if (binding) return functionSignatureForType(name, binding.type) ?? callSignatureForType(binding.type, bound.env);
    const scoped = lookupSignature(scope, name);
    return scoped ?? null;
  }
  if (callee.type === NodeType.MemberExpression || callee.type === NodeType.OptionalMemberExpression) {
    const objectType = inferExpression(callee.object as ASTNode, bound, scope);
    return memberSignature(objectType, memberName(callee), bound.env);
  }
  const inferred = inferExpression(callee, bound, scope);
  return functionSignatureForType("<call>", inferred) ?? callSignatureForType(inferred, bound.env);
}

function arrowSignature(name: string, node: ASTNode, bound: BoundProgram, scope: Scope): Signature {
  const params = new Map<string, Binding>();
  const positional: string[] = [];
  const required = new Set<string>();
  for (const param of node.params as Array<string | { name?: string }>) {
    const paramName = typeof param === "string" ? param : String(param.name ?? `arg${positional.length}`);
    params.set(paramName, { type: "any", optional: false });
    positional.push(paramName);
    required.add(paramName);
  }
  const body = node.body as ASTNode | ASTNode[];
  const returns = arrayComprehensionType({ type: NodeType.CallExpression, callee: node, args: [] }, bound, scope) ??
    (Array.isArray(body) || body.type === NodeType.BlockStatement ? "any" : inferExpression(body, bound, scope));
  return { name, typeParams: [], params, positional, required, returns };
}

function arrayComprehensionType(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName | null {
  if (node.type !== NodeType.CallExpression || (node.args as ASTNode[]).length !== 0) return null;
  const callee = node.callee as ASTNode;
  if (callee.type !== NodeType.ArrowFunctionExpression) return null;
  const body = callee.body as ASTNode;
  if (body.type !== NodeType.BlockStatement) return null;
  const statements = body.body as ASTNode[];
  if (statements.length !== 3) return null;
  const declaration = statements[0];
  const loop = statements[1];
  const ret = statements[2];
  if (declaration.type !== NodeType.LetDeclaration || loop.type !== NodeType.ForOfStatement || ret.type !== NodeType.ReturnStatement) return null;
  const name = typeof declaration.name === "string" ? declaration.name : "";
  const argument = ret.argument;
  if (!name || !isAstNode(argument) || argument.type !== NodeType.Identifier || argument.name !== name) return null;
  const loopScope: Scope = { parent: scope, locals: new Map(), signatures: new Map(), signature: scope.signature };
  const variable = loop.variable;
  if (isBindingIdentifier(variable)) {
    const iterable = inferExpression(loop.iterable as ASTNode, bound, scope);
    loopScope.locals.set(String(variable.name), { type: iterableBindingType(iterable, "of", bound.env), optional: false });
  }
  const loopBody = loop.body as ASTNode;
  const projection = comprehensionProjection(loopBody, name);
  const element = projection ? inferExpression(projection, bound, loopScope) : "any";
  return `${element}[]`;
}

function isAstNode(value: unknown): value is ASTNode {
  return !!value && typeof value === "object" && "type" in value;
}

function isBindingIdentifier(value: unknown): value is { kind: "id"; name: string } {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "id" && typeof (value as { name?: unknown }).name === "string";
}

function comprehensionProjection(body: ASTNode, accumulator: string): ASTNode | null {
  if (body.type !== NodeType.BlockStatement) return null;
  const statement = (body.body as ASTNode[])[0];
  const expression = statement?.type === NodeType.ExpressionStatement ? statement.expression as ASTNode : null;
  if (!expression || expression.type !== NodeType.CallExpression) return null;
  const callee = expression.callee as ASTNode;
  if (callee.type !== NodeType.MemberExpression || callee.property !== "push") return null;
  const object = callee.object as ASTNode;
  if (object.type !== NodeType.Identifier || object.name !== accumulator) return null;
  return (expression.args as ASTNode[])[0] ?? null;
}

function memberType(type: TypeName, property: string, env: TypeEnv): TypeName | null {
  const shape = instantiateShapeForType(type, env);
  const field = shape?.fields.get(property);
  if (field) return field.optional ? unionType([field.type, "undefined"]) : field.type;
  const method = builtinMethod(type, property, env);
  if (!method) return null;
  return method.getter ? method.returns : signatureType(method.signature);
}

function memberSignature(type: TypeName, property: string, env: TypeEnv): Signature | null {
  const signatures: Signature[] = [];
  for (const part of unionParts(type, env)) {
    const resolved = resolveType(part, env);
    if (resolved === "null" || resolved === "undefined") continue;
    const shape = instantiateShapeForType(resolved, env);
    const field = shape?.fields.get(property);
    const fieldSig = field ? functionSignatureForType(property, field.type) : null;
    if (fieldSig) signatures.push(fieldSig);
    const fieldCallSig = field ? callSignatureForType(field.type, env) : null;
    if (fieldCallSig) signatures.push({ ...fieldCallSig, name: `${property}.${fieldCallSig.name}` });
    const arraySig = arrayMethodSignature(resolved, property, env);
    if (arraySig) signatures.push(arraySig);
    const method = builtinMethod(resolved, property, env);
    if (method && !method.getter) signatures.push(method.signature);
  }
  return signatures[0] ?? null;
}

function arrayMethodSignature(type: TypeName, property: string, env: TypeEnv): Signature | null {
  const element = typedArrayElement(type, env);
  if (!element) return null;
  const owner = "Array";
  if (property === "push" || property === "unshift") return signature(`${owner}.${property}`, [["x", element]], "int");
  if (property === "pop" || property === "shift") return signature(`${owner}.${property}`, [], unionType([element, "undefined"]));
  if (property === "slice") return signature(`${owner}.slice`, [["start", "int", true], ["end", "int", true]], `${element}[]`);
  if (property === "concat") {
    const rest: Signature["rest"] = { name: "arrays", type: unionType([element, `${element}[]`]), optional: true, named: false };
    return { name: `${owner}.concat`, typeParams: [], params: new Map(), required: new Set(), positional: [], returns: `${element}[]`, rest };
  }
  return null;
}

function typedArrayElement(type: TypeName, env: TypeEnv): TypeName | null {
  const resolved = resolveType(type, env);
  const element = arrayElementType(resolved);
  if (element) return element;
  if (isTupleType(resolved)) return unionType(tupleTypes(resolved));
  return null;
}

function dottedName(node: ASTNode): string | null {
  if (node.type === NodeType.Identifier) return String(node.name);
  if (node.type !== NodeType.MemberExpression) return null;
  const object = dottedName(node.object as ASTNode);
  if (!object) return null;
  const property = typeof node.property === "string" ? node.property : String((node.property as ASTNode).name ?? "");
  return property ? `${object}.${property}` : null;
}

export function typeArgsOf(node: ASTNode): string[] {
  return Array.isArray(node.typeArgs) ? node.typeArgs as string[] : [];
}
