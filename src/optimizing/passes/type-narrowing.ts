import * as ir from "../ir/index.js";
import { computeDominators, buildDominatorTree } from "./dominators.js";
import { tracer } from "../../core/tracing/index.js";
import {
  TypeKind,
  booleanType,
  excludeType,
  joinTypes,
  narrowType,
  numberType,
  objectType,
  smiType,
  stringType,
  typeFromConstant,
  typeFromTypeof,
} from "../types/lattice.js";
import type { LatticeType } from "../types/lattice.js";
import type { FrameState } from "../../deopt/frame-state.js";
type TypeNode = ir.CFGInstruction;
type TypeBlock = ir.CFGBlock;
type TypeGraph = ir.CFGFunction;

type TypeFacts = Map<number, LatticeType>;

const GENERIC_TO_INT32: Record<string, string> = {
  [ir.IR_GENERIC_ADD]: ir.IR_INT32_ADD,
  [ir.IR_GENERIC_SUB]: ir.IR_INT32_SUB,
  [ir.IR_GENERIC_MUL]: ir.IR_INT32_MUL,
  [ir.IR_GENERIC_MOD]: ir.IR_INT32_MOD,
  [ir.IR_GENERIC_COMPARE]: ir.IR_INT32_COMPARE,
};

const GENERIC_TO_FLOAT64: Record<string, string> = {
  [ir.IR_GENERIC_ADD]: ir.IR_FLOAT64_ADD,
  [ir.IR_GENERIC_SUB]: ir.IR_FLOAT64_SUB,
  [ir.IR_GENERIC_MUL]: ir.IR_FLOAT64_MUL,
  [ir.IR_GENERIC_DIV]: ir.IR_FLOAT64_DIV,
  [ir.IR_GENERIC_COMPARE]: ir.IR_FLOAT64_COMPARE,
};

export function typeNarrowing(graph: TypeGraph): number {
  const dominators = computeDominators(graph);
  const { children } = buildDominatorTree(graph, dominators);
  let narrowCount = 0;

  const walkBlock = (block: TypeBlock, inherited: TypeFacts): void => {
    const facts = new Map(inherited);
    mergeBlockParams(block, facts);

    for (const node of block.nodes) {
      recordNodeType(node, facts);

      const specializedType = specializeNode(node, facts);
      if (specializedType) {
        node.type = specializedType;
        if (!node.frameState) node.frameState = frameStateFromInputs(node);
        narrowCount++;
        recordNodeType(node, facts);
      }
    }

    for (const child of (children.get(block) || []) as TypeBlock[]) {
      walkBlock(child, factsForDominatorChild(block, child, facts));
    }
  };

  if (graph.blocks[0]) walkBlock(graph.blocks[0], new Map());

  if (narrowCount > 0) {
    tracer.jitCompile(
      "",
      `TypeNarrowing: specialized ${narrowCount} operations`,
    );
  }
  return narrowCount;
}

function mergeBlockParams(block: TypeBlock, facts: TypeFacts): void {
  for (const param of block.params || []) {
    let merged: LatticeType | null = null;
    for (const input of param.inputs || []) {
      merged = joinTypes(
        merged,
        inferValueType(input, facts, new Set([param.id])),
      );
    }
    if (merged) facts.set(param.id, merged);
  }
}

function recordNodeType(node: TypeNode, facts: TypeFacts): void {
  if (node.type === ir.IR_CHECK_SMI && node.inputs[0]) {
    const narrowed = narrowType(facts.get(node.inputs[0].id), smiType());
    facts.set(node.inputs[0].id, narrowed);
    facts.set(node.id, narrowed);
    return;
  }

  if (node.type === ir.IR_CHECK_NUMBER && node.inputs[0]) {
    const narrowed = narrowType(facts.get(node.inputs[0].id), numberType());
    facts.set(node.inputs[0].id, narrowed);
    facts.set(node.id, narrowed);
    return;
  }

  if (node.type === ir.IR_CHECK_MAP && node.inputs[0]) {
    const narrowed = narrowType(
      facts.get(node.inputs[0].id),
      objectType(node.props.expectedMapId ?? null),
    );
    facts.set(node.inputs[0].id, narrowed);
    facts.set(node.id, narrowed);
    return;
  }

  if (node.type === ir.IR_CONSTANT) {
    facts.set(node.id, typeFromConstant(node.props.value));
    return;
  }

  if (node.type === ir.IR_NOT) {
    facts.set(node.id, booleanType());
    return;
  }

  if (node.type === ir.IR_TYPEOF) {
    facts.set(node.id, stringType());
    return;
  }

  if (node.type === ir.IR_BLOCK_PARAM) {
    let merged: LatticeType | null = null;
    for (const input of node.inputs || []) {
      merged = joinTypes(
        merged,
        inferValueType(input, facts, new Set([node.id])),
      );
    }
    if (merged) facts.set(node.id, merged);
  }
}

function inferValueType(
  value: TypeNode,
  facts: TypeFacts,
  seen = new Set<number>(),
): LatticeType | null {
  const existing = facts.get(value.id);
  if (existing) return existing;
  if (seen.has(value.id)) return null;
  seen.add(value.id);
  if (value.type === ir.IR_CONSTANT) return typeFromConstant(value.props.value);
  if (value.type === ir.IR_CHECK_SMI) return smiType();
  if (value.type === ir.IR_CHECK_NUMBER) return numberType();
  if (value.type === ir.IR_CHECK_MAP) {
    return objectType(value.props.expectedMapId ?? null);
  }
  if (value.type === ir.IR_NOT) return booleanType();
  if (value.type === ir.IR_TYPEOF) return stringType();
  if (value.type === ir.IR_BLOCK_PARAM) {
    let merged: LatticeType | null = null;
    for (const input of value.inputs || []) {
      merged = joinTypes(merged, inferValueType(input, facts, seen));
    }
    return merged;
  }
  return null;
}

function factsForDominatorChild(
  block: TypeBlock,
  child: TypeBlock,
  facts: TypeFacts,
): TypeFacts {
  const next = new Map(facts);
  const terminator = block.getTerminator
    ? block.getTerminator()
    : block.nodes[block.nodes.length - 1];
  if (!terminator || terminator.type !== ir.IR_BRANCH) return next;
  if (terminator.props.trueBlock === child.id) {
    recordBranchFact(terminator, next, true);
  } else if (terminator.props.falseBlock === child.id) {
    recordBranchFact(terminator, next, false);
  }
  return next;
}

function extractTypeofComparison(
  branch: TypeNode,
): { valueId: number; typeofString: string } | null {
  if (!branch.inputs[0]) return null;
  const condition = branch.inputs[0];
  if (condition.type !== ir.IR_INT32_COMPARE || condition.inputs.length !== 2) {
    return null;
  }
  const { op } = condition.props;
  if (op !== "==" && op !== "===") return null;
  const [left, right] = condition.inputs;
  if (
    left?.type === ir.IR_TYPEOF &&
    right?.type === ir.IR_CONSTANT &&
    typeof right.props.value === "string" &&
    left.inputs[0]
  ) {
    return { valueId: left.inputs[0].id, typeofString: right.props.value };
  }
  return null;
}

function recordBranchFact(
  branch: TypeNode,
  facts: TypeFacts,
  isTrueBranch: boolean,
): void {
  const cmp = extractTypeofComparison(branch);
  if (!cmp) return;
  const fact = typeFromTypeof(cmp.typeofString);
  if (!fact) return;
  if (isTrueBranch) {
    facts.set(cmp.valueId, narrowType(facts.get(cmp.valueId), fact));
  } else {
    facts.set(cmp.valueId, excludeType(facts.get(cmp.valueId), fact));
  }
}

function specializeNode(node: TypeNode, facts: TypeFacts): string | null {
  if (node.inputs.length < 2) return null;
  const left = facts.get(node.inputs[0]!.id);
  const right = facts.get(node.inputs[1]!.id);
  if (!left || !right) return null;

  if (left.kind === TypeKind.Smi && right.kind === TypeKind.Smi) {
    return GENERIC_TO_INT32[node.type] || null;
  }

  if (isNumeric(left) && isNumeric(right)) {
    return GENERIC_TO_FLOAT64[node.type] || null;
  }

  return null;
}

function isNumeric(type: LatticeType): boolean {
  return (
    type.kind === TypeKind.Smi ||
    type.kind === TypeKind.Double ||
    type.kind === TypeKind.Number
  );
}

function frameStateFromInputs(node: TypeNode): FrameState | null {
  for (const input of node.inputs) {
    if (input && input.frameState) return input.frameState;
  }
  return null;
}
