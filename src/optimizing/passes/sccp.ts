import * as ir from "../ir/index.js";
import { detachInputs, nodeIdStamper, replaceValueUses } from "../ir/graph-edit.js";
import { rewriteBranchAsJump } from "../ir/cfg-edit.js";
import { Worklist } from "../infra/worklist.js";
import { flatLattice, type FlatValue } from "../infra/lattice.js";

type SccpNode = ir.CFGInstruction;
type SccpBlock = ir.CFGBlock;
type SccpGraph = ir.CFGFunction;

export type ConstantValue = number | string | boolean;
type Cell = FlatValue<ConstantValue>;

const cells = flatLattice<ConstantValue>();
const TOP: Cell = { kind: "top" };

const ARITHMETIC: Record<string, (a: number, b: number) => number> = {
  [ir.IR_INT32_ADD]: (a, b) => a + b,
  [ir.IR_INT32_SUB]: (a, b) => a - b,
  [ir.IR_INT32_MUL]: (a, b) => a * b,
  [ir.IR_INT32_DIV]: (a, b) => a / b,
  [ir.IR_INT32_MOD]: (a, b) => a % b,
  [ir.IR_INT32_SHL]: (a, b) => (a << b) | 0,
  [ir.IR_INT32_SHR]: (a, b) => (a >> b) | 0,
  [ir.IR_INT32_AND]: (a, b) => (a & b) | 0,
  [ir.IR_FLOAT64_ADD]: (a, b) => a + b,
  [ir.IR_FLOAT64_SUB]: (a, b) => a - b,
  [ir.IR_FLOAT64_MUL]: (a, b) => a * b,
  [ir.IR_FLOAT64_DIV]: (a, b) => a / b,
};

const WRAPS_IN_INT32: ReadonlySet<string> = new Set<string>([
  ir.IR_INT32_ADD,
  ir.IR_INT32_SUB,
  ir.IR_INT32_MUL,
]);

function foldedArithmetic(node: ir.CFGInstruction, answer: number): Cell {
  const wraps = WRAPS_IN_INT32.has(node.type) && node.props.noOverflow === true;
  return constant(wraps ? answer | 0 : answer);
}

const COMPARISONS: Record<string, (a: number, b: number) => boolean> = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "loose==": (a, b) => a == b,
  "loose!=": (a, b) => a != b,
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b,
};

function constant(value: ConstantValue): Cell {
  return { kind: "constant", value };
}

function isConstantValue(value: ir.IRMetadataValue): value is ConstantValue {
  const kind = typeof value;
  return kind === "number" || kind === "string" || kind === "boolean";
}

function numberOf(cell: Cell): number | null {
  return cell.kind === "constant" && typeof cell.value === "number" ? cell.value : null;
}

function edgeKey(from: SccpBlock, to: SccpBlock): string {
  return `${from.id}->${to.id}`;
}

function branchTargets(
  block: SccpBlock,
  terminator: SccpNode,
  blockById: ReadonlyMap<number, SccpBlock>,
): { taken: SccpBlock; other: SccpBlock } | null {
  const onTrue = blockById.get(Number(terminator.props.trueBlock));
  const onFalse = blockById.get(Number(terminator.props.falseBlock));
  if (onTrue === undefined || onFalse === undefined) return null;
  if (!block.successors.includes(onTrue) || !block.successors.includes(onFalse)) return null;
  return { taken: onTrue, other: onFalse };
}

class SccpSolver {
  private readonly valueOf = new Map<number, Cell>();
  private readonly executable = new Set<string>();
  private readonly reachable = new Set<SccpBlock>();
  private readonly flowWork = new Worklist<SccpBlock>();
  private readonly ssaWork = new Worklist<SccpNode>();
  private readonly blockById = new Map<number, SccpBlock>();

  constructor(private readonly graph: SccpGraph) {
    for (const block of graph.blocks) this.blockById.set(block.id, block);
  }

  solve(): void {
    for (const parameter of this.graph.parameters) this.valueOf.set(parameter.id, TOP);
    const entry = this.graph.entry;
    if (entry === null) return;
    this.markReachable(entry);

    while (!this.flowWork.isEmpty || !this.ssaWork.isEmpty) {
      const block = this.flowWork.take();
      if (block !== undefined) {
        this.visitBlock(block);
        continue;
      }
      const node = this.ssaWork.take();
      if (node !== undefined && node.block !== null && this.reachable.has(node.block)) {
        this.visitNode(node);
      }
    }
  }

  cellOf(node: SccpNode): Cell {
    return this.valueOf.get(node.id) ?? cells.bottom;
  }

  isReachable(block: SccpBlock): boolean {
    return this.reachable.has(block);
  }

  takenSuccessor(block: SccpBlock): SccpBlock | null {
    const terminator = block.getTerminator();
    if (!terminator || terminator.type !== ir.IR_BRANCH) return null;
    const targets = branchTargets(block, terminator, this.blockById);
    if (targets === null) return null;
    const condition = terminator.inputs[0];
    if (condition === undefined) return null;
    const cell = this.cellOf(condition);
    if (cell.kind !== "constant") return null;
    return cell.value ? targets.taken : targets.other;
  }

  private markReachable(block: SccpBlock): void {
    if (this.reachable.has(block)) return;
    this.reachable.add(block);
    this.flowWork.add(block);
  }

  private markEdge(from: SccpBlock, to: SccpBlock): void {
    const key = edgeKey(from, to);
    const fresh = !this.executable.has(key);
    this.executable.add(key);
    if (fresh) for (const phi of to.phis) this.ssaWork.add(phi);
    this.markReachable(to);
  }

  private visitBlock(block: SccpBlock): void {
    for (const node of block.nodes) this.visitNode(node);
  }

  private visitNode(node: SccpNode): void {
    if (node.type === ir.IR_BRANCH) {
      this.visitBranch(node);
      return;
    }
    if (node.type === ir.IR_JUMP) {
      const block = node.block;
      if (block !== null) for (const successor of block.successors) this.markEdge(block, successor);
      return;
    }
    this.update(node, this.evaluate(node));
  }

  private visitBranch(node: SccpNode): void {
    const block = node.block;
    if (block === null) return;
    const targets = branchTargets(block, node, this.blockById);
    if (targets === null) {
      for (const successor of block.successors) this.markEdge(block, successor);
      return;
    }
    const condition = node.inputs[0];
    const cell = condition === undefined ? TOP : this.cellOf(condition);
    if (cell.kind === "bottom") return;
    if (cell.kind === "top") {
      this.markEdge(block, targets.taken);
      this.markEdge(block, targets.other);
      return;
    }
    this.markEdge(block, cell.value ? targets.taken : targets.other);
  }

  private update(node: SccpNode, next: Cell): void {
    const previous = this.cellOf(node);
    const joined = cells.join(previous, next);
    if (cells.equals(previous, joined)) return;
    this.valueOf.set(node.id, joined);
    for (const use of node.uses) this.ssaWork.add(use);
  }

  private evaluate(node: SccpNode): Cell {
    if (node.type === ir.IR_CONSTANT) {
      const value = node.props.value;
      return isConstantValue(value) ? constant(value) : TOP;
    }
    if (node.type === ir.IR_PHI) return this.evaluatePhi(node);

    const arithmetic = ARITHMETIC[node.type];
    if (arithmetic !== undefined) {
      const left = numberOf(this.cellOf(node.inputs[0]!));
      const right = numberOf(this.cellOf(node.inputs[1]!));
      if (this.anyBottom(node)) return cells.bottom;
      if (left === null || right === null) return TOP;
      return foldedArithmetic(node, arithmetic(left, right));
    }

    if (node.type === ir.IR_INT32_COMPARE || node.type === ir.IR_FLOAT64_COMPARE) {
      const compare = typeof node.props.op === "string" ? COMPARISONS[node.props.op] : undefined;
      const left = numberOf(this.cellOf(node.inputs[0]!));
      const right = numberOf(this.cellOf(node.inputs[1]!));
      if (this.anyBottom(node)) return cells.bottom;
      if (compare === undefined || left === null || right === null) return TOP;
      return constant(compare(left, right));
    }

    if (node.type === ir.IR_NOT) {
      const input = this.cellOf(node.inputs[0]!);
      if (input.kind === "bottom") return cells.bottom;
      return input.kind === "constant" ? constant(!input.value) : TOP;
    }

    if (node.type === ir.IR_NEG) {
      const value = numberOf(this.cellOf(node.inputs[0]!));
      if (this.anyBottom(node)) return cells.bottom;
      return value === null ? TOP : constant(-value);
    }

    if (node.type === ir.IR_CHECK_SMI || node.type === ir.IR_CHECK_NUMBER) {
      const input = this.cellOf(node.inputs[0]!);
      if (input.kind !== "constant" || typeof input.value !== "number") return TOP;
      if (node.type === ir.IR_CHECK_NUMBER) return input;
      return Number.isInteger(input.value) && input.value === (input.value | 0)
        ? input
        : TOP;
    }

    if (node.type === ir.IR_GENERIC_ADD) {
      const left = this.cellOf(node.inputs[0]!);
      const right = this.cellOf(node.inputs[1]!);
      if (this.anyBottom(node)) return cells.bottom;
      if (
        left.kind === "constant" &&
        right.kind === "constant" &&
        typeof left.value === "string" &&
        typeof right.value === "string"
      ) {
        return constant(left.value + right.value);
      }
      return TOP;
    }

    return TOP;
  }

  private anyBottom(node: SccpNode): boolean {
    for (const input of node.inputs) {
      if (this.cellOf(input).kind === "bottom") return true;
    }
    return false;
  }

  private evaluatePhi(phi: SccpNode): Cell {
    const block = phi.block;
    if (block === null) return TOP;
    let result: Cell = cells.bottom;
    for (let i = 0; i < block.predecessors.length; i++) {
      const predecessor = block.predecessors[i];
      if (predecessor === undefined) continue;
      if (!this.executable.has(edgeKey(predecessor, block))) continue;
      const input = phi.inputs[i];
      if (input === undefined) return TOP;
      result = cells.join(result, this.cellOf(input));
      if (result.kind === "top") return TOP;
    }
    return result;
  }
}

const FORWARDING = new Set<string>([ir.IR_PHI, ir.IR_CHECK_SMI, ir.IR_CHECK_NUMBER]);

const FOLDABLE = new Set<string>([
  ir.IR_INT32_ADD,
  ir.IR_INT32_SUB,
  ir.IR_INT32_MUL,
  ir.IR_INT32_DIV,
  ir.IR_INT32_MOD,
  ir.IR_INT32_SHL,
  ir.IR_INT32_SHR,
  ir.IR_INT32_AND,
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_SUB,
  ir.IR_FLOAT64_MUL,
  ir.IR_FLOAT64_DIV,
  ir.IR_INT32_COMPARE,
  ir.IR_FLOAT64_COMPARE,
  ir.IR_NOT,
  ir.IR_NEG,
  ir.IR_GENERIC_ADD,
]);

export function sparseConditionalConstantPropagation(graph: SccpGraph): number {
  const solver = new SccpSolver(graph);
  solver.solve();

  let rewrites = 0;
  const stamp = nodeIdStamper(graph);

  for (const block of graph.blocks) {
    if (!solver.isReachable(block)) continue;
    const replacements: Array<{ node: SccpNode; at: number; value: ConstantValue }> = [];
    for (let at = 0; at < block.nodes.length; at++) {
      const node = block.nodes[at];
      if (!FOLDABLE.has(node.type) && !FORWARDING.has(node.type)) continue;
      const cell = solver.cellOf(node);
      if (cell.kind !== "constant") continue;
      if (FORWARDING.has(node.type) && node.uses.length === 0) continue;
      replacements.push({ node, at, value: cell.value });
    }
    for (const { node, at, value } of replacements) {
      const folded = stamp(ir.irConstant(value) as unknown as ir.CFGInstruction);
      if (FORWARDING.has(node.type)) {
        replaceValueUses(graph, node, folded);
      } else {
        folded.block = block;
        block.nodes[at] = folded;
        replaceValueUses(graph, node, folded);
        detachInputs(node);
        node.block = null;
      }
      rewrites++;
    }
  }

  for (const block of graph.blocks) {
    if (!solver.isReachable(block)) continue;
    const taken = solver.takenSuccessor(block);
    if (taken === null) continue;
    const dead = block.successors.find((successor) => successor !== taken);
    if (dead === undefined) continue;
    if (rewriteBranchAsJump(block, taken, dead)) rewrites++;
  }

  return rewrites;
}
