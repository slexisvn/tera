import {
  ANY, NUMBER, INT, FLOAT, STRING, BOOL, NULL, NONE, TENSOR,
  listType, dictType, functionType, moduleType, unionType,
  isAssignable, isAny, typeToString, join,
} from './types.js';
import { ASYNC, SYNC, joinEffect, isAsyncEffect, methodEffect } from './effects.js';

export class LangTypeError extends Error {
  constructor(message, line, column) {
    super(`${message} at ${line}:${column}`);
    this.name = 'TypeError';
    this.line = line;
    this.column = column;
  }
}

const NAME_TYPES = {
  int: INT, float: FLOAT,
  string: STRING, boolean: BOOL,
  Tensor: TENSOR, tensor: TENSOR, none: NONE, null: NULL,
};

export const TYPE_NAMES = Object.freeze([...Object.keys(NAME_TYPES), 'Record']);

export const HOST_GLOBALS = Object.freeze(['chart']);

const STEP_SCOPED_BUILTINS = new Map([['log', 'log() can only be called inside a train or validate block']]);

const TENSOR_MEMBERS = {
  shape: listType(NUMBER), ndim: NUMBER, numel: NUMBER,
  dtype: STRING, device: STRING, requiresGrad: BOOL, grad: TENSOR,
};

function listMethodResult(prop, type) {
  switch (prop) {
    case 'append': case 'extend': case 'insert':
    case 'remove': case 'reverse': case 'clear': return NONE;
    case 'pop': return type.element;
    case 'index': case 'count': return INT;
    case 'contains': return BOOL;
    case 'copy': return listType(type.element);
    default: return null;
  }
}

function stringMethodResult(prop) {
  switch (prop) {
    case 'upper': case 'lower': case 'strip': case 'lstrip': case 'rstrip':
    case 'replace': case 'join': return STRING;
    case 'split': return listType(STRING);
    case 'starts_with': case 'ends_with': case 'contains': return BOOL;
    case 'find': return INT;
    default: return null;
  }
}

function dictMethodResult(prop, type) {
  switch (prop) {
    case 'keys': return listType(type.key);
    case 'values': return listType(type.value);
    case 'items': return listType(ANY);
    case 'get': return type.value;
    case 'has': return BOOL;
    case 'remove': return NONE;
    default: return null;
  }
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ARITHMETIC = new Set(['-', '*', '/', '%', '**']);
const NON_CALLABLE = new Set(['number', 'string', 'bool', 'list', 'dict', 'tensor', 'null', 'none']);

class TypeEnv {
  constructor(parent = null) {
    this.parent = parent;
    this.values = new Map();
  }
  define(name, type) { this.values.set(name, type); return type; }
  lookup(name) {
    if (this.values.has(name)) return this.values.get(name);
    if (this.parent) return this.parent.lookup(name);
    return undefined;
  }
}

class TypeChecker {
  constructor({ builtinNames, builtinTypes, methodReturns, moduleCalls }) {
    this.diagnostics = [];
    this.reserved = new Set([...builtinNames, 'await']);
    this.inferred = new Map();
    this.modelReturns = new Map();
    this.modelEffects = new Map();
    this.modelFields = new Map();
    this.methodReturns = methodReturns ?? new Map();
    this.moduleCalls = moduleCalls ?? new Map();
    this.root = new TypeEnv();
    this.awaitDepth = 0;
    for (const [name, type] of builtinTypes) this.root.define(name, type);
    for (const name of builtinNames) if (!this.root.lookup(name)) this.root.define(name, ANY);

    this.exprHandlers = {
      Literal: node => this.inferLiteral(node),
      Identifier: (node, env) => this.inferIdentifier(node, env),
      Array: (node, env) => this.inferArray(node, env),
      Dict: (node, env) => this.inferDict(node, env),
      ListComprehension: (node, env) => this.inferComprehension(node, env),
      Unary: (node, env) => this.inferUnary(node, env),
      Binary: (node, env) => this.inferBinary(node, env),
      Member: (node, env) => this.inferMember(node, env),
      Index: (node, env) => this.inferIndex(node, env),
      Call: (node, env) => this.inferCall(node, env),
      Await: (node, env) => this.inferAwait(node, env),
    };
    this.stmtHandlers = {
      Assign: (node, env) => this.checkAssign(node, env),
      CompoundAssign: (node, env) => this.checkCompoundAssign(node, env),
      DestructureAssign: (node, env) => this.checkDestructure(node, env),
      IndexAssign: (node, env) => this.checkIndexAssign(node, env),
      If: (node, env, ctx) => this.checkIf(node, env, ctx),
      For: (node, env, ctx) => this.checkFor(node, env, ctx),
      While: (node, env, ctx) => this.checkWhile(node, env, ctx),
      Return: (node, env, ctx) => this.checkReturn(node, env, ctx),
      ExpressionStatement: (node, env) => { this.infer(node.expression, env); node.effect = node.expression.effect; node.async = node.expression.async === true; return node.effect; },
      FunctionDeclaration: (node, env) => this.checkFunction(node, env),
      ModelDeclaration: (node, env) => this.checkModel(node, env),
    };
  }

  run(program) {
    program.effect = this.checkBlock(program.body, this.root, { returns: [], declaredReturn: ANY });
    program.async = program.body.some(statement => statement.async === true);
    return this.diagnostics;
  }

  report(message, node) {
    this.diagnostics.push(new LangTypeError(message, node?.line ?? 1, node?.column ?? 1));
  }

  declare(env, name, type, node) {
    if (this.reserved.has(name)) this.report(`cannot redefine built-in '${name}'`, node);
    if (node?.line != null && !isAny(type)) this.inferred.set(`${name}:${node.line}`, typeToString(type));
    return env.define(name, type);
  }

  checkBlock(body, env, ctx) {
    let effect = SYNC;
    for (const statement of body) effect = joinEffect(effect, this.checkStatement(statement, env, ctx));
    return effect;
  }

  checkStatement(node, env, ctx) {
    const handler = this.stmtHandlers[node.type];
    if (!handler) return SYNC;
    const effect = handler(node, env, ctx) ?? node.effect ?? SYNC;
    node.effect = effect;
    node.async = node.async ?? false;
    return effect;
  }

  infer(node, env) {
    const handler = this.exprHandlers[node.type];
    const type = handler ? handler(node, env) : ANY;
    node.effect = node.effect ?? SYNC;
    node.async = node.async ?? false;
    return type;
  }

  isTensor(type) { return type && type.kind === 'tensor'; }

  resolveTypeNode(node) {
    if (!node) return ANY;
    if (node.kind === 'ArrayType') return listType(this.resolveTypeNode(node.element));
    if (node.kind === 'UnionType') return unionType(node.members.map(member => this.resolveTypeNode(member)));
    if (node.kind === 'FunctionType') {
      return functionType(node.params.map(param => this.resolveTypeNode(param)), this.resolveTypeNode(node.ret), false, node.params.length);
    }
    if (node.kind === 'GenericType') {
      if (node.name === 'Record') return dictType(this.resolveTypeNode(node.args[0]), this.resolveTypeNode(node.args[1]));
      if (node.name === 'Tensor' || node.name === 'tensor') return TENSOR;
      return moduleType(node.name);
    }
    return NAME_TYPES[node.name] ?? moduleType(node.name);
  }

  elementOf(type) {
    if (isAny(type)) return ANY;
    if (type.kind === 'list') return type.element;
    if (type.kind === 'dict') return type.key;
    if (type.kind === 'string') return STRING;
    return ANY;
  }

  inferLiteral(node) {
    const value = node.value;
    node.effect = SYNC;
    node.async = false;
    if (typeof value === 'number') return node.isFloat ? FLOAT : INT;
    if (typeof value === 'string') return STRING;
    if (typeof value === 'boolean') return BOOL;
    if (value === null) return NULL;
    return ANY;
  }

  inferIdentifier(node, env) {
    const type = env.lookup(node.name);
    if (type === undefined) {
      this.report(STEP_SCOPED_BUILTINS.get(node.name) ?? `undefined name '${node.name}'`, node);
      return ANY;
    }
    node.effect = SYNC;
    node.async = false;
    return type;
  }

  inferArray(node, env) {
    let element = null;
    let effect = SYNC;
    for (const item of node.elements) {
      const type = this.infer(item, env);
      effect = joinEffect(effect, item.effect);
      element = element === null ? type : join(element, type);
    }
    node.effect = effect;
    node.async = node.elements.some(item => item.async === true);
    return listType(element ?? ANY);
  }

  inferDict(node, env) {
    let key = null;
    let value = null;
    let effect = SYNC;
    for (const entry of node.entries) {
      const keyType = this.infer(entry.key, env);
      const valueType = this.infer(entry.value, env);
      effect = joinEffect(effect, entry.key.effect, entry.value.effect);
      key = key === null ? keyType : join(key, keyType);
      value = value === null ? valueType : join(value, valueType);
    }
    node.effect = effect;
    node.async = node.entries.some(entry => entry.key.async === true || entry.value.async === true);
    return dictType(key ?? ANY, value ?? ANY);
  }

  inferComprehension(node, env) {
    const iterable = this.infer(node.iterable, env);
    const scope = new TypeEnv(env);
    this.declare(scope, node.variable, this.elementOf(iterable), node);
    if (node.condition) this.infer(node.condition, scope);
    const type = this.infer(node.expr, scope);
    node.effect = joinEffect(node.iterable.effect, node.condition?.effect, node.expr.effect);
    node.async = node.iterable.async === true || node.condition?.async === true || node.expr.async === true;
    return listType(type);
  }

  inferUnary(node, env) {
    const type = this.infer(node.value, env);
    node.effect = node.value.effect;
    node.async = node.value.async === true;
    if (node.op === 'not') return this.isTensor(type) ? TENSOR : BOOL;
    if (this.isTensor(type)) return TENSOR;
    if (isAny(type)) return ANY;
    if (type.kind === 'number') return type;
    this.report(`operator '${node.op}' cannot be applied to ${typeToString(type)}`, node);
    return ANY;
  }

  inferBinary(node, env) {
    const left = this.infer(node.left, env);
    const right = this.infer(node.right, env);
    node.effect = joinEffect(node.left.effect, node.right.effect);
    node.async = node.left.async === true || node.right.async === true;
    return this.binaryResult(node.op, left, right, node);
  }

  binaryResult(op, left, right, node) {
    const tensor = this.isTensor(left) || this.isTensor(right);
    if (op === 'and' || op === 'or') return tensor ? TENSOR : join(left, right);
    if (COMPARISONS.has(op)) return tensor ? TENSOR : BOOL;
    if (isAny(left) || isAny(right)) return ANY;
    if (op === '@') {
      if (!tensor) this.report(`operator '@' requires tensors, got ${typeToString(left)} and ${typeToString(right)}`, node);
      return TENSOR;
    }
    if (tensor) return TENSOR;
    if (left.kind === 'number' && right.kind === 'number') {
      if (op === '/') return FLOAT;
      return left.num === 'float' || right.num === 'float' ? FLOAT : INT;
    }
    if (op === '+') {
      if (left.kind === 'string' && right.kind === 'string') return STRING;
      if (left.kind === 'list' && right.kind === 'list') return listType(join(left.element, right.element));
    }
    if (op === '+' || ARITHMETIC.has(op)) {
      this.report(`operator '${op}' cannot be applied to ${typeToString(left)} and ${typeToString(right)}`, node);
    }
    return ANY;
  }

  inferMember(node, env) {
    const type = this.infer(node.object, env);
    node.effect = node.object.effect;
    node.async = node.object.async === true;
    return this.memberType(type, node.property);
  }

  memberType(object, property) {
    if (isAny(object)) return ANY;
    if (object.kind === 'tensor') return TENSOR_MEMBERS[property] ?? ANY;
    if (object.kind === 'module') {
      const fields = this.modelFields.get(object.name);
      if (fields && fields.has(property)) return fields.get(property);
      const own = this.methodReturns.get(object.name)?.get(property);
      if (own) return own.type ?? own;
      if (this.modelFields.has(object.name)) {
        const inherited = this.methodReturns.get('Model')?.get(property);
        if (inherited) return inherited.type ?? inherited;
      }
    }
    if ((object.kind === 'list' || object.kind === 'string') && property === 'length') return NUMBER;
    return ANY;
  }

  typeNameOf(type) {
    if (!type) return null;
    if (type.kind === 'tensor') return 'Tensor';
    if (type.kind === 'module') return type.name || null;
    if (type.kind === 'function' && type.ret?.kind === 'module') return type.ret.name || null;
    return null;
  }

  methodResult(objectType, property) {
    const info = this.methodInfo(objectType, property);
    return info ? info.type : null;
  }

  methodInfo(objectType, property) {
    const name = this.typeNameOf(objectType);
    let known = name && this.methodReturns.get(name)?.get(property);
    if (!known && objectType.kind === 'module' && this.modelFields.has(name)) {
      known = this.methodReturns.get('Model')?.get(property);
    }
    if (known) return { type: known.type ?? known, effect: known.effect ?? methodEffect(name, property), teraOwned: known.teraOwned ?? true };
    const effect = methodEffect(name, property);
    if (objectType.kind === 'list') { const t = listMethodResult(property, objectType); if (t) return { type: t, effect, teraOwned: true }; }
    if (objectType.kind === 'string') { const t = stringMethodResult(property); if (t) return { type: t, effect, teraOwned: true }; }
    if (objectType.kind === 'dict') { const t = dictMethodResult(property, objectType); if (t) return { type: t, effect, teraOwned: true }; }
    if (this.isTensor(objectType)) return { type: this.tensorMethodResult(property), effect, teraOwned: true };
    if (isAsyncEffect(effect)) return { type: ANY, effect, teraOwned: true };
    return null;
  }

  tensorMethodResult(property) {
    if (property === 'item') return NUMBER;
    if (property === 'toArray' || property === 'tolist') return listType(NUMBER);
    return TENSOR;
  }

  requireNumberIndex(indexType, node) {
    if (isAny(indexType) || this.isTensor(indexType) || indexType.kind === 'number') return;
    this.report(`index must be a number, got ${typeToString(indexType)}`, node);
  }

  checkIndexItems(items, object, env) {
    for (const item of items) {
      if (item.type === 'Slice') {
        for (const part of [item.start, item.end, item.step]) {
          if (part) this.requireNumberIndex(this.infer(part, env), part);
        }
        continue;
      }
      const indexType = this.infer(item, env);
      if (isAny(object)) continue;
      if (object.kind === 'list' || object.kind === 'string') {
        this.requireNumberIndex(indexType, item);
      } else if (object.kind === 'dict' && !isAssignable(indexType, object.key)) {
        this.report(`index of type ${typeToString(indexType)} is not assignable to key type ${typeToString(object.key)}`, item);
      }
    }
  }

  inferIndex(node, env) {
    const object = this.infer(node.object, env);
    this.checkIndexItems(node.items, object, env);
    node.effect = joinEffect(node.object.effect, ...node.items.map(item => item.effect));
    node.async = node.object.async === true || node.items.some(item => item.async === true);
    if (isAny(object)) return ANY;
    if (object.kind === 'list') return object.element;
    if (object.kind === 'dict') return object.value;
    if (object.kind === 'string') return STRING;
    return ANY;
  }

  inferCall(node, env) {
    const positional = [];
    const named = [];
    let argsEffect = SYNC;
    for (const arg of node.args) {
      const type = this.infer(arg.value, env);
      argsEffect = joinEffect(argsEffect, arg.value.effect);
      if (arg.name) named.push({ name: arg.name, type, node: arg.value });
      else positional.push({ type, node: arg.value });
    }
    if (node.callee.type === 'Member') {
      const objectType = this.infer(node.callee.object, env);
      const method = this.methodInfo(objectType, node.callee.property);
      if (method !== null) return this.finishCallResult(method.type, joinEffect(argsEffect, node.callee.object.effect, method.effect), method.teraOwned, node);
      const calleeType = this.memberType(objectType, node.callee.property);
      return this.finishCall(this.withEffect(calleeType, node.callee.object.effect), positional, named, argsEffect, node);
    }
    const calleeType = this.infer(node.callee, env);
    return this.finishCall(calleeType, positional, named, joinEffect(argsEffect, node.callee.effect), node);
  }

  finishCall(calleeType, positional, named, argsEffect, node) {
    if (calleeType.kind === 'module') {
      if (this.modelReturns.has(calleeType.name)) return this.finishCallResult(this.modelReturns.get(calleeType.name), joinEffect(argsEffect, this.modelEffects.get(calleeType.name)), false, node);
      if (this.moduleCalls.has(calleeType.name)) return this.finishCallResult(this.moduleCalls.get(calleeType.name), argsEffect, true, node);
    }
    if (calleeType.kind !== 'function') {
      if (NON_CALLABLE.has(calleeType.kind)) this.report(`${typeToString(calleeType)} is not callable`, node.callee);
      node.effect = argsEffect;
      node.async = isAsyncEffect(argsEffect) || node.callee?.async === true || node.args?.some(arg => arg.value.async === true) || false;
      return ANY;
    }
    if (named.length === 0) this.checkPositionalCall(calleeType, positional, node);
    else if (calleeType.names) this.checkNamedCall(calleeType, positional, named, node);
    return this.finishCallResult(calleeType.ret, joinEffect(argsEffect, calleeType.effect), calleeType.teraOwned, node);
  }

  finishCallResult(type, effect, teraOwned, node) {
    if (isAsyncEffect(effect) && teraOwned && this.awaitDepth === 0) {
      const call = { type: 'Call', callee: node.callee, args: node.args, line: node.line, column: node.column, effect, async: true };
      node.type = 'Await';
      delete node.callee;
      delete node.args;
      node.value = call;
      node.explicit = false;
      node.effect = SYNC;
      node.async = true;
      return type;
    }
    if (isAsyncEffect(effect) && !teraOwned && this.awaitDepth === 0) {
      this.report('async call requires await', node);
    }
    node.effect = effect;
    node.async = isAsyncEffect(effect) || node.callee?.async === true || node.args?.some(arg => arg.value.async === true) || false;
    return type;
  }

  withEffect(type, effect) {
    if (type?.kind !== 'function' || !isAsyncEffect(effect)) return type;
    return { ...type, effect: joinEffect(type.effect, effect) };
  }

  inferAwait(node, env) {
    this.awaitDepth++;
    const type = this.infer(node.value, env);
    this.awaitDepth--;
    node.value.async = true;
    node.effect = SYNC;
    node.async = true;
    return type;
  }

  checkPositionalCall(calleeType, positional, node) {
    const min = calleeType.required;
    const max = calleeType.variadic ? Infinity : calleeType.params.length;
    if (positional.length < min || positional.length > max) {
      const expected = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}-${max}`;
      this.report(`expected ${expected} argument(s), got ${positional.length}`, node);
      return;
    }
    for (let i = 0; i < positional.length && i < calleeType.params.length; i++) {
      if (!isAssignable(positional[i].type, calleeType.params[i])) {
        this.report(`argument ${i + 1} expects ${typeToString(calleeType.params[i])}, got ${typeToString(positional[i].type)}`, positional[i].node);
      }
    }
  }

  checkNamedCall(calleeType, positional, named, node) {
    const { names, params, required } = calleeType;
    if (positional.length > params.length) {
      this.report(`expected at most ${params.length} argument(s), got ${positional.length} positional`, node);
      return;
    }
    const filled = new Array(params.length).fill(null);
    for (let i = 0; i < positional.length; i++) filled[i] = positional[i];
    for (const arg of named) {
      const index = names.indexOf(arg.name);
      if (index === -1) { this.report(`unknown argument '${arg.name}'`, arg.node); continue; }
      if (filled[index]) { this.report(`argument '${arg.name}' specified more than once`, arg.node); continue; }
      filled[index] = arg;
    }
    for (let i = 0; i < params.length; i++) {
      if (!filled[i]) {
        if (i < required) this.report(`missing required argument '${names[i]}'`, node);
        continue;
      }
      if (!isAssignable(filled[i].type, params[i])) {
        this.report(`argument '${names[i]}' expects ${typeToString(params[i])}, got ${typeToString(filled[i].type)}`, filled[i].node);
      }
    }
  }

  checkAssign(node, env) {
    const valueType = this.infer(node.value, env);
    node.effect = node.value.effect;
    node.async = node.value.async === true;
    if (node.annotation) {
      const declared = this.resolveTypeNode(node.annotation);
      if (!isAssignable(valueType, declared)) {
        this.report(`cannot assign ${typeToString(valueType)} to '${node.name}: ${typeToString(declared)}'`, node);
      }
      this.declare(env, node.name, declared, node);
    } else {
      this.declare(env, node.name, valueType, node);
    }
    return node.effect;
  }

  checkCompoundAssign(node, env) {
    const current = env.lookup(node.name);
    if (current === undefined) this.report(`undefined name '${node.name}'`, node);
    const value = this.infer(node.value, env);
    node.effect = node.value.effect;
    node.async = node.value.async === true;
    this.declare(env, node.name, this.binaryResult(node.op, current ?? ANY, value, node), node);
    return node.effect;
  }

  checkDestructure(node, env) {
    const valueType = this.infer(node.value, env);
    node.effect = node.value.effect;
    node.async = node.value.async === true;
    if (!isAny(valueType) && valueType.kind !== 'list' && !this.isTensor(valueType)) {
      this.report(`cannot destructure ${typeToString(valueType)}`, node);
    }
    const element = valueType.kind === 'list' ? valueType.element : ANY;
    for (const name of node.names) this.declare(env, name, element, node);
    return node.effect;
  }

  checkIndexAssign(node, env) {
    const object = this.infer(node.object, env);
    this.checkIndexItems(node.items, object, env);
    const valueType = this.infer(node.value, env);
    node.effect = joinEffect(node.object.effect, node.value.effect, ...node.items.map(item => item.effect));
    node.async = node.object.async === true || node.value.async === true || node.items.some(item => item.async === true);
    if (isAny(object)) return node.effect;
    if (object.kind === 'list' && !isAssignable(valueType, object.element)) {
      this.report(`cannot assign ${typeToString(valueType)} to element of ${typeToString(object)}`, node);
    } else if (object.kind === 'dict' && !isAssignable(valueType, object.value)) {
      this.report(`cannot assign ${typeToString(valueType)} to value of ${typeToString(object)}`, node);
    }
    return node.effect;
  }

  checkIf(node, env, ctx) {
    this.infer(node.condition, env);
    let effect = joinEffect(node.condition.effect, this.checkBlock(node.body, env, ctx));
    for (const elif of node.elifs) {
      this.infer(elif.condition, env);
      effect = joinEffect(effect, elif.condition.effect, this.checkBlock(elif.body, env, ctx));
    }
    if (node.elseBody) effect = joinEffect(effect, this.checkBlock(node.elseBody, env, ctx));
    node.effect = effect;
    node.async = node.condition.async === true || node.body.some(statement => statement.async === true) || node.elifs.some(elif => elif.condition.async === true || elif.body.some(statement => statement.async === true)) || node.elseBody?.some(statement => statement.async === true) === true;
    return effect;
  }

  checkFor(node, env, ctx) {
    const iterable = this.infer(node.iterable, env);
    this.declare(env, node.variable, this.elementOf(iterable), node);
    node.effect = joinEffect(node.iterable.effect, this.checkBlock(node.body, env, ctx));
    node.async = node.iterable.async === true || node.body.some(statement => statement.async === true);
    return node.effect;
  }

  checkWhile(node, env, ctx) {
    this.infer(node.condition, env);
    node.effect = joinEffect(node.condition.effect, this.checkBlock(node.body, env, ctx));
    node.async = node.condition.async === true || node.body.some(statement => statement.async === true);
    return node.effect;
  }

  checkReturn(node, env, ctx) {
    ctx.returns.push({ type: this.infer(node.value, env), node });
    node.effect = node.value.effect;
    node.async = node.value.async === true;
    return node.effect;
  }

  resolveParams(names, annotations, owner, node, env) {
    return names.map((name, index) => {
      const annotation = annotations?.[index];
      if (this.reserved.has(name)) {
        this.report(`parameter '${name}' of ${owner} cannot redefine built-in '${name}'`, annotation ?? node);
      }
      if (!annotation) {
        this.report(`parameter '${name}' of ${owner} needs a type annotation`, node);
        return ANY;
      }
      const type = this.resolveTypeNode(annotation);
      if (!isAny(type)) this.inferred.set(`${name}:${annotation.line ?? node.line}`, typeToString(type));
      return type;
    });
  }

  checkReturnTypes(returns, declared) {
    for (const result of returns) {
      if (!isAssignable(result.type, declared)) {
        this.report(`return type ${typeToString(result.type)} is not assignable to declared ${typeToString(declared)}`, result.node);
      }
    }
  }

  allowsImplicitReturn(type) {
    if (isAny(type) || type.kind === 'none') return true;
    if (type.kind === 'union') return type.members.some(member => member.kind === 'none');
    return false;
  }

  blockReturns(body) {
    for (const statement of body) {
      if (statement.type === 'Return') return true;
      if (statement.type === 'If' && this.ifReturns(statement)) return true;
    }
    return false;
  }

  ifReturns(node) {
    if (!node.elseBody || !this.blockReturns(node.body)) return false;
    for (const elif of node.elifs) {
      if (!this.blockReturns(elif.body)) return false;
    }
    return this.blockReturns(node.elseBody);
  }

  checkAllPathsReturn(body, declared, node, owner) {
    if (this.allowsImplicitReturn(declared)) return;
    if (!this.blockReturns(body)) {
      this.report(`${owner} may not return a value on all paths; expected ${typeToString(declared)}`, node);
    }
  }

  checkFunction(node, env) {
    const paramTypes = this.resolveParams(node.params, node.paramTypes, `'${node.name}'`, node, env);
    if (!node.returnType) this.report(`function '${node.name}' needs a return type annotation`, node);
    const declaredReturn = node.returnType ? this.resolveTypeNode(node.returnType) : ANY;
    const placeholder = functionType(paramTypes, declaredReturn, false, node.params.length, node.params, SYNC, false);
    this.declare(env, node.name, placeholder, node);
    const fnEnv = new TypeEnv(env);
    node.params.forEach((name, index) => fnEnv.define(name, paramTypes[index]));
    const ctx = { returns: [], declaredReturn };
    const bodyEffect = this.checkBlock(node.body, fnEnv, ctx);
    const effect = node.body.some(statement => statement.async === true) ? ASYNC : bodyEffect;
    env.define(node.name, functionType(paramTypes, declaredReturn, false, node.params.length, node.params, effect, false));
    node.functionEffect = effect;
    node.effect = SYNC;
    node.async = false;
    if (node.returnType) {
      this.checkReturnTypes(ctx.returns, declaredReturn);
      this.checkAllPathsReturn(node.body, declaredReturn, node, `function '${node.name}'`);
    }
  }

  checkModel(node, env) {
    const paramTypes = this.resolveParams(node.params, node.paramTypes, `model '${node.name}'`, node, env);
    this.declare(env, node.name, functionType(paramTypes, moduleType(node.name), false, node.params.length, node.params, SYNC, false), node);
    const forward = node.body.find(block => block.type === 'ForwardDeclaration');
    if (forward) this.modelReturns.set(node.name, forward.returnType ? this.resolveTypeNode(forward.returnType) : ANY);
    const modelEnv = new TypeEnv(env);
    node.params.forEach((name, index) => modelEnv.define(name, paramTypes[index]));

    const blocks = new Set(['ForwardDeclaration', 'TrainDeclaration', 'ValidateDeclaration', 'OptimizerDeclaration']);
    for (const field of node.body) {
      if (!blocks.has(field.type)) this.checkStatement(field, modelEnv, { returns: [], declaredReturn: ANY });
    }
    const fields = new Map();
    for (const field of node.body) {
      if (field.type === 'Assign') fields.set(field.name, modelEnv.lookup(field.name) ?? ANY);
    }
    this.modelFields.set(node.name, fields);
    for (const block of node.body) {
      if (block.type === 'ForwardDeclaration') this.checkModelBlock(block, modelEnv, node.name, false);
      else if (block.type === 'TrainDeclaration' || block.type === 'ValidateDeclaration') this.checkModelBlock(block, modelEnv, node.name, true);
      else if (block.type === 'OptimizerDeclaration') this.checkBlock(block.body, this.stepEnv(modelEnv, node.name), { returns: [], declaredReturn: ANY });
    }
    if (forward) this.modelEffects.set(node.name, forward.async ? ASYNC : SYNC);
    node.effect = SYNC;
    node.async = false;
  }

  stepEnv(modelEnv, modelName) {
    const env = new TypeEnv(modelEnv);
    env.define(modelName, moduleType(modelName));
    return env;
  }

  checkModelBlock(block, modelEnv, modelName, isStep) {
    const paramTypes = this.resolveParams(block.params, block.paramTypes, `'${modelName}'`, block, modelEnv);
    const env = this.stepEnv(modelEnv, modelName);
    block.params.forEach((name, index) => env.define(name, paramTypes[index]));
    if (isStep) env.define('log', functionType([STRING, ANY], NONE, true, 1, null, SYNC, true));
    const declaredReturn = block.returnType ? this.resolveTypeNode(block.returnType) : ANY;
    const ctx = { returns: [], declaredReturn };
    block.effect = this.checkBlock(block.body, env, ctx);
    block.async = block.body.some(statement => statement.async === true);
    if (block.returnType) {
      this.checkReturnTypes(ctx.returns, declaredReturn);
      this.checkAllPathsReturn(block.body, declaredReturn, block, `'${modelName}'`);
    }
  }
}

export function typecheck(program, builtinEnv) {
  return new TypeChecker(builtinEnv).run(program);
}

export function typecheckWithTypes(program, builtinEnv) {
  const checker = new TypeChecker(builtinEnv);
  const diagnostics = checker.run(program);
  return { diagnostics, types: checker.inferred };
}
