import * as ir from "../ir/index.js";
import type { DominatorTree } from "../analyses/dominance.js";
import { addPhi, phiInputFor, splitEdge } from "../ir/cfg-edit.js";
import {
  detachNode,
  nodeIdStamper,
  replaceValueUses,
  retainNodes,
  type Stamp,
} from "../ir/graph-edit.js";

type GvnNode = ir.CFGInstruction;
type GvnBlock = ir.CFGBlock;
type GvnGraph = ir.CFGFunction;

const IDENTITY_VALUED = new Set([ir.IR_PARAMETER, ir.IR_PHI]);

const COMMUTATIVE_OPS = new Set([
  ir.IR_INT32_ADD,
  ir.IR_INT32_MUL,
  ir.IR_INT32_AND,
  ir.IR_INT32_OR,
  ir.IR_INT32_XOR,
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_MUL,
]);

const FIELD = "|";
const ASSIGN = "=";
const REFERENCE = "#";
const OPEN_LIST = "[";
const CLOSE_LIST = "]";
const OPEN_RECORD = "{";
const CLOSE_RECORD = "}";
const LITERAL_PROP = "value";
const NEGATIVE_ZERO = "-0";
const NULL_TOKEN = "null";
const UNDEFINED_TOKEN = "undefined";
const BINARY = 2;
const MERGE_ARITY = 2;
const SINGLE_SUCCESSOR = 1;

function ascending(left: number, right: number): number {
  return left - right;
}

function scalarToken(value: unknown): string | null {
  if (value === null) return NULL_TOKEN;
  if (value === undefined) return UNDEFINED_TOKEN;
  const kind = typeof value;
  if (kind === "number") {
    return kind + FIELD + (Object.is(value, -0) ? NEGATIVE_ZERO : String(value));
  }
  if (kind === "string" || kind === "boolean" || kind === "bigint") {
    return kind + FIELD + String(value);
  }
  return null;
}

function isPlainData(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCongruenceCandidate(node: GvnNode): boolean {
  if (IDENTITY_VALUED.has(node.type)) return false;
  if (node.type === ir.IR_CONSTANT) return false;
  if (!ir.isEffectFree(node)) return false;
  return node.inputs.length > 0;
}

function isMotionCandidate(node: GvnNode): boolean {
  return isCongruenceCandidate(node) && node.frameState === null;
}

function isCriticalEdge(pred: GvnBlock, succ: GvnBlock): boolean {
  return pred.successors.length > SINGLE_SUCCESSOR && succ.predecessors.length >= MERGE_ARITY;
}

class ValueNumbering {
  private readonly byKey = new Map<string, number>();
  private readonly byNode = new Map<GvnNode, number>();
  private readonly byReference = new Map<unknown, number>();
  private next = 0;

  numberOf(node: GvnNode): number {
    const held = this.byNode.get(node);
    if (held !== undefined) return held;
    const key = this.keyOf(node);
    const value = key === null ? this.next++ : this.intern(key);
    this.byNode.set(node, value);
    return value;
  }

  adopt(node: GvnNode, value: number): void {
    this.byNode.set(node, value);
  }

  projectedValue(node: GvnNode, operands: readonly number[]): number {
    return this.intern(this.keyFor(node, operands));
  }

  private keyOf(node: GvnNode): string | null {
    if (node.type !== ir.IR_CONSTANT && !isCongruenceCandidate(node)) return null;
    return this.keyFor(node, node.inputs.map((input) => this.numberOf(input)));
  }

  private keyFor(node: GvnNode, operands: readonly number[]): string {
    return node.type + this.operandToken(operands, node.type) + this.propsToken(node);
  }

  private operandToken(operands: readonly number[], type: string): string {
    const ordered = [...operands];
    if (COMMUTATIVE_OPS.has(type) && ordered.length === BINARY) ordered.sort(ascending);
    return ordered.map((value) => FIELD + value).join("");
  }

  private propsToken(node: GvnNode): string {
    let token = "";
    for (const key of Object.keys(node.props).sort()) {
      const value = node.props[key];
      const encoded =
        key === LITERAL_PROP ? this.literalToken(value) : this.shapeToken(value, new Set());
      token += FIELD + key + ASSIGN + encoded;
    }
    return token;
  }

  private literalToken(value: unknown): string {
    return scalarToken(value) ?? REFERENCE + this.referenceOf(value);
  }

  private shapeToken(value: unknown, open: Set<unknown>): string {
    const scalar = scalarToken(value);
    if (scalar !== null) return scalar;
    if (open.has(value) || !(Array.isArray(value) || isPlainData(value))) {
      return REFERENCE + this.referenceOf(value);
    }
    open.add(value);
    const token = Array.isArray(value)
      ? OPEN_LIST + value.map((item) => this.shapeToken(item, open)).join(FIELD) + CLOSE_LIST
      : this.recordToken(value as Record<string, unknown>, open);
    open.delete(value);
    return token;
  }

  private recordToken(record: Record<string, unknown>, open: Set<unknown>): string {
    const fields = Object.keys(record)
      .sort()
      .map((key) => key + ASSIGN + this.shapeToken(record[key], open));
    return OPEN_RECORD + fields.join(FIELD) + CLOSE_RECORD;
  }

  private referenceOf(value: unknown): number {
    const held = this.byReference.get(value);
    if (held !== undefined) return held;
    const id = this.byReference.size;
    this.byReference.set(value, id);
    return id;
  }

  private intern(key: string): number {
    const held = this.byKey.get(key);
    if (held !== undefined) return held;
    const value = this.next++;
    this.byKey.set(key, value);
    return value;
  }
}

class LeaderTable {
  private readonly defs = new Map<number, GvnNode[]>();

  constructor(
    private readonly dominance: DominatorTree,
    private readonly originOf: (block: GvnBlock) => GvnBlock,
  ) {}

  define(value: number, node: GvnNode): void {
    const held = this.defs.get(value);
    if (held === undefined) {
      this.defs.set(value, [node]);
      return;
    }
    held.push(node);
  }

  reaching(value: number, block: GvnBlock): GvnNode | null {
    for (const node of this.defs.get(value) ?? []) {
      const home = node.block;
      if (home === null) return node;
      if (this.dominance.dominates(home, this.originOf(block))) return node;
    }
    return null;
  }
}

const AVAILABLE = "available";
const INSERTABLE = "insertable";

interface Insertion {
  readonly kind: typeof INSERTABLE;
  readonly pred: GvnBlock;
  readonly value: number;
  readonly operands: readonly GvnNode[];
}

type Projection = { readonly kind: typeof AVAILABLE; readonly leader: GvnNode } | Insertion;

class Redundancy {
  private readonly values = new ValueNumbering();
  private readonly origin = new Map<GvnBlock, GvnBlock>();
  private readonly leaders: LeaderTable;
  private readonly dropped = new Map<GvnBlock, Set<GvnNode>>();
  private readonly stamp: Stamp;
  private removed = 0;
  private inserted = 0;

  constructor(
    private readonly graph: GvnGraph,
    private readonly dominance: DominatorTree,
  ) {
    this.leaders = new LeaderTable(dominance, (block) => this.originOf(block));
    this.stamp = nodeIdStamper(graph);
  }

  run(): number {
    for (const parameter of this.graph.parameters) {
      this.leaders.define(this.values.numberOf(parameter), parameter);
    }
    for (const block of this.dominance.reversePostorder()) {
      for (const node of [...block.nodes]) this.visit(node, block);
    }
    if (this.removed === 0 && this.inserted === 0) return 0;
    for (const [block, nodes] of this.dropped) retainNodes(block, nodes);
    this.graph.rebuildUses();
    return this.removed + this.inserted;
  }

  private visit(node: GvnNode, block: GvnBlock): void {
    const value = this.values.numberOf(node);
    if (!isCongruenceCandidate(node)) {
      this.leaders.define(value, node);
      return;
    }
    const dominating = this.leaders.reaching(value, block);
    if (dominating !== null && dominating !== node) {
      this.forward(node, dominating, block);
      this.removed++;
      return;
    }
    if (this.anticipate(node, block, value)) return;
    this.leaders.define(value, node);
  }

  private forward(node: GvnNode, replacement: GvnNode, block: GvnBlock): void {
    if (node.frameState !== null && replacement.frameState === null) {
      replacement.frameState = node.frameState;
    }
    replaceValueUses(this.graph, node, replacement);
    detachNode(node);
    node.block = null;
    let nodes = this.dropped.get(block);
    if (nodes === undefined) {
      nodes = new Set<GvnNode>();
      this.dropped.set(block, nodes);
    }
    nodes.add(node);
  }

  private anticipate(node: GvnNode, block: GvnBlock, value: number): boolean {
    if (!isMotionCandidate(node)) return false;
    if (block.predecessors.length < MERGE_ARITY) return false;
    const projected: Projection[] = [];
    let reached = 0;
    for (const pred of [...block.predecessors]) {
      if (this.dominance.dominates(block, this.originOf(pred))) return false;
      const projection = this.project(node, block, pred);
      if (projection === null) return false;
      projected.push(projection);
      if (projection.kind === AVAILABLE) reached++;
    }
    if (reached === 0) return false;
    const merged = projected.map((projection) =>
      projection.kind === AVAILABLE
        ? projection.leader
        : this.materialize(node, block, projection),
    );
    const phi = this.stamp(addPhi(block, merged));
    this.values.adopt(phi, value);
    this.leaders.define(value, phi);
    this.forward(node, phi, block);
    this.removed++;
    return true;
  }

  private project(node: GvnNode, block: GvnBlock, pred: GvnBlock): Projection | null {
    const operands: GvnNode[] = [];
    const values: number[] = [];
    let complete = true;
    for (const input of node.inputs) {
      if (input.type === ir.IR_PHI && input.block === block) {
        const incoming = phiInputFor(input, pred);
        if (incoming === undefined) return null;
        operands.push(incoming);
        values.push(this.values.numberOf(incoming));
        continue;
      }
      const carried = this.values.numberOf(input);
      const available = this.leaders.reaching(carried, pred);
      if (available === null) complete = false;
      else operands.push(available);
      values.push(carried);
    }
    const value = this.values.projectedValue(node, values);
    const leader = this.leaders.reaching(value, pred);
    if (leader !== null) return { kind: AVAILABLE, leader };
    return complete ? { kind: INSERTABLE, pred, value, operands } : null;
  }

  private materialize(node: GvnNode, block: GvnBlock, insertion: Insertion): GvnNode {
    const pred = insertion.pred;
    const target = isCriticalEdge(pred, block) ? this.splitCriticalEdge(pred, block) : pred;
    const copy = this.stamp(new ir.CFGInstruction(node.type, { ...node.props }));
    for (const operand of insertion.operands) copy.addInput(operand);
    copy.block = target;
    const terminator = target.getTerminator();
    const at = terminator === null ? target.nodes.length : target.nodes.indexOf(terminator);
    target.nodes.splice(at, 0, copy);
    this.values.adopt(copy, insertion.value);
    this.leaders.define(insertion.value, copy);
    this.inserted++;
    return copy;
  }

  private splitCriticalEdge(pred: GvnBlock, succ: GvnBlock): GvnBlock {
    const middle = splitEdge(this.graph, pred, succ, this.stamp);
    this.origin.set(middle, this.originOf(pred));
    return middle;
  }

  private originOf(block: GvnBlock): GvnBlock {
    return this.origin.get(block) ?? block;
  }
}

export function globalValueNumbering(
  graph: GvnGraph,
  dominance: DominatorTree,
): number {
  if (graph.entry === null) return 0;
  return new Redundancy(graph, dominance).run();
}
