import { NodeType, type ASTNode } from "../ast/index.js";
import { ASYNC_DOMAIN_TYPES, DOMAIN_BUILTIN_METADATA, RESULT_FIELD_TYPES } from "../../runtime/domain/metadata.js";

const RECORD_PREFIX = "@";

type FunctionNode = ASTNode & { name?: string | null; body?: ASTNode | ASTNode[]; async?: boolean };
type CallNode = ASTNode & { callee: ASTNode; args: ASTNode[]; implicitAwait?: boolean };
type Types = Map<string, string>;

type Unit = {
  node: FunctionNode | null;
  calls: CallNode[];
  callees: Set<string>;
  params: string[];
  async: boolean;
  returns: string | null;
};

type Resolution = { units: Unit[]; unknown: boolean };

const UNRESOLVED: Resolution = { units: [], unknown: true };
const NOT_A_CLOSURE: Resolution = { units: [], unknown: false };

const FUNCTION_TYPES = new Set<string>([
  NodeType.FunctionDeclaration,
  NodeType.FunctionExpression,
  NodeType.ArrowFunctionExpression,
]);

const BINDING_TYPES = new Set<string>([
  NodeType.LetDeclaration,
  NodeType.ConstDeclaration,
  NodeType.VarDeclaration,
  NodeType.AssignmentExpression,
]);

function isFunctionNode(node: ASTNode): node is FunctionNode {
  return FUNCTION_TYPES.has(node.type);
}

function children(node: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object" && "type" in item) out.push(item as ASTNode);
    } else if (value && typeof value === "object" && "type" in value) {
      out.push(value as ASTNode);
    }
  }
  return out;
}

function calleeName(callee: ASTNode): string | null {
  return callee.type === NodeType.Identifier ? String(callee.name) : null;
}

function bindingName(node: ASTNode): string | null {
  const target = (node as { name?: unknown; target?: unknown }).name ?? (node as { target?: unknown }).target;
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && (target as ASTNode).type === NodeType.Identifier) return String((target as ASTNode).name);
  return null;
}

function bindingValue(node: ASTNode): ASTNode | null {
  const value = (node as { init?: ASTNode; value?: ASTNode }).init ?? (node as { value?: ASTNode }).value;
  return value && typeof value === "object" && "type" in value ? value : null;
}

function paramNames(node: FunctionNode): string[] {
  const params = (node as { params?: unknown }).params;
  if (!Array.isArray(params)) return [];
  return params.map((param) => {
    if (typeof param === "string") return param;
    const name = (param as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  });
}

class EffectAnalyzer {
  private readonly units: Unit[] = [];
  private readonly byName = new Map<string, Unit[]>();
  private readonly callers = new Map<Unit, Set<Unit>>();
  private readonly seen = new Map<FunctionNode, Unit>();
  private readonly flow = new Map<string, Set<Unit>>();
  private readonly tracked = new Set<string>();
  private readonly opaque = new Set<string>();
  private top: Unit | null = null;
  private changed = false;
  private effects = false;

  analyze(program: ASTNode): void {
    const body = (program as { body?: ASTNode | ASTNode[] }).body ?? program;
    this.iterate(body);
    this.effects = true;
    this.iterate(body);
    this.mark();
  }

  private iterate(body: ASTNode | ASTNode[]): void {
    do {
      this.changed = false;
      this.units.length = 0;
      this.byName.clear();
      this.callers.clear();
      this.walkBody(body, this.unit(null), new Map());
      if (this.effects) this.propagate();
    } while (this.changed);
  }

  private unit(node: FunctionNode | null): Unit {
    const known = node ? this.seen.get(node) : this.top;
    if (known) {
      known.calls.length = 0;
      known.callees.clear();
      this.index(known);
      return known;
    }
    const created: Unit = { node, calls: [], callees: new Set(), params: [], async: false, returns: null };
    if (node) this.seen.set(node, created);
    else this.top = created;
    this.index(created);
    return created;
  }

  private index(unit: Unit): void {
    this.units.push(unit);
    const name = unit.node?.name;
    if (!name) return;
    const bucket = this.byName.get(name);
    if (bucket) bucket.push(unit);
    else this.byName.set(name, [unit]);
  }

  private raise(unit: Unit, field: "async", value: boolean): void {
    if (unit[field] === value) return;
    unit[field] = value;
    this.changed = true;
  }

  private walkBody(body: ASTNode | ASTNode[], unit: Unit, types: Types): void {
    for (const node of Array.isArray(body) ? body : [body]) this.walk(node, unit, types);
  }

  private walk(node: ASTNode, unit: Unit, types: Types): void {
    if (isFunctionNode(node)) {
      const inner = this.unit(node);
      inner.params = paramNames(node);
      for (const param of inner.params) if (param) this.tracked.add(param);
      this.walkBody(node.body ?? [], inner, new Map(types));
      return;
    }

    if (BINDING_TYPES.has(node.type)) {
      const name = bindingName(node);
      const value = bindingValue(node);
      if (name && value) {
        const type = this.domainType(value, types);
        if (type) types.set(name, type);
        else types.delete(name);
        this.bindClosure(name, value);
      }
    }

    if (node.type === NodeType.ReturnStatement) {
      const value = (node as { value?: ASTNode; argument?: ASTNode }).value ?? (node as { argument?: ASTNode }).argument;
      const type = value ? this.domainType(value, types) : null;
      if (type && unit.returns !== type) {
        unit.returns = type;
        this.changed = true;
      }
    }

    if (node.type === NodeType.CallExpression) {
      const call = node as CallNode;
      unit.calls.push(call);
      const name = calleeName(call.callee);
      if (name) unit.callees.add(name);
      this.bindArguments(call);
      if (this.effects && this.isAsyncOrigin(call, types)) {
        call.implicitAwait = true;
        this.raise(unit, "async", true);
      }
    }

    for (const child of children(node)) this.walk(child, unit, types);
  }

  private closuresOf(node: ASTNode): Set<Unit> | null {
    if (isFunctionNode(node)) return new Set([this.unitFor(node)]);
    if (node.type !== NodeType.Identifier) return null;
    const name = String(node.name);
    const declared = this.byName.get(name);
    const flowed = this.flow.get(name);
    if (!declared && !flowed) return null;
    const out = new Set<Unit>(declared ?? []);
    if (flowed) for (const unit of flowed) out.add(unit);
    return out;
  }

  private unitFor(node: FunctionNode): Unit {
    const known = this.seen.get(node);
    if (known) return known;
    const created: Unit = { node, calls: [], callees: new Set(), params: [], async: false, returns: null };
    this.seen.set(node, created);
    return created;
  }

  private bindClosure(name: string, value: ASTNode): void {
    this.tracked.add(name);
    const closures = this.closuresOf(value);
    if (!closures) {
      if (!this.opaque.has(name)) {
        this.opaque.add(name);
        this.changed = true;
      }
      return;
    }
    this.union(name, closures);
  }

  private union(name: string, closures: Set<Unit>): void {
    let target = this.flow.get(name);
    if (!target) {
      target = new Set();
      this.flow.set(name, target);
    }
    for (const unit of closures) {
      if (target.has(unit)) continue;
      target.add(unit);
      this.changed = true;
    }
  }

  private bindArguments(call: CallNode): void {
    const resolved = this.resolveCallee(call.callee);
    for (const callee of resolved.units) {
      for (let i = 0; i < callee.params.length; i++) {
        const name = callee.params[i];
        if (!name) continue;
        const arg = call.args[i];
        if (!arg) continue;
        this.bindClosure(name, arg);
      }
    }
  }

  private resolveCallee(callee: ASTNode): Resolution {
    if (isFunctionNode(callee)) return { units: [this.unitFor(callee)], unknown: false };
    if (callee.type === NodeType.MemberExpression) return NOT_A_CLOSURE;
    if (callee.type !== NodeType.Identifier) return UNRESOLVED;

    const name = String(callee.name);
    const closures = this.closuresOf(callee);
    if (closures && closures.size > 0) {
      return { units: [...closures], unknown: this.opaque.has(name) };
    }
    if (this.tracked.has(name)) return UNRESOLVED;
    return NOT_A_CLOSURE;
  }

  private domainType(node: ASTNode, types: Types): string | null {
    if (node.type === NodeType.Identifier) return types.get(String(node.name)) ?? null;
    if (node.type === NodeType.MemberExpression) return this.memberType(node, types);
    if (node.type !== NodeType.CallExpression) return null;

    const callee = (node as CallNode).callee;
    const name = calleeName(callee);
    if (!name) return this.domainType(callee, types);
    if (RESULT_FIELD_TYPES[name]) return `${RECORD_PREFIX}${name}`;
    const returns = DOMAIN_BUILTIN_METADATA[name]?.returns;
    if (returns) return ASYNC_DOMAIN_TYPES.has(returns) ? returns : null;
    for (const unit of this.byName.get(name) ?? []) if (unit.returns) return unit.returns;
    return null;
  }

  private memberType(node: ASTNode, types: Types): string | null {
    const objectType = this.domainType(node.object as ASTNode, types);
    if (objectType === null || !objectType.startsWith(RECORD_PREFIX)) return objectType;
    const fields = RESULT_FIELD_TYPES[objectType.slice(RECORD_PREFIX.length)]!;
    const property = (node as { property?: unknown; computed?: boolean }).property;
    if (node.computed || typeof property !== "string") return null;
    return fields[property] ?? null;
  }

  private isAsyncOrigin(call: CallNode, types: Types): boolean {
    const resolved = this.resolveCallee(call.callee);
    if (resolved.unknown) return true;
    if (resolved.units.length > 0) return resolved.units.some((unit) => unit.async);

    const name = calleeName(call.callee);
    if (name) return DOMAIN_BUILTIN_METADATA[name]?.effect === "async";
    if (call.callee.type !== NodeType.MemberExpression) return false;
    return this.domainType(call.callee.object as ASTNode, types) !== null;
  }

  private propagate(): void {
    for (const unit of this.units) {
      for (const call of unit.calls) {
        for (const callee of this.resolveCallee(call.callee).units) {
          const bucket = this.callers.get(callee);
          if (bucket) bucket.add(unit);
          else this.callers.set(callee, new Set([unit]));
        }
      }
    }

    const worklist = this.units.filter((unit) => unit.async);
    while (worklist.length > 0) {
      for (const caller of this.callers.get(worklist.pop()!) ?? []) {
        if (caller.async) continue;
        this.raise(caller, "async", true);
        worklist.push(caller);
      }
    }
  }

  private mark(): void {
    for (const unit of this.units) {
      if (unit.node && unit.async) unit.node.async = true;
      for (const call of unit.calls) {
        const resolved = this.resolveCallee(call.callee);
        if (resolved.unknown || resolved.units.some((callee) => callee.async)) call.implicitAwait = true;
      }
    }
  }
}

export function analyzeEffects(program: ASTNode): ASTNode {
  new EffectAnalyzer().analyze(program);
  return program;
}
