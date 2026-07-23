import { NodeType, type ASTNode } from "../ast/index.js";
import { lookup, type BoundProgram, type Scope } from "./binder.js";
import { diagnostic, type Diagnostic } from "./diagnostics.js";
import { functionSignatureForType, inferExpression, instantiateForCall, narrowScope, objectLiteralShape } from "./infer.js";
import type { SemanticNode } from "./semantic-ast.js";
import { cleanType, compatible, instantiateShapeForType, parseFunctionType, type Signature } from "./type-system.js";

export type SymbolType = {
  name: string;
  line: number;
  column: number;
  type: string;
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
        for (const stmt of node.body) this.checkNode(stmt, child);
        break;
      }
      case "Block": {
        const child = narrowScope(node.test, this.bound, this.bound.scopes.get(node)?.parent ?? scope);
        for (const stmt of node.body) this.checkNode(stmt, child);
        break;
      }
      case "Var":
        this.checkVar(node, scope);
        break;
      case "Return":
        this.checkReturn(node, scope);
        break;
      case "Expr":
        this.checkExpression(node.value, scope, node.span.line, node.span.column);
        break;
    }
  }

  checkVar(node: Extract<SemanticNode, { kind: "Var" }>, scope: Scope): void {
    const declared = cleanType(node.declaredType);
    const expected = declared !== "any" ? functionSignatureForType(node.name, declared) : null;
    const actual = inferExpression(node.value, this.bound, scope, expected);
    if (node.declaredType) {
      this.checkShape(declared, node.value, node.span.line, node.span.column);
      if (expected && !compatible(actual, declared, this.bound.env)) {
        this.add(node.span.line, node.span.column, `Type '${actual}' is not assignable to '${declared}'`);
      }
      if (!expected && !compatible(actual, declared, this.bound.env)) {
        this.add(node.span.line, node.span.column, `Type '${actual}' is not assignable to '${declared}'`);
      }
    }
    const stored = node.declaredType ? declared : actual;
    scope.locals.set(node.name, { type: stored, optional: false });
    this.onDeclare?.({ name: node.name, line: node.span.line, column: node.span.column, type: stored });
    const callable = functionSignatureForType(node.name, stored);
    if (callable) this.bound.signatures.set(node.name, callable);
    this.checkExpression(node.value, scope, node.span.line, node.span.column);
  }

  checkReturn(node: Extract<SemanticNode, { kind: "Return" }>, scope: Scope): void {
    const sig = this.currentSignature(scope);
    if (!sig || sig.returns === "any") return;
    const actual = inferExpression(node.value, this.bound, scope);
    if (!compatible(actual, sig.returns, this.bound.env)) {
      this.add(node.span.line, node.span.column, `Type '${actual}' is not assignable to return type '${sig.returns}'`);
    }
  }

  checkExpression(node: ASTNode, scope: Scope, line: number, column: number): void {
    if (node.type === NodeType.CallExpression || node.type === NodeType.OptionalCallExpression) {
      this.checkCall(node, scope, line, column);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && "type" in item) this.checkExpression(item as ASTNode, scope, line, column);
        }
      } else if (value && typeof value === "object" && "type" in value) {
        this.checkExpression(value as ASTNode, scope, line, column);
      }
    }
  }

  checkCall(node: ASTNode, scope: Scope, line: number, column: number): void {
    const name = this.callName(node.callee as ASTNode);
    if (!name) return;
    const sig = this.bound.signatures.get(name);
    if (!sig) return;
    const instantiated = instantiateForCall(sig, node.args as ASTNode[], this.bound, scope);
    const seen = new Set<string>();
    let positional = 0;
    for (const arg of node.args as ASTNode[]) {
      if (arg.type === NodeType.NamedArgument) {
        const argName = String(arg.name);
        if (seen.has(argName)) this.add(line, column, `Argument '${argName}' was passed more than once`);
        seen.add(argName);
        const param = instantiated.params.get(argName);
        if (!param && instantiated.params.size > 0 && !instantiated.allowUnknownNamed) this.add(line, column, `Unknown named argument '${argName}' for ${instantiated.name}()`);
        if (param) {
          const actual = inferExpression(arg.value as ASTNode, this.bound, scope);
          if (!compatible(actual, param.type, this.bound.env)) this.add(line, column, `Type '${actual}' is not assignable to parameter '${argName}: ${param.type}'`);
        }
      } else {
        const argName = instantiated.positional[positional++];
        if (!argName) continue;
        seen.add(argName);
        const param = instantiated.params.get(argName);
        if (!param) continue;
        const actual = inferExpression(arg, this.bound, scope);
        if (!compatible(actual, param.type, this.bound.env)) this.add(line, column, `Type '${actual}' is not assignable to parameter '${argName}: ${param.type}'`);
      }
    }
    for (const required of instantiated.required) {
      if (!seen.has(required)) this.add(line, column, `Missing required argument '${required}' for ${instantiated.name}()`);
    }
  }

  checkShape(declared: string, value: ASTNode, line: number, column: number): void {
    const shape = instantiateShapeForType(declared, this.bound.env);
    if (!shape || value.type !== NodeType.ObjectExpression) return;
    const actual = objectLiteralShape(value, this.bound, this.bound.root);
    for (const [name, field] of shape.fields) {
      const actualField = actual.fields.get(name);
      if (!actualField) {
        if (!field.optional) this.add(line, column, `Missing required field '${name}' for '${declared}'`);
        continue;
      }
      if (!compatible(actualField.type, field.type, this.bound.env)) {
        this.add(line, column, `Type '${actualField.type}' is not assignable to field '${name}: ${field.type}'`);
      }
    }
  }

  currentSignature(scope: Scope): Signature | undefined {
    let current: Scope | null = scope;
    while (current) {
      if (current.signature) return current.signature;
      current = current.parent;
    }
    return undefined;
  }

  callName(callee: ASTNode): string | null {
    if (callee.type === NodeType.Identifier) return String(callee.name);
    if (callee.type === NodeType.MemberExpression) {
      const object = this.callName(callee.object as ASTNode);
      if (!object) return null;
      const property = typeof callee.property === "string" ? callee.property : String((callee.property as ASTNode).name ?? "");
      return `${object}.${property}`;
    }
    return null;
  }

  add(line: number, column: number, message: string): void {
    this.diagnostics.push(diagnostic(line, column, message, this.strict));
  }
}
