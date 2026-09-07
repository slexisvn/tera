import { astChildren, memberName, NodeType, subjectName, type ASTNode } from "../ast/index.js";
import { ADDS_ONE_ELEMENT, provenCount, TAKES_ONE_ELEMENT } from "../../core/indexing.js";
import {
  alwaysExits,
  branchChain,
  ownExpressions,
  type BlockNode,
  type ClassNode,
  type ForNode,
  type FunctionNode,
  type ModelNode,
  type SemanticNode,
} from "./semantic-ast.js";

const NOTHING = 0;
const ONE_ELEMENT = 1;
const HOLDS_ONE = 1;
const COUNT_MEMBER = "length";
const REPEATED_TEST = "loop";

const MIRRORED: ReadonlyMap<string, string> = new Map([
  [">", "<"],
  [">=", "<="],
  ["<", ">"],
  ["<=", ">="],
]);

const KEPT_WHEN: ReadonlyMap<string, boolean> = new Map([
  ["&&", false],
  ["and", false],
  ["||", true],
  ["or", true],
]);

const RUNS_LATER: ReadonlySet<string> = new Set<string>([
  NodeType.ArrowFunctionExpression,
  NodeType.FunctionExpression,
]);

type OwnScope = (node: SemanticNode) => readonly (readonly SemanticNode[])[];

const CARRIES_ITS_OWN_SCOPE: ReadonlyMap<SemanticNode["kind"], OwnScope> = new Map<SemanticNode["kind"], OwnScope>([
  ["Function", (node) => [(node as FunctionNode).body]],
  ["Model", (node) => [(node as ModelNode).body]],
  ["Class", (node) => (node as ClassNode).members.map((member) => member.fn.body)],
]);

type Repeated = {
  readonly entered: readonly ASTNode[];
  readonly test?: ASTNode;
  readonly body: readonly SemanticNode[];
};
type MayRepeat = (node: SemanticNode) => Repeated | null;

const RUNS_REPEATEDLY: ReadonlyMap<SemanticNode["kind"], MayRepeat> = new Map<SemanticNode["kind"], MayRepeat>([
  ["For", (node) => ({ entered: ownExpressions(node), body: (node as ForNode).body })],
  ["Block", (node) => {
    const block = node as BlockNode;
    return block.testRole === REPEATED_TEST ? { entered: [], test: block.test, body: block.body } : null;
  }],
]);

type Remaining = number | undefined;
type Counts = Map<string, number>;
type Changed = Map<string, Remaining>;
type Restore = { readonly name: string; readonly had: Remaining };
type Counted = { readonly name: string; readonly proven: number };

function leastRemaining(left: Remaining, right: Remaining): Remaining {
  return left === undefined || right === undefined ? undefined : Math.min(left, right);
}

function countedName(node: ASTNode): string | null {
  if (node.type !== NodeType.MemberExpression) return null;
  if (memberName(node) !== COUNT_MEMBER) return null;
  return subjectName(node.object as ASTNode);
}

function literalCount(node: ASTNode): number | null {
  if (node.type !== NodeType.Literal || node.kind !== "number") return null;
  return typeof node.value === "number" ? node.value : null;
}

function countedSubject(test: ASTNode, negated: boolean): Counted | null {
  const left = test.left as ASTNode;
  const right = test.right as ASTNode;
  const counted = countedName(left);
  const name = counted ?? countedName(right);
  if (name === null) return null;
  const bound = literalCount(counted === null ? left : right);
  if (bound === null) return null;
  const op = String(test.op);
  const read = counted === null ? (MIRRORED.get(op) ?? op) : op;
  const proven = provenCount(read, bound, negated);
  return proven === NOTHING ? null : { name, proven };
}

function countedSubjects(test: ASTNode, negated: boolean): Counted[] {
  if (test.type === NodeType.LogicalExpression && KEPT_WHEN.get(String(test.op)) === negated) {
    return [
      ...countedSubjects(test.left as ASTNode, negated),
      ...countedSubjects(test.right as ASTNode, negated),
    ];
  }
  if (test.type !== NodeType.BinaryExpression) return [];
  const subject = countedSubject(test, negated);
  return subject === null ? [] : [subject];
}

function memberCall(node: ASTNode): { readonly held: string; readonly member: string } | null {
  if (node.type !== NodeType.CallExpression) return null;
  const callee = node.callee as ASTNode | undefined;
  if (callee?.type !== NodeType.MemberExpression) return null;
  const held = subjectName(callee.object as ASTNode);
  return held === null ? null : { held, member: memberName(callee) };
}

class Bounds {
  private counts: Counts = new Map();
  private trail: Restore[] = [];
  private undoable = NOTHING;
  private taken = new Set<string>();

  constructor(private readonly proven: Set<ASTNode>) {}

  statements(body: readonly SemanticNode[]): void {
    for (let at = NOTHING; at < body.length; at++) {
      const chain = branchChain(body, at);
      if (chain.length === NOTHING) {
        this.statement(body[at]!);
        continue;
      }
      this.chain(chain);
      at += chain.length - ONE_ELEMENT;
    }
  }

  private statement(node: SemanticNode): void {
    const scoped = CARRIES_ITS_OWN_SCOPE.get(node.kind);
    if (scoped) return this.deferred(node, scoped(node));
    const repeated = RUNS_REPEATEDLY.get(node.kind)?.(node) ?? null;
    if (repeated) {
      for (const held of repeated.entered) this.expression(held);
      return this.forget(this.apart(() => {
        if (repeated.test) this.expression(repeated.test);
        this.guarded(repeated.test, false);
        this.statements(repeated.body);
      }));
    }
    for (const held of ownExpressions(node)) this.expression(held);
    if (node.kind === "Block") this.entered(node);
  }

  private entered(node: BlockNode): void {
    for (const refuted of node.otherwise ?? []) this.guarded(refuted, true);
    this.guarded(node.test, false);
    this.statements(node.body);
  }

  private chain(nodes: readonly BlockNode[]): void {
    for (const node of nodes) if (node.test) this.expression(node.test);
    const reached: Changed[] = [];
    for (const node of nodes) {
      const mark = this.mark();
      this.entered(node);
      if (!alwaysExits(node.body)) reached.push(this.changedSince(mark));
      this.rollBack(mark);
    }
    const last = nodes[nodes.length - ONE_ELEMENT]!;
    if (last.test !== undefined) {
      const mark = this.mark();
      for (const refuted of [...(last.otherwise ?? []), last.test]) this.guarded(refuted, true);
      reached.push(this.changedSince(mark));
      this.rollBack(mark);
    }
    this.merge(reached);
  }

  private merge(reached: readonly Changed[]): void {
    if (reached.length === NOTHING) return;
    const touched = new Set<string>();
    for (const path of reached) for (const name of path.keys()) touched.add(name);
    for (const name of touched) {
      const along = reached.map((path) => (path.has(name) ? path.get(name) : this.counts.get(name)));
      this.write(name, along.reduce(leastRemaining));
    }
  }

  private deferred(node: SemanticNode, bodies: readonly (readonly SemanticNode[])[]): void {
    const consumed = new Set<string>();
    for (const held of ownExpressions(node)) {
      for (const name of this.apart(() => this.expression(held))) consumed.add(name);
    }
    for (const body of bodies) {
      for (const name of this.apart(() => this.statements(body))) consumed.add(name);
    }
    this.forget(consumed);
  }

  private guarded(test: ASTNode | undefined, negated: boolean): void {
    if (!test) return;
    for (const counted of countedSubjects(test, negated)) {
      const held = this.counts.get(counted.name);
      if (held !== undefined && held >= counted.proven) continue;
      this.write(counted.name, counted.proven);
    }
  }

  private expression(node: ASTNode): void {
    const walk = (): void => {
      for (const child of astChildren(node)) this.expression(child);
    };
    if (RUNS_LATER.has(String(node.type))) return this.forget(this.apart(walk));
    walk();
    const call = memberCall(node);
    if (call === null) return;
    if (TAKES_ONE_ELEMENT.has(call.member)) return this.takes(node.callee as ASTNode, call.held);
    if (ADDS_ONE_ELEMENT.has(call.member)) this.adds(call.held);
  }

  private takes(callee: ASTNode, held: string): void {
    this.taken.add(held);
    const left = this.counts.get(held);
    if (left === undefined) return;
    if (left >= HOLDS_ONE) this.proven.add(callee);
    this.write(held, Math.max(NOTHING, left - ONE_ELEMENT));
  }

  private adds(held: string): void {
    const left = this.counts.get(held);
    if (left === undefined) return;
    this.write(held, left + ONE_ELEMENT);
  }

  private apart(walk: () => void): ReadonlySet<string> {
    const counts = this.counts;
    const trail = this.trail;
    const undoable = this.undoable;
    const taken = this.taken;
    this.counts = new Map();
    this.trail = [];
    this.undoable = NOTHING;
    this.taken = new Set();
    walk();
    const consumed = this.taken;
    this.counts = counts;
    this.trail = trail;
    this.undoable = undoable;
    this.taken = taken;
    for (const name of consumed) this.taken.add(name);
    return consumed;
  }

  private forget(names: Iterable<string>): void {
    for (const name of names) this.write(name, undefined);
  }

  private write(name: string, count: Remaining): void {
    if (this.undoable > NOTHING) this.trail.push({ name, had: this.counts.get(name) });
    if (count === undefined) this.counts.delete(name);
    else this.counts.set(name, count);
  }

  private mark(): number {
    this.undoable += ONE_ELEMENT;
    return this.trail.length;
  }

  private changedSince(mark: number): Changed {
    const changed: Changed = new Map();
    for (let at = mark; at < this.trail.length; at++) changed.set(this.trail[at]!.name, undefined);
    for (const name of changed.keys()) changed.set(name, this.counts.get(name));
    return changed;
  }

  private rollBack(mark: number): void {
    while (this.trail.length > mark) {
      const { name, had } = this.trail.pop()!;
      if (had === undefined) this.counts.delete(name);
      else this.counts.set(name, had);
    }
    this.undoable -= ONE_ELEMENT;
  }
}

export function provenTakes(body: readonly SemanticNode[]): ReadonlySet<ASTNode> {
  const proven = new Set<ASTNode>();
  new Bounds(proven).statements(body);
  return proven;
}
