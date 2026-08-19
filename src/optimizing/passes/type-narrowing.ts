import * as ir from "../ir/index.js";
import { tracer } from "../../core/tracing/index.js";
import { detachNode, nodeIdStamper, replaceValueUses } from "../ir/graph-edit.js";
import type { DominatorTree } from "../analyses/dominance.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  excludeType,
  narrowType,
  acceptsNull,
  numberType,
  objectType,
  smiType,
  TypeKind,
  typeFromTypeof,
  type LatticeType,
} from "../types/lattice.js";

const GENERIC_TO_INT32 = new Map<string, ir.Opcode>([
  [ir.IR_GENERIC_ADD, ir.IR_INT32_ADD],
  [ir.IR_GENERIC_SUB, ir.IR_INT32_SUB],
  [ir.IR_GENERIC_MUL, ir.IR_INT32_MUL],
  [ir.IR_GENERIC_MOD, ir.IR_INT32_MOD],
  [ir.IR_GENERIC_COMPARE, ir.IR_INT32_COMPARE],
]);

const GENERIC_TO_FLOAT64 = new Map<string, ir.Opcode>([
  [ir.IR_GENERIC_ADD, ir.IR_FLOAT64_ADD],
  [ir.IR_GENERIC_SUB, ir.IR_FLOAT64_SUB],
  [ir.IR_GENERIC_MUL, ir.IR_FLOAT64_MUL],
  [ir.IR_GENERIC_DIV, ir.IR_FLOAT64_DIV],
  [ir.IR_GENERIC_COMPARE, ir.IR_FLOAT64_COMPARE],
]);

const GUARD_FACTS = new Map<string, (node: ir.CFGInstruction) => LatticeType>([
  [ir.IR_CHECK_SMI, () => smiType()],
  [ir.IR_CHECK_NUMBER, () => numberType()],
  [ir.IR_CHECK_MAP, (node) => objectType(node.props.expectedMapId ?? null)],
]);

const EQUALITY_OPS = new Set(["==", "==="]);

const NUMERIC_KINDS = new Set<string>([
  TypeKind.Smi,
  TypeKind.Double,
  TypeKind.Number,
]);

const NULLISH_COMPARISONS = new Map<string, boolean>([
  ["==", false],
  ["loose==", false],
  ["!=", true],
  ["loose!=", true],
]);

const DEFINED_KINDS = new Set<string>([
  TypeKind.Smi,
  TypeKind.Double,
  TypeKind.Number,
  TypeKind.Boolean,
  TypeKind.String,
  TypeKind.Object,
  TypeKind.Array,
]);

function isNullishConstant(node: ir.CFGInstruction): boolean {
  if (node.type !== ir.IR_CONSTANT) return false;
  const value = node.props.value;
  return value === null || value === undefined;
}

type Refinements = Map<number, LatticeType>;
type Trail = Array<readonly [number, LatticeType | undefined]>;

function isNumeric(type: LatticeType): boolean {
  return NUMERIC_KINDS.has(type.kind);
}

function typeofComparison(
  branch: ir.CFGInstruction,
): { value: ir.CFGInstruction; typeName: string } | null {
  const condition = branch.inputs[0];
  if (condition === undefined || condition.type !== ir.IR_INT32_COMPARE) return null;
  if (!EQUALITY_OPS.has(String(condition.props.op))) return null;
  const [left, right] = condition.inputs;
  if (left?.type !== ir.IR_TYPEOF || right?.type !== ir.IR_CONSTANT) return null;
  const typeName = right.props.value;
  const value = left.inputs[0];
  if (typeof typeName !== "string" || value === undefined) return null;
  return { value, typeName };
}

class Narrower {
  private readonly refinements: Refinements = new Map();
  private readonly stamp: (node: ir.CFGInstruction) => ir.CFGInstruction;
  private count = 0;

  constructor(
    private readonly graph: ir.CFGFunction,
    private readonly dominance: DominatorTree,
    private readonly types: TypeInference,
  ) {
    this.stamp = nodeIdStamper(graph);
  }

  run(): number {
    const entry = this.graph.blocks[0];
    if (entry !== undefined) this.walk(entry);
    return this.count;
  }

  private typeAt(value: ir.CFGInstruction): LatticeType {
    return this.refinements.get(value.id) ?? this.types.typeOf(value);
  }

  private refine(value: ir.CFGInstruction, fact: LatticeType, trail: Trail): void {
    trail.push([value.id, this.refinements.get(value.id)]);
    this.refinements.set(value.id, fact);
  }

  private undo(trail: Trail): void {
    for (let i = trail.length - 1; i >= 0; i--) {
      const [id, previous] = trail[i]!;
      if (previous === undefined) this.refinements.delete(id);
      else this.refinements.set(id, previous);
    }
  }

  private applyEdgeFacts(
    block: ir.CFGBlock,
    child: ir.CFGBlock,
    trail: Trail,
  ): void {
    const terminator = block.getTerminator();
    if (terminator === null || terminator.type !== ir.IR_BRANCH) return;
    const comparison = typeofComparison(terminator);
    if (comparison === null) return;
    const fact = typeFromTypeof(comparison.typeName);
    if (fact === null) return;
    const current = this.typeAt(comparison.value);
    if (terminator.props.trueBlock === child.id) {
      this.refine(comparison.value, narrowType(current, fact), trail);
    } else if (terminator.props.falseBlock === child.id) {
      this.refine(comparison.value, excludeType(current, fact), trail);
    }
  }

  private applyGuardFact(node: ir.CFGInstruction, trail: Trail): void {
    const fact = GUARD_FACTS.get(node.type);
    const guarded = node.inputs[0];
    if (fact === undefined || guarded === undefined) return;
    this.refine(guarded, narrowType(this.typeAt(guarded), fact(node)), trail);
  }

  private specialize(node: ir.CFGInstruction): void {
    const left = node.inputs[0];
    const right = node.inputs[1];
    if (left === undefined || right === undefined) return;
    const leftType = this.typeAt(left);
    const rightType = this.typeAt(right);

    const specialized =
      leftType.kind === TypeKind.Smi && rightType.kind === TypeKind.Smi
        ? GENERIC_TO_INT32.get(node.type)
        : isNumeric(leftType) && isNumeric(rightType)
          ? GENERIC_TO_FLOAT64.get(node.type)
          : undefined;
    if (specialized === undefined) return;

    node.type = specialized;
    if (this.isSpeculative(node)) {
      if (!node.frameState) node.frameState = frameStateFromInputs(node);
    } else {
      node.props.noOverflow = true;
    }
    this.count++;
  }

  private isSpeculative(node: ir.CFGInstruction): boolean {
    return node.inputs.some(
      (input) => this.types.isSpeculative(input) || this.refinements.has(input.id),
    );
  }

  private definedComparison(node: ir.CFGInstruction): boolean | null {
    if (node.type !== ir.IR_GENERIC_COMPARE) return null;
    const result = NULLISH_COMPARISONS.get(String(node.props.op));
    if (result === undefined) return null;
    const [left, right] = node.inputs;
    if (left === undefined || right === undefined) return null;
    const value = isNullishConstant(right) ? left : isNullishConstant(left) ? right : null;
    if (value === null) return null;
    const type = this.typeAt(value);
    if (acceptsNull(type)) return null;
    return DEFINED_KINDS.has(type.kind) ? result : null;
  }

  private foldDefinedComparison(node: ir.CFGInstruction): boolean {
    const result = this.definedComparison(node);
    if (result === null) return false;
    const block = node.block;
    if (block === null) return false;
    const folded = this.stamp(ir.irConstant(result));
    folded.block = block;
    block.nodes[block.nodes.indexOf(node)] = folded;
    replaceValueUses(this.graph, node, folded);
    detachNode(node);
    node.block = null;
    this.count++;
    return true;
  }

  private walk(block: ir.CFGBlock): void {
    const trail: Trail = [];
    for (const node of [...block.nodes]) {
      this.applyGuardFact(node, trail);
      if (this.foldDefinedComparison(node)) continue;
      this.specialize(node);
    }
    for (const child of this.dominance.childrenOf(block) as readonly ir.CFGBlock[]) {
      const edgeTrail: Trail = [];
      this.applyEdgeFacts(block, child, edgeTrail);
      this.walk(child);
      this.undo(edgeTrail);
    }
    this.undo(trail);
  }
}

function frameStateFromInputs(node: ir.CFGInstruction): ir.CFGInstruction["frameState"] {
  for (const input of node.inputs) {
    if (input.frameState) return input.frameState;
  }
  return null;
}

export function typeNarrowing(
  graph: ir.CFGFunction,
  dominance: DominatorTree,
  types: TypeInference,
): number {
  const narrowCount = new Narrower(graph, dominance, types).run();
  if (narrowCount > 0) {
    tracer.jitCompile("", `TypeNarrowing: specialized ${narrowCount} operations`);
  }
  return narrowCount;
}
