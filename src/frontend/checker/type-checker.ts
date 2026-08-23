import { adoptContextualSignature, astChildren, NodeType, type ASTNode, type ObjectPropertyNode } from "../ast/index.js";
import {
  lookup,
  lookupSignature,
  lookupWithinBoundary,
  type BoundProgram,
  type Scope,
} from "./binder.js";
import { diagnostic, type Diagnostic } from "./diagnostics.js";
import { callSignatureForCallee, comprehensionArrayType, comprehensionElementType, comprehensionOf, declaredMemberType, functionSignatureForType, inferExpression, instantiateForCall, literalIndexKey, narrowScope, objectLiteralFields, typeArgsOf, writesUnknownKey } from "./infer.js";
import { acceptsTensorLeftArithmetic, acceptsTensorRightArithmetic, binaryOperatorSemantics, isTensorType } from "./operator-types.js";
import type { ClassMemberNode, SemanticNode } from "./semantic-ast.js";
import { arrayElementType, awaitedType, cleanType, compatible, indexKeyAssignable, indexedAccessType, indexKeyType, instantiateShapeForType, isIndexableType, isTupleType, iterableBindingType, leastUpperBound, promiseType, removeNullish, resolveType, tupleTypes, unionParts, unionType, type ObjectShape, type Signature, type TypeEnv, type TypeName } from "./type-system.js";
import { restParameterType } from "../type-source.js";
import { isUnwrittenType } from "../../core/type-text.js";
import { DEFAULT_CLASS_VISIBILITY, type ClassVisibility } from "../../core/class-visibility.js";
import { CLASS_DATA_MEMBER } from "../../core/class-member.js";

export type SymbolType = {
  name: string;
  line: number;
  column: number;
  type: string;
  kind?: "variable" | "parameter";
  scopeStartLine?: number;
  scopeStartColumn?: number;
};

export class TypeChecker {
  bound: BoundProgram;
  diagnostics: Diagnostic[] = [];
  strict: boolean;
  onDeclare?: (symbol: SymbolType) => void;

  constructor(bound: BoundProgram, strict: boolean, onDeclare?: (symbol: SymbolType) => void) {
    this.bound = bound;
    this.strict = strict;
    this.onDeclare = onDeclare;
  }

  check(): Diagnostic[] {
    for (const node of this.bound.program.body) this.checkNode(node, this.bound.root);
    return this.diagnostics;
  }

  checkNode(node: SemanticNode, scope: Scope): void {
    switch (node.kind) {
      case "Function":
      case "Model": {
        const child = this.bound.scopes.get(node) ?? scope;
        if (node.kind === "Model") this.registerModelShape(node, child);
        for (const stmt of node.body) this.checkNode(stmt, child);
        if (node.kind === "Function") this.inferReturnType(node.body, child);
        break;
      }
      case "Class": {
        const child = this.bound.scopes.get(node) ?? scope;
        this.registerClassShape(node, child);
        for (const field of node.fields) this.checkClassField(field, child);
        for (const member of node.members) {
          this.requireMemberVisibility(member);
          if (!member.abstract) this.checkNode(member.fn, child);
        }
        break;
      }
      case "Interface":
        this.emitMembers(node.name, this.bound.env.interfaces.get(node.name), node.span);
        break;
      case "Block": {
        const child = narrowScope(node.test, this.bound, scope, this.bound.scopes.get(node));
        if (node.catchVariable) {
          const at = node.catchVariableSpan ?? node.span;
          this.onDeclare?.({ name: node.catchVariable, line: at.line, column: at.column, type: "any", kind: "parameter" });
        }
        if (node.test) {
          this.checkBlockTest(node, scope);
          this.checkExpression(node.test, scope, node.span.line, node.span.column);
        }
        for (const stmt of node.body) this.checkNode(stmt, child);
        break;
      }
      case "For": {
        this.checkFor(node, scope);
        break;
      }
      case "Var":
        this.checkVar(node, scope);
        break;
      case "Destructure":
        this.checkDestructure(node, scope);
        break;
      case "Return":
        this.checkReturn(node, scope);
        break;
      case "Expr":
        this.checkExpression(node.value, scope, node.span.line, node.span.column);
        break;
    }
  }

  checkFor(node: Extract<SemanticNode, { kind: "For" }>, scope: Scope): void {
    const child = this.bound.scopes.get(node) ?? scope;
    const iterableType = inferExpression(node.iterable, this.bound, scope);
    const variableType = iterableBindingType(iterableType, node.mode, this.bound.env);
    child.locals.set(node.variable, { type: variableType, optional: false });
    this.onDeclare?.({ name: node.variable, line: node.variableSpan.line, column: node.variableSpan.column, type: variableType });
    this.checkForIterable(node, iterableType);
    this.checkExpression(node.iterable, scope, node.span.line, node.span.column);
    for (const stmt of node.body) this.checkNode(stmt, child);
  }

  registerModelShape(node: Extract<SemanticNode, { kind: "Model" }>, scope: Scope): void {
    const fields = new Map<string, { type: TypeName; optional: boolean }>();
    const fieldScope: Scope = { parent: scope, locals: new Map(scope.locals), signatures: new Map(scope.signatures), signature: scope.signature };
    for (const stmt of node.body) {
      if (stmt.kind !== "Var") continue;
      const type = inferExpression(stmt.value, this.bound, fieldScope);
      fields.set(stmt.name, { type, optional: false });
      fieldScope.locals.set(stmt.name, { type, optional: false });
    }
    if (!fields.size) return;
    const current = this.bound.env.interfaces.get(node.name);
    const shape: ObjectShape = { typeParams: current?.typeParams, fields: new Map(current?.fields) };
    for (const [name, binding] of fields) shape.fields.set(name, binding);
    this.bound.env.interfaces.set(node.name, shape);
  }

  registerClassShape(node: Extract<SemanticNode, { kind: "Class" }>, classScope: Scope): void {
    if (node.abstract) this.bound.env.abstractClasses.add(node.name);
    const shape: ObjectShape = { fields: new Map() };
    const staticShape: ObjectShape = { fields: new Map() };
    const staticType = `typeof ${node.name}`;
    if (node.parent) {
      const parentShape = instantiateShapeForType(node.parent, this.bound.env);
      if (parentShape) for (const [name, binding] of parentShape.fields) shape.fields.set(name, binding);
      const parentStatic = this.bound.env.interfaces.get(`typeof ${node.parent}`);
      if (parentStatic) for (const [name, binding] of parentStatic.fields) staticShape.fields.set(name, binding);
    }
    this.bound.env.interfaces.set(node.name, shape);
    this.bound.env.interfaces.set(staticType, staticShape);
    for (const field of node.fields) {
      const fieldScope = this.bound.scopes.get(node) ?? classScope;
      const type = field.declaredType ? cleanType(field.declaredType) : field.value ? inferExpression(field.value, this.bound, fieldScope) : "undefined";
      const binding = { type, optional: false, visibility: field.visibility, owner: node.name, abstract: false, member: CLASS_DATA_MEMBER };
      (field.static ? staticShape : shape).fields.set(field.name, binding);
    }
    const constructorFirst = (member: ClassMemberNode): number => (member.memberKind === "constructor" ? 0 : 1);
    const ordered = [...node.members].sort((left, right) => constructorFirst(left) - constructorFirst(right));
    for (const member of ordered) {
      if (member.static) continue;
      if (member.abstract) continue;
      const memberScope = this.bound.scopes.get(member.fn) ?? classScope;
      this.collectThisFields(member.fn.body, memberScope, shape, node.name);
    }
    for (const member of node.members) {
      if (member.memberKind !== "method" && member.memberKind !== "getter") continue;
      const memberScope = this.bound.scopes.get(member.fn) ?? classScope;
      const returns = this.memberReturnType(member.fn, memberScope);
      if (member.fn.returns === "any" && memberScope.signature) memberScope.signature.returns = returns;
      const type = member.memberKind === "getter" ? returns : classMethodType(member.fn, returns);
      (member.static ? staticShape : shape).fields.set(member.fn.name, {
        type,
        optional: false,
        visibility: member.visibility ?? DEFAULT_CLASS_VISIBILITY,
        owner: node.name,
        abstract: member.abstract,
        member: member.memberKind === "getter" ? "getter" : "method",
      });
    }
    this.emitMembers(node.name, shape, node.span);
    this.emitMembers(staticType, staticShape, node.span);
    this.checkAbstractMembers(node, shape);
    this.checkImplements(node, shape);
  }

  checkAbstractMembers(node: Extract<SemanticNode, { kind: "Class" }>, shape: ObjectShape): void {
    const ownAbstract = new Set<string>();
    for (const member of node.members) {
      if (!member.abstract) continue;
      ownAbstract.add(member.fn.name);
      if (member.visibility === "private") {
        this.add(member.fn.nameSpan.line, member.fn.nameSpan.column, `Abstract member '${member.fn.name}' cannot be private`);
      }
      if (member.memberKind === "constructor") {
        this.add(member.fn.nameSpan.line, member.fn.nameSpan.column, "Constructors cannot be abstract");
      }
      if (member.static) {
        this.add(member.fn.nameSpan.line, member.fn.nameSpan.column, `Static member '${member.fn.name}' cannot be abstract`);
      }
    }
    if (node.abstract) return;
    for (const [name, binding] of shape.fields) {
      if (!binding.abstract) continue;
      if (ownAbstract.has(name)) {
        this.add(node.nameSpan.line, node.nameSpan.column, `Class '${node.name}' must be abstract because it declares abstract member '${name}'`);
      } else {
        this.add(node.nameSpan.line, node.nameSpan.column, `Class '${node.name}' must implement abstract member '${name}' inherited from '${binding.owner ?? node.name}'`);
      }
    }
  }

  checkImplements(node: Extract<SemanticNode, { kind: "Class" }>, shape: ObjectShape): void {
    for (const interfaceName of node.implements) {
      const contract = instantiateShapeForType(interfaceName, this.bound.env);
      if (!contract) {
        this.add(node.nameSpan.line, node.nameSpan.column, `Cannot find interface '${interfaceName}' implemented by '${node.name}'`);
        continue;
      }
      for (const [fieldName, required] of contract.fields) {
        if (required.optional) continue;
        const own = shape.fields.get(fieldName);
        if (!own || own.visibility && own.visibility !== "public") {
          this.add(node.nameSpan.line, node.nameSpan.column, `Class '${node.name}' is missing '${fieldName}' required by interface '${interfaceName}'`);
          continue;
        }
        if (!compatible(own.type, required.type, this.bound.env)) {
          this.add(node.nameSpan.line, node.nameSpan.column, `Property '${fieldName}: ${own.type}' in '${node.name}' is not assignable to '${fieldName}: ${required.type}' required by interface '${interfaceName}'`);
        }
      }
    }
  }

  requireMemberVisibility(member: ClassMemberNode): void {
    if (member.explicitVisibility) return;
    const label = member.memberKind === "constructor" ? "Constructor"
      : member.memberKind === "getter" ? "Getter"
      : member.memberKind === "setter" ? "Setter"
      : "Method";
    const subject = member.memberKind === "constructor" ? label : `${label} '${member.fn.name}'`;
    this.add(member.fn.nameSpan.line, member.fn.nameSpan.column, `${subject} must declare a visibility modifier ('public', 'private', or 'protected')`);
  }

  checkClassField(field: Extract<SemanticNode, { kind: "Class" }>["fields"][number], scope: Scope): void {
    if (!field.explicitVisibility) {
      this.add(field.nameSpan.line, field.nameSpan.column, `Field '${field.name}' must declare a visibility modifier ('public', 'private', or 'protected')`);
    }
    if (!field.value) return;
    if (field.declaredType) this.checkAssignableValue(field.value, cleanType(field.declaredType), scope, field.span.line, field.span.column, `'${field.name}: ${cleanType(field.declaredType)}'`);
    else this.checkExpression(field.value, scope, field.span.line, field.span.column);
  }

  emitMembers(typeName: string, shape: ObjectShape | null | undefined, span: { line: number; column: number }): void {
    if (!this.onDeclare || !shape) return;
    for (const [name, binding] of shape.fields) {
      this.onDeclare({ name: `${typeName}.${name}`, line: span.line, column: span.column, type: binding.type });
    }
  }

  checkComprehension(comp: ReturnType<typeof comprehensionOf> & object, scope: Scope, line: number, column: number): void {
    this.checkExpression(comp.iterable, scope, line, column);
    const elementType = comprehensionElementType(comp, this.bound, scope);
    const loopScope: Scope = { parent: scope, locals: new Map(), signatures: new Map(), signature: scope.signature };
    loopScope.locals.set(comp.variable, { type: elementType, optional: false, declared: true });
    const at = nodePosition(comp.variableNode, line, column);
    const start = comp.projection ? nodePosition(comp.projection, line, column) : at;
    this.onDeclare?.({
      name: comp.variable,
      line: at.line,
      column: at.column,
      type: elementType,
      scopeStartLine: start.line,
      scopeStartColumn: start.column,
    });
    if (comp.projection) this.checkExpression(comp.projection, loopScope, at.line, at.column);
    const listed = comprehensionArrayType(comp, this.bound, scope);
    if (!isUnwrittenType(arrayElementType(listed) ?? "any")) {
      adoptContextualSignature(comp.arrow, [], listed);
    }
  }

  memberReturnType(fn: Extract<SemanticNode, { kind: "Function" }>, scope: Scope): TypeName {
    if (fn.returns !== "any") return cleanType(fn.returns);
    const types: TypeName[] = [];
    this.collectReturnTypes(fn.body, scope, types);
    if (!types.length) return "any";
    const known = types.filter((type) => !this.isUnknownish(type));
    const pool = known.length ? known : types;
    return leastUpperBound(pool, this.bound.env) ?? unionType(pool);
  }

  collectThisFields(statements: SemanticNode[], scope: Scope, shape: ObjectShape, owner: string): void {
    for (const stmt of statements) {
      if (stmt.kind === "Expr") this.recordThisAssignment(stmt.value, scope, shape, owner);
      else if (stmt.kind === "Block" || stmt.kind === "For") this.collectThisFields(stmt.body, scope, shape, owner);
    }
  }

  recordThisAssignment(expr: ASTNode, scope: Scope, shape: ObjectShape, owner: string): void {
    if (expr.type !== NodeType.AssignmentExpression) return;
    const target = expr.target as ASTNode | undefined;
    if (!target || target.type !== NodeType.MemberExpression || target.computed) return;
    if ((target.object as ASTNode)?.type !== NodeType.ThisExpression) return;
    const field = typeof target.property === "string" ? target.property : String((target.property as ASTNode)?.name ?? "");
    if (!field || shape.fields.has(field)) return;
    shape.fields.set(field, { type: inferExpression(expr.value as ASTNode, this.bound, scope), optional: false, member: CLASS_DATA_MEMBER, owner });
  }

  inferReturnType(body: SemanticNode[], scope: Scope): void {
    const sig = scope.signature;
    if (!sig || sig.returns !== "any") return;
    const types: TypeName[] = [];
    this.collectReturnTypes(body, scope, types);
    if (!types.length) return;
    const known = types.filter((type) => !this.isUnknownish(type));
    const pool = known.length ? known : types;
    sig.returns = leastUpperBound(pool, this.bound.env) ?? unionType(pool);
  }

  collectReturnTypes(statements: SemanticNode[], scope: Scope, out: TypeName[]): void {
    for (const stmt of statements) {
      if (stmt.kind === "Return") {
        if (stmt.value) out.push(inferExpression(stmt.value, this.bound, scope));
      } else if (stmt.kind === "Block" || stmt.kind === "For") {
        this.collectReturnTypes(stmt.body, this.bound.scopes.get(stmt) ?? scope, out);
      }
    }
  }

  checkForIterable(node: Extract<SemanticNode, { kind: "For" }>, iterableType: TypeName): void {
    if (this.isUnknownish(iterableType)) return;
    if (node.mode === "in") {
      if (isIndexableType(iterableType, this.bound.env)) return;
      const at = nodePosition(node.iterable, node.span.line, node.span.column);
      this.add(at.line, at.column, `Type '${iterableType}' is not indexable`);
      return;
    }
    if (iterableBindingType(iterableType, "of", this.bound.env) !== "unknown") return;
    const at = nodePosition(node.iterable, node.span.line, node.span.column);
    this.add(at.line, at.column, `Type '${iterableType}' is not iterable`);
  }

  checkVar(node: Extract<SemanticNode, { kind: "Var" }>, scope: Scope): void {
    if (this.reportBuiltinRedeclaration(node.name, node.nameSpan.line, node.nameSpan.column)) {
      this.checkExpression(node.value, scope, node.span.line, node.span.column);
      return;
    }
    const previous = node.declaredType ? null : lookupWithinBoundary(scope, node.name);
    const declared = cleanType(node.declaredType);
    const expectedType = node.declaredType ? declared : previous?.type ?? null;
    const expected = expectedType && expectedType !== "any" ? functionSignatureForType(node.name, expectedType) : null;
    if (node.declaredType && expected) this.bindDeclared(scope, node.name, declared, expected);
    const actual = inferExpression(node.value, this.bound, scope, expected, expectedType);
    const before = this.diagnostics.length;
    if (node.declaredType) {
      const checkedShape = this.checkShape(declared, node.value, scope, node.span.line, node.span.column);
      if (!checkedShape) this.checkExpression(node.value, scope, node.span.line, node.span.column, expected, expectedType);
      if (!checkedShape && !compatible(actual, declared, this.bound.env) && this.diagnostics.length === before) {
        const at = nodePosition(node.value, node.span.line, node.span.column);
        this.add(at.line, at.column, `Type '${actual}' is not assignable to '${declared}'`);
      }
    } else if (previous?.declared) {
      this.checkAssignableValue(node.value, previous.type, scope, node.span.line, node.span.column);
    } else {
      this.checkExpression(node.value, scope, node.span.line, node.span.column, expected, expectedType);
    }
    if (!node.declaredType && previous?.declared && !compatible(actual, previous.type, this.bound.env) && this.diagnostics.length === before) {
      const at = nodePosition(node.value, node.span.line, node.span.column);
      this.add(at.line, at.column, `Type '${actual}' is not assignable to '${previous.type}'`);
    }
    const stored = node.declaredType ? declared : previous?.declared ? previous.type : previous ? this.widenType(previous.type, actual) : actual;
    const owner = previous ? scope : functionScope(scope);
    owner.locals.set(node.name, { type: stored, optional: false, declared: !!node.declaredType || !!previous?.declared });
    this.onDeclare?.({ name: node.name, line: node.nameSpan.line, column: node.nameSpan.column, type: stored });
    const callable = functionSignatureForType(node.name, stored);
    if (callable) owner.signatures.set(node.name, callable);
  }

  private bindDeclared(scope: Scope, name: string, declared: TypeName, callable: Signature): void {
    const owner = functionScope(scope);
    owner.locals.set(name, { type: declared, optional: false, declared: true });
    owner.signatures.set(name, callable);
  }

  checkDestructure(node: Extract<SemanticNode, { kind: "Destructure" }>, scope: Scope): void {
    this.checkExpression(node.value, scope, node.span.line, node.span.column);
    const valueType = inferExpression(node.value, this.bound, scope);
    const itemTypes = this.destructureTypes(valueType, node.names.length);
    for (let i = 0; i < node.names.length; i++) {
      const name = node.names[i];
      const at = node.variableSpans[i] ?? node.span;
      if (this.reportBuiltinRedeclaration(name, at.line, at.column)) continue;
      const previous = lookupWithinBoundary(scope, name);
      const actual = itemTypes[i] ?? "unknown";
      if (previous && !this.isUnknownish(actual) && !compatible(actual, previous.type, this.bound.env)) {
        this.add(at.line, at.column, `Type '${actual}' is not assignable to '${previous.type}'`);
      }
      const stored = previous?.declared ? previous.type : previous ? this.widenType(previous.type, actual) : actual;
      const owner = previous ? scope : functionScope(scope);
      owner.locals.set(name, { type: stored, optional: false, declared: !!previous?.declared });
      this.onDeclare?.({ name, line: at.line, column: at.column, type: stored });
    }
  }

  checkReturn(node: Extract<SemanticNode, { kind: "Return" }>, scope: Scope): void {
    const sig = this.currentSignature(scope);
    if (!sig || sig.returns === "any") return;
    const resolved = sig.async ? awaitedType(sig.returns, this.bound.env) : sig.returns;
    const expectedType = sig.async ? unionType([resolved, promiseType(sig.returns, this.bound.env)]) : sig.returns;
    const expected = functionSignatureForType("<return>", resolved);
    const before = this.diagnostics.length;
    if (node.value) this.checkExpression(node.value, scope, node.span.line, node.span.column, expected, expectedType);
    const actual = inferExpression(node.value, this.bound, scope, expected, expectedType);
    const actualResolved = sig.async ? awaitedType(actual, this.bound.env) : actual;
    if (!compatible(actualResolved, resolved, this.bound.env) && this.diagnostics.length === before) {
      const at = node.value ? nodePosition(node.value, node.span.line, node.span.column) : node.span;
      this.add(at.line, at.column, `Type '${actual}' is not assignable to return type '${sig.returns}'`);
    }
  }

  checkExpression(node: ASTNode, scope: Scope, line: number, column: number, expected?: Signature | null, expectedType?: TypeName | null): void {
    const comprehension = comprehensionOf(node);
    if (comprehension) {
      this.checkComprehension(comprehension, scope, line, column);
      return;
    }
    if (node.type === NodeType.Identifier) {
      this.checkIdentifier(node, scope, line, column);
      return;
    }
    if (node.type === NodeType.ArrowFunctionExpression) {
      this.checkArrow(node, scope, expected ?? null, line, column);
      return;
    }
    if (node.type === NodeType.FunctionExpression) {
      this.checkFunctionExpression(node, scope, line, column);
      return;
    }
    if (node.type === NodeType.CallExpression || node.type === NodeType.OptionalCallExpression || node.type === NodeType.NewExpression) {
      this.checkCall(node, scope, line, column);
      this.checkExpression(node.callee as ASTNode, scope, line, column);
      return;
    }
    if (node.type === NodeType.ObjectExpression) {
      this.checkObjectExpression(node, scope, line, column);
      return;
    }
    if (node.type === NodeType.ConditionalExpression) {
      this.checkConditional(node, scope, line, column, expected, expectedType);
      this.checkExpression(node.test as ASTNode, scope, line, column);
      this.checkExpression(
        node.consequent as ASTNode,
        narrowScope(node.test as ASTNode, this.bound, scope),
        line,
        column,
      );
      this.checkExpression(
        node.alternate as ASTNode,
        narrowScope(node.test as ASTNode, this.bound, scope, undefined, true),
        line,
        column,
      );
      return;
    }
    if (node.type === NodeType.NullishCoalescingExpression) {
      this.checkNullishCoalescing(node, scope, line, column, expected, expectedType);
      this.checkExpression(node.left as ASTNode, scope, line, column);
      this.checkExpression(node.right as ASTNode, scope, line, column);
      return;
    }
    if (node.type === NodeType.SequenceExpression) {
      this.checkSequence(node, scope, line, column, expected, expectedType);
      for (const expr of node.expressions as ASTNode[]) this.checkExpression(expr, scope, line, column);
      return;
    }
    if (
      node.type === NodeType.ArrayExpression &&
      expectedType &&
      this.checkArrayElements(node, scope, line, column, expectedType)
    ) {
      return;
    }
    if (node.type === NodeType.AssignmentExpression) {
      this.checkAssignmentExpression(node, scope, line, column);
      return;
    }
    if (node.type === NodeType.CompoundAssignmentExpression) {
      this.checkCompoundAssignment(node, scope, line, column);
      return;
    }
    if (node.type === NodeType.UpdateExpression) {
      this.checkUpdate(node, scope, line, column);
      return;
    }
    if (node.type === NodeType.BinaryExpression) this.checkBinary(node, scope, line, column);
    if (node.type === NodeType.LogicalExpression) this.checkLogical(node, scope, line, column);
    if (node.type === NodeType.UnaryExpression) this.checkUnary(node, scope, line, column);
    if (node.type === NodeType.MemberExpression && !node.computed) this.checkMemberAccess(node, scope, line, column);
    if ((node.type === NodeType.MemberExpression || node.type === NodeType.OptionalMemberExpression) && node.computed) {
      this.checkComputedMemberAccess(node, scope, line, column);
    }
    if (node.type === NodeType.IndexExpression) this.checkIndexExpression(node, scope, line, column);
    if (node.type === NodeType.SpreadElement) this.checkSpreadElement(node, scope, line, column);
    for (const child of astChildren(node)) this.checkExpression(child, scope, line, column);
  }

  checkIdentifier(node: ASTNode, scope: Scope, line: number, column: number): void {
    const name = String(node.name);
    if (lookup(scope, name) || lookupSignature(scope, name)) return;
    const at = nodePosition(node, line, column);
    this.add(at.line, at.column, `undefined name '${name}'`);
  }

  checkBlockTest(node: Extract<SemanticNode, { kind: "Block" }>, scope: Scope): void {
    const test = node.test as ASTNode;
    const { line, column } = node.span;
    if (node.testRole === "subject") return;
    if (node.testRole !== "label") {
      this.checkCondition(test, scope, line, column);
      return;
    }
    this.checkCaseLabel(test, node.subject, scope, line, column);
  }

  checkCaseLabel(node: ASTNode, subject: ASTNode | undefined, scope: Scope, line: number, column: number): void {
    const subjectType = inferExpression(subject, this.bound, scope);
    const actual = inferExpression(node, this.bound, scope);
    if (this.isUnknownish(subjectType) || this.isUnknownish(actual)) return;
    if (binaryOperatorSemantics("==", subjectType, actual, this.bound.env).valid) return;
    const at = nodePosition(node, line, column);
    this.add(at.line, at.column, `Type '${actual}' is not comparable to switch subject type '${subjectType}'`);
  }

  checkCondition(node: ASTNode, scope: Scope, line: number, column: number): void {
    const actual = inferExpression(node, this.bound, scope);
    if (this.isUnknownish(actual) || compatible(actual, "bool", this.bound.env)) return;
    const at = nodePosition(node, line, column);
    this.add(at.line, at.column, `Type '${actual}' is not assignable to condition type 'bool'`);
  }

  checkObjectExpression(node: ASTNode, scope: Scope, line: number, column: number): void {
    for (const prop of node.properties as ObjectPropertyNode[]) {
      if (prop.spread) {
        const argument = prop.argument;
        if (!argument) continue;
        const actual = inferExpression(argument, this.bound, scope);
        if (!this.isUnknownish(actual) && !compatible(actual, "Object", this.bound.env)) {
          const at = nodePosition(argument, line, column);
          this.add(at.line, at.column, `Type '${actual}' is not assignable to object spread type 'Object'`);
        }
        this.checkExpression(argument, scope, line, column);
        continue;
      }
      if (prop.computed && prop.key && typeof prop.key === "object") this.checkExpression(prop.key, scope, line, column);
      const value = prop.value ?? prop.argument;
      if (value) this.checkExpression(value, scope, line, column);
    }
  }

  checkConditional(node: ASTNode, scope: Scope, line: number, column: number, expected?: Signature | null, expectedType?: TypeName | null): void {
    this.checkCondition(node.test as ASTNode, scope, line, column);
    if (!expectedType || expectedType === "any") return;
    const test = node.test as ASTNode;
    this.checkExpectedExpression(
      node.consequent as ASTNode,
      narrowScope(test, this.bound, scope),
      line,
      column,
      expected,
      expectedType,
    );
    this.checkExpectedExpression(
      node.alternate as ASTNode,
      narrowScope(test, this.bound, scope, undefined, true),
      line,
      column,
      expected,
      expectedType,
    );
  }

  checkNullishCoalescing(node: ASTNode, scope: Scope, line: number, column: number, expected?: Signature | null, expectedType?: TypeName | null): void {
    if (!expectedType || expectedType === "any") return;
    const left = node.left as ASTNode;
    const right = node.right as ASTNode;
    const leftType = removeNullish(inferExpression(left, this.bound, scope), this.bound.env);
    if (!compatible(leftType, expectedType, this.bound.env)) {
      const at = nodePosition(left, line, column);
      this.add(at.line, at.column, `Type '${leftType}' is not assignable to '${expectedType}'`);
    }
    this.checkExpectedExpression(right, scope, line, column, expected, expectedType);
  }

  checkSequence(node: ASTNode, scope: Scope, line: number, column: number, expected?: Signature | null, expectedType?: TypeName | null): void {
    const expressions = node.expressions as ASTNode[];
    const last = expressions.at(-1);
    if (last) this.checkExpectedExpression(last, scope, line, column, expected, expectedType);
  }

  checkExpectedExpression(
    node: ASTNode,
    scope: Scope,
    line: number,
    column: number,
    expected?: Signature | null,
    expectedType?: TypeName | null,
  ): void {
    if (!expectedType || expectedType === "any") return;
    if (node.type === NodeType.ConditionalExpression) {
      this.checkConditional(node, scope, line, column, expected, expectedType);
      return;
    }
    if (node.type === NodeType.NullishCoalescingExpression) {
      this.checkNullishCoalescing(node, scope, line, column, expected, expectedType);
      return;
    }
    if (node.type === NodeType.SequenceExpression) {
      this.checkSequence(node, scope, line, column, expected, expectedType);
      return;
    }
    if (node.type === NodeType.ArrowFunctionExpression && expected) {
      this.checkArrow(node, scope, expected, line, column);
      return;
    }
    if (node.type === NodeType.ArrayExpression && this.checkArrayElements(node, scope, line, column, expectedType)) {
      return;
    }
    const actual = inferExpression(node, this.bound, scope, expected, expectedType);
    if (this.isUnknownish(actual) || compatible(actual, expectedType, this.bound.env)) return;
    const at = nodePosition(node, line, column);
    this.add(at.line, at.column, `Type '${actual}' is not assignable to '${expectedType}'`);
  }

  private checkArrayElements(
    node: ASTNode,
    scope: Scope,
    line: number,
    column: number,
    expectedType: TypeName,
  ): boolean {
    const resolved = resolveType(expectedType, this.bound.env);
    if (isTupleType(resolved)) return false;
    const element = arrayElementType(resolved);
    if (element === null || element === "any") return false;
    const elementSignature = functionSignatureForType("<element>", element);
    for (const item of node.elements as Array<ASTNode | null>) {
      if (!item) continue;
      if (item.type === NodeType.SpreadElement) {
        this.checkExpression(item, scope, line, column);
        continue;
      }
      this.checkExpression(item, scope, line, column, elementSignature, element);
    }
    return true;
  }

  checkArrow(node: ASTNode, scope: Scope, expected: Signature | null, line: number, column: number): void {
    const child: Scope = { parent: scope, locals: new Map(), signatures: new Map(), signature: expected ?? undefined };
    const params = node.params as Array<string | { name?: string }>;
    for (let i = 0; i < params.length; i++) {
      const name = typeof params[i] === "string" ? params[i] as string : String((params[i] as { name?: string }).name ?? `arg${i}`);
      const expectedType = expected?.params.get(expected.positional[i])?.type ?? "any";
      child.locals.set(name, { type: expectedType, optional: false, declared: true });
      const at = nodePosition(node, line, column);
      this.onDeclare?.({ name, line: at.line, column: at.column, type: expectedType, kind: "parameter" });
    }
    if (expected) adoptContextualSignature(node, positionalTypesOf(expected), null);
    const body = node.body as ASTNode | ASTNode[];
    if (Array.isArray(body) || body.type === NodeType.BlockStatement) return;
    const at = nodePosition(body, line, column);
    const returns = expected && expected.returns !== "any" ? expected.returns : null;
    const returned = returns === null ? null : functionSignatureForType("<return>", returns);
    this.checkExpression(body, child, at.line, at.column, returned, returns);
    if (returns === null) return;
    const actual = inferExpression(body, this.bound, child, returned, returns);
    if (!compatible(actual, returns, this.bound.env)) {
      this.add(at.line, at.column, `Type '${actual}' is not assignable to return type '${returns}'`);
      return;
    }
    adoptContextualSignature(node, [], returns);
  }

  checkFunctionExpression(node: ASTNode, scope: Scope, line: number, column: number): void {
    const child: Scope = { parent: scope, locals: new Map(), signatures: new Map(), signature: undefined };
    const params = node.params as Array<string | { name?: string }>;
    for (const param of params) {
      const name = typeof param === "string" ? param : String(param.name ?? "");
      if (name) child.locals.set(name, { type: "any", optional: false, declared: true });
    }
    this.checkFunctionExpressionBody(node.body as ASTNode | ASTNode[], child, line, column);
  }

  checkFunctionExpressionBody(body: ASTNode | ASTNode[], scope: Scope, line: number, column: number): void {
    const statements = Array.isArray(body) ? body : body.type === NodeType.BlockStatement ? body.body as ASTNode[] : [body];
    for (const statement of statements) {
      if (statement.type === NodeType.ExpressionStatement) {
        this.checkExpression(statement.expression as ASTNode, scope, line, column);
      } else if (statement.type === NodeType.ReturnStatement || statement.type === NodeType.ThrowStatement) {
        const argument = statement.argument as ASTNode | undefined;
        if (argument) this.checkExpression(argument, scope, line, column);
      } else if (statement.type === NodeType.BlockStatement) {
        this.checkFunctionExpressionBody(statement, scope, line, column);
      } else if (statement.type === NodeType.IfStatement) {
        this.checkExpression(statement.test as ASTNode, scope, line, column);
        this.checkFunctionExpressionBody(statement.consequent as ASTNode, scope, line, column);
        if (statement.alternate) this.checkFunctionExpressionBody(statement.alternate as ASTNode, scope, line, column);
      } else if (statement.type === NodeType.LetDeclaration || statement.type === NodeType.ConstDeclaration || statement.type === NodeType.VarDeclaration) {
        const init = statement.init as ASTNode | undefined;
        if (init) this.checkExpression(init, scope, line, column);
        const name = typeof statement.name === "string" ? statement.name : "";
        if (name) scope.locals.set(name, { type: init ? inferExpression(init, this.bound, scope) : "unknown", optional: false });
      } else if ("type" in statement) {
        this.checkExpression(statement, scope, line, column);
      }
    }
  }

  checkSpreadElement(node: ASTNode, scope: Scope, line: number, column: number): void {
    const argument = node.argument as ASTNode;
    const actual = inferExpression(argument, this.bound, scope);
    const element = iterableBindingType(actual, "of", this.bound.env);
    if (element !== "unknown" || actual === "any" || actual === "unknown") return;
    const at = nodePosition(argument, line, column);
    this.add(at.line, at.column, `Type '${actual}' is not iterable`);
  }

  checkBinary(node: ASTNode, scope: Scope, line: number, column: number): void {
    const op = String(node.op ?? "");
    const left = inferExpression(node.left as ASTNode, this.bound, scope);
    const right = inferExpression(node.right as ASTNode, this.bound, scope);
    if (this.isUnknownish(left) || this.isUnknownish(right)) return;
    if (op === "in") {
      if (!isIndexableType(right, this.bound.env)) {
        const at = nodePosition(node.right as ASTNode, line, column);
        this.add(at.line, at.column, `Type '${right}' is not indexable`);
        return;
      }
      this.checkIndexBound(right, node.left as ASTNode, scope, line, column);
      return;
    }
    if (!binaryOperatorSemantics(op, left, right, this.bound.env).valid) {
      this.addBinaryDiagnostic(node, scope, line, column, `Operator '${op}' cannot be applied to '${left}' and '${right}'`);
    }
  }

  checkLogical(node: ASTNode, scope: Scope, line: number, column: number): void {
    for (const side of [node.left as ASTNode, node.right as ASTNode]) {
      const actual = inferExpression(side, this.bound, scope);
      if (this.isUnknownish(actual) || compatible(actual, "bool", this.bound.env)) continue;
      const at = nodePosition(side, line, column);
      this.add(at.line, at.column, `Type '${actual}' is not assignable to logical operand type 'bool'`);
    }
  }

  checkUnary(node: ASTNode, scope: Scope, line: number, column: number): void {
    const op = String(node.op ?? "");
    const arg = node.argument as ASTNode;
    const actual = inferExpression(arg, this.bound, scope);
    if (this.isUnknownish(actual) || op === "typeof" || op === "void" || op === "delete") return;
    if (op === "-" && isTensorType(actual, this.bound.env)) return;
    const expected = op === "!" ? "bool" : op === "-" || op === "+" || op === "~" ? "float" : null;
    if (!expected || compatible(actual, expected, this.bound.env)) return;
    const at = nodePosition(arg, line, column);
    this.add(at.line, at.column, `Operator '${op}' cannot be applied to '${actual}'`);
  }

  checkMemberAccess(node: ASTNode, scope: Scope, line: number, column: number): void {
    const object = node.object as ASTNode;
    const objectType = inferExpression(object, this.bound, scope);
    if (this.isUnknownish(objectType)) return;
    const nullable = unionParts(objectType, this.bound.env).some((part) => this.isNullish(part));
    const property = typeof node.property === "string" ? node.property : String((node.property as ASTNode).name ?? "");
    this.checkClassMemberVisibility(objectType, property, scope, node, line, column);
    if (!nullable) return;
    const at = nodePosition(object, line, column);
    this.add(at.line, at.column, `Cannot access member '${property}' on nullable type '${objectType}'`);
  }

  checkClassMemberVisibility(objectType: TypeName, property: string, scope: Scope, node: ASTNode, line: number, column: number): void {
    const caller = currentClassOwner(scope);
    for (const part of unionParts(objectType, this.bound.env)) {
      const shape = instantiateShapeForType(part, this.bound.env);
      const binding = shape?.fields.get(property);
      if (!binding?.visibility || binding.visibility === "public") continue;
      if (classAccessAllowed(binding.visibility, binding.owner ?? ownerFromType(part), caller, part, this.bound.env)) continue;
      const at = typeof node.property === "object" ? nodePosition(node.property as ASTNode, line, column) : nodePosition(node, line, column);
      this.add(at.line, at.column, `Cannot access ${binding.visibility} member '${property}' of '${binding.owner ?? ownerFromType(part)}'`);
      return;
    }
  }

  checkComputedMemberAccess(node: ASTNode, scope: Scope, line: number, column: number): void {
    const objectType = inferExpression(node.object as ASTNode, this.bound, scope);
    if (node.type !== NodeType.OptionalMemberExpression) {
      this.checkIndexedAccess(objectType, node.property as ASTNode, false, scope, line, column);
      return;
    }
    for (const part of unionParts(objectType, this.bound.env)) {
      if (this.isNullish(resolveType(part, this.bound.env))) continue;
      this.checkIndexedAccess(part, node.property as ASTNode, false, scope, line, column);
    }
  }

  checkAssignmentExpression(node: ASTNode, scope: Scope, line: number, column: number): void {
    const target = node.target as ASTNode;
    const value = node.value as ASTNode;
    const expected = declaredTargetType(target, this.bound, scope);
    const actual = inferExpression(value, this.bound, scope);
    this.checkExpression(target, scope, line, column);
    if (this.isUnknownish(expected) || this.widenElementWrite(target, actual, scope)) {
      this.checkExpression(value, scope, line, column);
    } else {
      this.checkAssignmentValue(expected, value, scope, line, column);
    }
    const name = flowName(target);
    if (name && !this.isUnknownish(actual)) {
      const owner = lookupWithinBoundary(scope, name) ? scope : functionScope(scope);
      owner.locals.set(name, { type: actual, optional: false });
    }
  }

  checkCompoundAssignment(node: ASTNode, scope: Scope, line: number, column: number): void {
    const target = node.target as ASTNode;
    const value = node.value as ASTNode;
    const op = String(node.op ?? "");
    const targetType = inferExpression(target, this.bound, scope);
    const valueType = inferExpression(value, this.bound, scope);
    const targetName = target.type === NodeType.Identifier ? String(target.name) : "";
    const binding = targetName ? lookup(scope, targetName) : undefined;
    this.checkExpression(target, scope, line, column);
    this.checkExpression(value, scope, line, column);
    if (this.isUnknownish(targetType) || this.isUnknownish(valueType)) return;
    const result = this.compoundResultType(op, targetType, valueType);
    if (result && this.widenElementWrite(target, result, scope)) return;
    if (!result || (binding?.declared !== false && !compatible(result, targetType, this.bound.env))) {
      const at = nodePosition(value, line, column);
      const produced = result ? `produces '${result}' which is not assignable to '${targetType}'` : `cannot assign '${valueType}' to '${targetType}'`;
      this.add(at.line, at.column, `Operator '${op}=' ${produced}`);
      return;
    }
    if (binding && !binding.declared) {
      scope.locals.set(targetName, { type: this.widenType(binding.type, result), optional: false });
    }
  }

  checkUpdate(node: ASTNode, scope: Scope, line: number, column: number): void {
    const argument = node.argument as ASTNode;
    const actual = inferExpression(argument, this.bound, scope);
    this.checkExpression(argument, scope, line, column);
    if (this.isUnknownish(actual) || compatible(actual, "float", this.bound.env)) return;
    const at = nodePosition(argument, line, column);
    this.add(at.line, at.column, `Operator '${String(node.op ?? "")}' cannot be applied to '${actual}'`);
  }

  checkAssignmentValue(expected: string, value: ASTNode, scope: Scope, line: number, column: number): void {
    if (this.isUnknownish(expected)) return;
    this.checkAssignableValue(value, expected, scope, line, column);
  }

  compoundResultType(op: string, left: string, right: string): string | null {
    const semantics = binaryOperatorSemantics(op, left, right, this.bound.env);
    return semantics.valid ? semantics.result : null;
  }

  isUnknownish(type: string, seen = new Set<string>()): boolean {
    const key = cleanType(type);
    if (seen.has(key)) return false;
    seen.add(key);
    const resolved = resolveType(key, this.bound.env);
    if (resolved === "any" || resolved === "unknown") return true;
    const parts = unionParts(resolved, this.bound.env);
    if (parts.length > 1) return parts.some((part) => this.isUnknownish(part, seen));
    const element = arrayElementType(resolved);
    if (element) return this.isUnknownish(element, seen);
    if (isTupleType(resolved)) return tupleTypes(resolved).some((item) => this.isUnknownish(item, seen));
    return false;
  }

  isNullish(type: string): boolean {
    return type === "null" || type === "undefined";
  }

  addBinaryDiagnostic(node: ASTNode, scope: Scope, line: number, column: number, message: string): void {
    const left = node.left as ASTNode;
    const right = node.right as ASTNode;
    const leftType = inferExpression(left, this.bound, scope);
    const rightType = inferExpression(right, this.bound, scope);
    const target = this.binaryDiagnosticTarget(String(node.op ?? ""), left, right, leftType, rightType);
    const at = nodePosition(target, line, column);
    this.add(at.line, at.column, message);
  }

  binaryDiagnosticTarget(op: string, left: ASTNode, right: ASTNode, leftType: TypeName, rightType: TypeName): ASTNode {
    if (isTensorType(leftType, this.bound.env) && !acceptsTensorLeftArithmetic(op, rightType, this.bound.env)) return right;
    if (isTensorType(rightType, this.bound.env) && !acceptsTensorRightArithmetic(op, leftType, this.bound.env)) return left;
    if (compatible(leftType, "float", this.bound.env) || compatible(leftType, "string", this.bound.env)) return right;
    if (compatible(rightType, "float", this.bound.env) || compatible(rightType, "string", this.bound.env)) return left;
    return left;
  }

  checkIndexExpression(node: ASTNode, scope: Scope, line: number, column: number): void {
    let current = inferExpression(node.object as ASTNode, this.bound, scope);
    for (const dim of node.dims as ASTNode[]) {
      const slice = dim.kind === "slice";
      if (slice) {
        for (const bound of [dim.start, dim.stop, dim.step] as Array<ASTNode | null | undefined>) {
          if (bound) this.checkIndexBound(current, bound, scope, line, column);
        }
        this.checkIndexable(current, dim, line, column);
        current = indexedAccessType(current, null, null, true, this.bound.env);
        continue;
      }
      const value = dim.value as ASTNode;
      this.checkIndexedAccess(current, value, false, scope, line, column);
      current = indexedAccessType(current, inferExpression(value, this.bound, scope), literalIndexKey(value), false, this.bound.env);
    }
  }

  checkIndexedAccess(containerType: string, key: ASTNode, slice: boolean, scope: Scope, line: number, column: number): void {
    this.checkIndexable(containerType, key, line, column);
    this.checkIndexBound(containerType, key, scope, line, column);
  }

  checkIndexable(containerType: string, node: ASTNode, line: number, column: number): void {
    if (isIndexableType(containerType, this.bound.env)) return;
    const at = nodePosition(node, line, column);
    this.add(at.line, at.column, `Type '${containerType}' is not indexable`);
  }

  checkIndexBound(containerType: string, node: ASTNode, scope: Scope, line: number, column: number): void {
    const actual = inferExpression(node, this.bound, scope);
    if (indexKeyAssignable(containerType, actual, this.bound.env)) return;
    const at = nodePosition(node, line, column);
    this.add(at.line, at.column, `Type '${actual}' is not assignable to index type '${indexKeyType(containerType, this.bound.env)}'`);
  }

  checkCall(node: ASTNode, scope: Scope, line: number, column: number): void {
    const sig = callSignatureForCallee(node.callee as ASTNode, this.bound, scope);
    if (!sig) return;
    if (isClassConstructorSignature(sig) && sig.abstract) {
      const at = nodePosition(node.callee as ASTNode, line, column);
      this.add(at.line, at.column, `Cannot instantiate abstract class '${sig.owner ?? sig.name}'`);
    }
    if (isClassConstructorSignature(sig) && sig.visibility && sig.visibility !== "public" && !classConstructorAccessAllowed(sig.visibility, sig.owner ?? sig.name, currentClassOwner(scope), this.bound.env)) {
      const at = nodePosition(node.callee as ASTNode, line, column);
      this.add(at.line, at.column, `Cannot access ${sig.visibility} constructor '${sig.owner ?? sig.name}'`);
    }
    const instantiated = instantiateForCall(sig, node.args as ASTNode[], this.bound, scope, typeArgsOf(node.callee as ASTNode));
    const seen = new Set<string>();
    let positional = 0;
    let spread = false;
    for (const arg of node.args as ASTNode[]) {
      if (arg.type === NodeType.NamedArgument) {
        const argName = String(arg.name);
        if (seen.has(argName)) {
          const at = nodePosition(arg, line, column);
          this.add(at.line, at.column, `Argument '${argName}' was passed more than once`);
        }
        seen.add(argName);
        const param = instantiated.params.get(argName);
        if (!param && !instantiated.rest?.named) {
          const at = nodePosition(arg, line, column);
          this.add(at.line, at.column, `Unknown named argument '${argName}' for ${instantiated.name}()`);
        }
        if (!param && instantiated.rest?.named) {
          const restType = this.restArgumentType(instantiated.rest);
          this.checkAssignableValue(arg.value as ASTNode, restType, scope, line, column, `rest parameter '${instantiated.rest.name}: ${instantiated.rest.type}'`);
        }
        if (param) {
          this.checkAssignableValue(arg.value as ASTNode, param.type, scope, line, column, `parameter '${argName}: ${param.type}'`, argName);
        }
      } else if (arg.type === NodeType.SpreadElement) {
        this.checkSpreadArgument(arg, instantiated, positional, seen, scope, line, column);
        positional = instantiated.positional.length;
        spread = true;
      } else {
        const argName = instantiated.positional[positional++];
        const param = argName ? instantiated.params.get(argName) : undefined;
        if (!argName || !param) {
          if (!instantiated.rest || instantiated.rest.named) {
            if (spread) continue;
            const at = nodePosition(arg, line, column);
            this.add(at.line, at.column, `Too many positional arguments for ${instantiated.name}()`);
          } else {
            this.checkAssignableValue(arg, instantiated.rest.type, scope, line, column, `rest parameter '${instantiated.rest.name}: ${instantiated.rest.type}'`);
          }
          continue;
        }
        seen.add(argName);
        this.checkAssignableValue(arg, param.type, scope, line, column, `parameter '${argName}: ${param.type}'`, argName);
      }
    }
    for (const required of instantiated.required) {
      if (!seen.has(required)) {
        const at = callDiagnosticPosition(node, line, column);
        this.add(at.line, at.column, `Missing required argument '${required}' for ${instantiated.name}()`);
      }
    }
  }

  private checkSpreadArgument(
    arg: ASTNode,
    instantiated: Signature,
    positional: number,
    seen: Set<string>,
    scope: Scope,
    line: number,
    column: number,
  ): void {
    this.checkExpression(arg, scope, line, column);
    const spreadType = inferExpression(arg.argument as ASTNode, this.bound, scope);
    const element = iterableBindingType(spreadType, "of", this.bound.env);
    const at = nodePosition(arg, line, column);
    for (const name of instantiated.positional.slice(positional)) {
      seen.add(name);
      const param = instantiated.params.get(name);
      if (!param || this.isUnknownish(element)) continue;
      if (compatible(element, param.type, this.bound.env)) continue;
      this.add(at.line, at.column, `Type '${element}' is not assignable to parameter '${name}: ${param.type}'`);
    }
  }

  checkShape(declared: string, value: ASTNode, scope: Scope, line: number, column: number): boolean {
    const shape = instantiateShapeForType(declared, this.bound.env);
    if (!shape || value.type !== NodeType.ObjectExpression) return false;
    this.checkObjectExpression(value, scope, line, column);
    const actual = objectLiteralFields(value, this.bound, scope);
    for (const [name, field] of shape.fields) {
      const actualField = actual.get(name);
      if (!actualField) {
        if (!field.optional) this.add(line, column, `Missing required field '${name}' for '${declared}'`);
        continue;
      }
      const actualType = actualField.type;
      const before = this.diagnostics.length;
      if (this.isContextualExpression(actualField.value)) {
        this.checkExpectedExpression(actualField.value, scope, line, column, functionSignatureForType(name, field.type), field.type);
      }
      if (!compatible(actualType, field.type, this.bound.env) && this.diagnostics.length === before) {
        const at = nodePosition(actualField.value, line, column);
        this.add(at.line, at.column, `Type '${actualType}' is not assignable to field '${name}: ${field.type}'`);
      }
    }
    return true;
  }

  currentSignature(scope: Scope): Signature | undefined {
    let current: Scope | null = scope;
    while (current) {
      if (current.signature) return current.signature;
      current = current.parent;
    }
    return undefined;
  }

  add(line: number, column: number, message: string): void {
    this.diagnostics.push(diagnostic(line, column, message, this.strict));
  }

  reportBuiltinRedeclaration(name: string, line: number, column: number): boolean {
    if (!this.bound.reserved.has(name)) return false;
    this.add(line, column, `Cannot redeclare built-in '${name}'`);
    return true;
  }

  isContextualExpression(node: ASTNode): boolean {
    return node.type === NodeType.ArrowFunctionExpression ||
      node.type === NodeType.ConditionalExpression ||
      node.type === NodeType.NullishCoalescingExpression ||
      node.type === NodeType.SequenceExpression;
  }

  checkAssignableValue(
    value: ASTNode,
    expectedType: TypeName,
    scope: Scope,
    line: number,
    column: number,
    target?: string,
    signatureName?: string,
  ): void {
    const expectedSig = functionSignatureForType(signatureName ?? "<assignment>", expectedType);
    const before = this.diagnostics.length;
    this.checkExpression(value, scope, line, column, expectedSig, expectedType);
    const actual = inferExpression(value, this.bound, scope, expectedSig, expectedType);
    if (this.isUnknownish(actual) || compatible(actual, expectedType, this.bound.env) || this.diagnostics.length !== before) return;
    if (this.checkUnionShape(expectedType, value, scope, line, column)) return;
    const at = nodePosition(value, line, column);
    this.add(at.line, at.column, `Type '${actual}' is not assignable to ${target ?? `'${expectedType}'`}`);
  }

  checkUnionShape(expectedType: TypeName, value: ASTNode, scope: Scope, line: number, column: number): boolean {
    if (value.type !== NodeType.ObjectExpression) return false;
    const actual = objectLiteralFields(value, this.bound, scope);
    const candidates = unionParts(expectedType, this.bound.env)
      .filter((part) => instantiateShapeForType(part, this.bound.env))
      .sort((left, right) => this.shapeScore(right, actual) - this.shapeScore(left, actual));
    const candidate = candidates[0];
    if (!candidate) return false;
    const before = this.diagnostics.length;
    this.checkShape(candidate, value, scope, line, column);
    return this.diagnostics.length !== before;
  }

  shapeScore(type: TypeName, actual: Map<string, { type: TypeName; optional: boolean; value: ASTNode }>): number {
    const shape = instantiateShapeForType(type, this.bound.env);
    if (!shape) return 0;
    let score = 0;
    for (const name of actual.keys()) if (shape.fields.has(name)) score++;
    return score;
  }

  restArgumentType(rest: NonNullable<Signature["rest"]>): TypeName {
    return rest.named && rest.type === "Object" ? "any" : rest.type;
  }

  destructureTypes(type: TypeName, count: number): TypeName[] {
    const resolved = resolveType(type, this.bound.env);
    if (resolved === "any" || resolved === "unknown") return Array(count).fill(resolved);
    const parts = unionParts(type, this.bound.env);
    if (parts.length > 1 || isTupleType(resolved)) {
      return Array.from({ length: count }, (_, index) => indexedAccessType(type, "int", index, false, this.bound.env));
    }
    const element = arrayElementType(resolved);
    if (element) return Array(count).fill(element);
    if (resolved === "Array") return Array(count).fill("any");
    return Array(count).fill("unknown");
  }

  widenType(left: TypeName, right: TypeName): TypeName {
    if (this.isUnknownish(left)) return right;
    if (this.isUnknownish(right)) return left;
    return leastUpperBound([left, right], this.bound.env) ?? unionType([left, right]);
  }

  widenElementWrite(target: ASTNode, actual: TypeName, scope: Scope): boolean {
    const write = elementWriteTarget(target);
    if (!write || this.isUnknownish(actual)) return false;
    const binding = lookup(scope, write.name);
    if (!binding || binding.declared) return false;
    const widened = this.widenElementAt(binding.type, write.depth, actual);
    if (!widened) return false;
    scope.locals.set(write.name, { ...binding, type: widened });
    return true;
  }

  widenElementAt(container: TypeName, depth: number, actual: TypeName): TypeName | null {
    const element = arrayElementType(container);
    if (!element) return null;
    const widened = depth > 1 ? this.widenElementAt(element, depth - 1, actual) : this.widenedElement(element, actual);
    return widened ? `${widened}[]` : null;
  }

  widenedElement(element: TypeName, actual: TypeName): TypeName | null {
    if (compatible(actual, element, this.bound.env)) return null;
    const widened = leastUpperBound([element, actual], this.bound.env);
    const spellableAsElement = widened !== null && unionParts(widened, this.bound.env).length === 1;
    return spellableAsElement ? widened : null;
  }
}

function classMethodType(fn: Extract<SemanticNode, { kind: "Function" }>, returns: TypeName): TypeName {
  const params = fn.params
    .map((param) =>
      param.rest
        ? restParameterType(param.name, param.type)
        : `${param.name}${param.optional ? "?" : ""}: ${param.type}`,
    )
    .join(", ");
  return cleanType(`(${params}) -> ${returns}`);
}

function positionalTypesOf(signature: Signature): string[] {
  return signature.positional.map((name) => signature.params.get(name)?.type ?? "any");
}

function nodePosition(node: ASTNode, fallbackLine: number, fallbackColumn: number): { line: number; column: number } {
  const positioned = node as ASTNode & { __line?: number; __column?: number };
  return {
    line: positioned.__line ?? fallbackLine,
    column: positioned.__column ?? fallbackColumn,
  };
}

function callDiagnosticPosition(node: ASTNode, fallbackLine: number, fallbackColumn: number): { line: number; column: number } {
  const callee = node.callee as ASTNode | undefined;
  if (callee?.type === NodeType.MemberExpression || callee?.type === NodeType.OptionalMemberExpression) {
    const positioned = callee as ASTNode & { __propertyLine?: number; __propertyColumn?: number };
    const fallback = nodePosition(callee, fallbackLine, fallbackColumn);
    return {
      line: positioned.__propertyLine ?? fallback.line,
      column: positioned.__propertyColumn ?? fallback.column,
    };
  }
  return callee ? nodePosition(callee, fallbackLine, fallbackColumn) : nodePosition(node, fallbackLine, fallbackColumn);
}

function elementWriteTarget(node: ASTNode): { name: string; depth: number } | null {
  let current = node;
  let depth = 0;
  while (current.type === NodeType.MemberExpression && current.computed) {
    depth++;
    current = current.object as ASTNode;
  }
  return depth > 0 && current.type === NodeType.Identifier ? { name: String(current.name), depth } : null;
}

function functionScope(scope: Scope): Scope {
  let current = scope;
  while (!current.boundary && current.parent) current = current.parent;
  return current;
}

function declaredTargetType(target: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const member =
    target.type === NodeType.MemberExpression || target.type === NodeType.OptionalMemberExpression;
  if (writesUnknownKey(target, bound, scope)) return "any";
  if (!member) return inferExpression(target, bound, scope);
  return declaredMemberType(target, bound, scope);
}

function flowName(node: ASTNode): string | null {
  if (node.type === NodeType.Identifier) return String(node.name);
  if (node.type !== NodeType.MemberExpression) return null;
  const object = flowName(node.object as ASTNode);
  if (!object) return null;
  const property = typeof node.property === "string" ? node.property : String((node.property as ASTNode).name ?? "");
  return property ? `${object}.${property}` : null;
}

function currentClassOwner(scope: Scope): string | null {
  for (let current: Scope | null = scope; current; current = current.parent) {
    if (current.classOwner) return current.classOwner;
  }
  return null;
}

function classAccessAllowed(
  visibility: ClassVisibility,
  owner: string,
  caller: string | null,
  targetType: TypeName,
  env: TypeEnv,
): boolean {
  if (visibility === "public") return true;
  if (!caller) return false;
  if (visibility === "private") return caller === owner;
  const lineage = classLineage(ownerFromType(targetType), env);
  const ownerIndex = lineage.indexOf(owner);
  const callerIndex = lineage.indexOf(caller);
  return caller === owner || (ownerIndex >= 0 && callerIndex >= 0 && callerIndex <= ownerIndex);
}

function isClassConstructorSignature(sig: Signature): boolean {
  return !!sig.owner && sig.name === sig.owner && sig.returns === sig.owner;
}

function classConstructorAccessAllowed(
  visibility: ClassVisibility,
  owner: string,
  caller: string | null,
  env: TypeEnv,
): boolean {
  if (visibility === "public") return true;
  if (!caller) return false;
  if (visibility === "private") return caller === owner;
  return classLineage(caller, env).includes(owner);
}

function classLineage(type: string, env: TypeEnv): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | null = ownerFromType(type);
  while (current && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = env.nominalFamilies.get(current) ?? null;
  }
  return out;
}

function ownerFromType(type: TypeName): string {
  const cleaned = cleanType(type).replace(/^typeof\s+/, "");
  const generic = cleaned.match(/^([A-Za-z_$][\w$]*)\s*</);
  return generic ? generic[1] : cleaned;
}
