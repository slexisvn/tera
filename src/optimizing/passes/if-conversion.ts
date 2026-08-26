import {
  canDeoptimize,
  isEffectFree,
  isMovable,
  irSelect,
  IR_BRANCH,
  IR_FLOAT64_DIV,
  IR_FLOAT64_POW,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_JUMP,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { removePhis } from "../ir/cfg-edit.js";
import { detachInputs, nodeIdStamper, type Stamp } from "../ir/graph-edit.js";
import { metadataNumber } from "../ir/metadata.js";
import { remarks } from "../infra/pass-remarks.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { Capability } from "../target/capabilities.js";
import type { TargetModel } from "../target/model.js";
import { aotScalarOf, SCALAR_FLOAT64, SCALAR_INT32, type AotScalar } from "../types/scalar.js";

export type SelectsValue = (merged: CFGInstruction) => boolean;

const SELECTED_BY: ReadonlyMap<AotScalar, Capability> = new Map<AotScalar, Capability>([
  [SCALAR_INT32, "select-integer"],
  [SCALAR_FLOAT64, "select-float"],
]);

export function valuesTargetSelects(
  target: TargetModel,
  types: TypeInference,
): SelectsValue {
  return (merged) => {
    const scalar = aotScalarOf(types.typeOf(merged));
    const capability = scalar === null ? undefined : SELECTED_BY.get(scalar);
    return capability !== undefined && target.capabilities.has(capability);
  };
}

const STEP_COST = 1;

const ROUTINE_COST = 16;

const THROUGH_A_ROUTINE: ReadonlySet<string> = new Set<string>([
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_FLOAT64_DIV,
  IR_FLOAT64_POW,
]);

interface Arm {
  readonly block: CFGBlock | null;
  readonly body: readonly CFGInstruction[];
  readonly cost: number;
}

interface Diamond {
  readonly head: CFGBlock;
  readonly join: CFGBlock;
  readonly condition: CFGInstruction;
  readonly arms: readonly [Arm, Arm];
}

function successorNamed(head: CFGBlock, branch: CFGInstruction, prop: string): CFGBlock | null {
  const id = metadataNumber(branch.props[prop]);
  if (id === null) return null;
  return head.successors.find((successor) => successor.id === id) ?? null;
}

function speculationCost(node: CFGInstruction): number {
  return THROUGH_A_ROUTINE.has(node.type) ? ROUTINE_COST : STEP_COST;
}

function speculatable(node: CFGInstruction): boolean {
  return (
    isMovable(node) &&
    isEffectFree(node) &&
    !canDeoptimize(node) &&
    node.frameState === null
  );
}

function jumpsStraightTo(arm: CFGBlock, head: CFGBlock): CFGBlock | null {
  if (arm === head || arm.phis.length > 0) return null;
  if (arm.predecessors.length !== 1 || arm.predecessors[0] !== head) return null;
  const terminator = arm.getTerminator();
  if (terminator === null || terminator.type !== IR_JUMP) return null;
  return arm.successors.length === 1 ? arm.successors[0]! : null;
}

function armOf(block: CFGBlock, join: CFGBlock): Arm | null {
  const terminator = block.getTerminator();
  const body: CFGInstruction[] = [];
  let cost = 0;
  for (const node of block.nodes) {
    if (node === terminator) continue;
    if (!speculatable(node)) return null;
    for (const use of node.uses) {
      if (use.block === block) continue;
      if (use.block === join && join.phis.includes(use)) continue;
      return null;
    }
    body.push(node);
    cost += speculationCost(node);
  }
  return { block, body, cost };
}

const EMPTY_ARM: Arm = { block: null, body: [], cost: 0 };

function diamondAt(head: CFGBlock): Diamond | null {
  const branch = head.getTerminator();
  if (branch === null || branch.type !== IR_BRANCH) return null;
  const condition = branch.inputs[0];
  if (condition === undefined) return null;
  const onTrue = successorNamed(head, branch, "trueBlock");
  const onFalse = successorNamed(head, branch, "falseBlock");
  if (onTrue === null || onFalse === null || onTrue === onFalse) return null;

  const trueJoin = jumpsStraightTo(onTrue, head);
  const falseJoin = jumpsStraightTo(onFalse, head);
  const join = trueJoin ?? falseJoin;
  if (join === null || join === head) return null;
  if (trueJoin !== null && falseJoin !== null && trueJoin !== falseJoin) return null;
  if (trueJoin === null && onTrue !== join) return null;
  if (falseJoin === null && onFalse !== join) return null;

  const sides = [trueJoin === null ? null : onTrue, falseJoin === null ? null : onFalse];
  const entering = new Set(sides.map((side) => side ?? head));
  if (join.predecessors.length !== entering.size) return null;
  for (const predecessor of join.predecessors) {
    if (!entering.has(predecessor)) return null;
  }

  const arms = sides.map((side) => (side === null ? EMPTY_ARM : armOf(side, join)));
  if (arms.some((arm) => arm === null)) return null;
  return { head, join, condition, arms: arms as [Arm, Arm] };
}

function incomingFrom(phi: CFGInstruction, join: CFGBlock, arm: Arm, head: CFGBlock) {
  return phi.inputs[join.predecessors.indexOf(arm.block ?? head)]!;
}

function scheduleBeforeChoice(
  head: CFGBlock,
  branch: CFGInstruction,
  condition: CFGInstruction,
): void {
  if (condition.block !== head || !speculatable(condition)) return;
  if (condition.uses.length !== 1 || condition.uses[0] !== branch) return;
  head.nodes = head.nodes.filter((candidate) => candidate !== condition);
  head.nodes.splice(head.nodes.indexOf(branch), 0, condition);
}

function convert(graph: CFGFunction, diamond: Diamond, stamp: Stamp): void {
  const { head, join, condition, arms } = diamond;
  const editor = new GraphEditor(graph);
  const branch = head.getTerminator()!;

  for (const arm of arms) {
    for (const node of arm.body) {
      arm.block!.nodes = arm.block!.nodes.filter((candidate) => candidate !== node);
      node.block = head;
      head.nodes.splice(head.nodes.indexOf(branch), 0, node);
    }
  }
  scheduleBeforeChoice(head, branch, condition);

  for (const phi of [...join.phis]) {
    const onTrue = incomingFrom(phi, join, arms[0], head);
    const onFalse = incomingFrom(phi, join, arms[1], head);
    if (onTrue === onFalse) {
      editor.replaceAllUses(phi, onTrue);
      continue;
    }
    const select = stamp(irSelect(condition, onTrue, onFalse));
    editor.insertBefore(branch, select);
    editor.replaceAllUses(phi, select);
  }
  removePhis(join, new Set(join.phis));

  detachInputs(branch);
  branch.type = IR_JUMP;
  branch.props = { targetBlock: join.id };
  head.successors = [join];
  join.predecessors = [head];
  const retired = new Set(arms.map((arm) => arm.block));
  graph.blocks = graph.blocks.filter((block) => !retired.has(block));
}

export function ifConversion(
  graph: CFGFunction,
  selects: SelectsValue,
  budget: number,
): number {
  if (budget <= 0) {
    remarks.analysis(
      null,
      "if-conversion is switched off here: the budget is zero, so every branch stays a branch",
    );
    return 0;
  }
  const stamp = nodeIdStamper(graph);
  const retired = new Set<CFGBlock>();
  let converted = 0;

  for (const head of [...graph.blocks]) {
    if (retired.has(head)) continue;
    const diamond = diamondAt(head);
    if (diamond === null) continue;
    const overBudget = diamond.arms.find((arm) => arm.cost > budget);
    if (overBudget !== undefined) {
      remarks.missed(
        null,
        `left the branch at B${head.id} alone: one arm costs ${overBudget.cost} against a budget of ${budget}, and running both arms unconditionally would be slower than predicting the branch`,
      );
      continue;
    }
    const unselectable = diamond.join.phis.find((phi) => !selects(phi));
    if (unselectable !== undefined) {
      remarks.missed(
        unselectable,
        `left the branch at B${head.id} alone: this phi merges values the target cannot express as a select`,
      );
      continue;
    }
    convert(graph, diamond, stamp);
    for (const arm of diamond.arms) {
      if (arm.block !== null) retired.add(arm.block);
    }
    remarks.applied(
      null,
      `turned the branch at B${head.id} into selects: both arms are cheap enough to run unconditionally, so the branch is gone`,
    );
    converted++;
  }

  if (converted > 0) graph.rebuildUses();
  return converted;
}
