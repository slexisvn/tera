import * as ir from "../ir/index.js";

import { tracer } from "../../core/tracing/index.js";
import { computeDominators, buildDominatorTree } from "./dominators.js";
import { replaceGraphFrameStateValue } from "./frame-state-values.js";
import { detachInputs } from "./graph-edit.js";

type IRNodeLike = ir.CFGInstruction;
type IRBlockLike = ir.CFGBlock;
type IRGraphLike = ir.CFGFunction;

type Range = {
  min: number;
  max: number;
};

type LoopGuardEntry = {
  guardBlock: IRBlockLike;
  cmp: IRNodeLike;
  bound: IRNodeLike;
  op: string;
};

type InductionVariable = {
  phi: IRNodeLike;
  initNode: IRNodeLike;
  stepNode: IRNodeLike;
  stepInc: IRNodeLike;
  initRange: Range;
  stepRange: Range;
};

function replaceValue(oldValue: IRNodeLike, newValue: IRNodeLike): void {
  for (const use of [...oldValue.uses]) {
    let count = 0;
    for (let i = 0; i < use.inputs.length; i++) {
      if (use.inputs[i] === oldValue) {
        use.inputs[i] = newValue;
        count++;
      }
    }
    if (count > 0) {
      oldValue.uses = oldValue.uses.filter((candidate) => candidate !== use);
      for (let i = 0; i < count; i++) newValue.uses.push(use);
    }
  }
}

function removeNodes(graph: IRGraphLike, nodes: IRNodeLike[]): void {
  const removeSet = new Set(nodes);
  for (const block of graph.blocks) {
    const kept: IRNodeLike[] = [];
    for (const node of block.nodes) {
      if (removeSet.has(node)) {
        detachInputs(node);
        node.uses = [];
        node.block = null;
      } else {
        kept.push(node);
      }
    }
    block.nodes = kept;
  }
}

function rewriteBranchAsJump(
  block: IRBlockLike,
  term: IRNodeLike,
  targetBlockId: number,
  deadBlockId: number,
  blockById: Map<number, IRBlockLike>,
): void {
  detachInputs(term);
  term.type = ir.IR_JUMP;
  term.opcode = ir.IR_JUMP;
  term.props = { targetBlock: targetBlockId };
  term.metadata = term.props;
  block.successors = block.successors.filter(
    (successor) => successor.id === targetBlockId,
  );
  if (block.edgeArgs) {
    for (const key of [...block.edgeArgs.keys()]) {
      if (key !== targetBlockId) block.edgeArgs.delete(key);
    }
  }
  const deadBlock = blockById.get(deadBlockId);
  if (deadBlock) {
    deadBlock.predecessors = deadBlock.predecessors.filter(
      (predecessor) => predecessor.id !== block.id,
    );
  }
}

export function eliminateRedundantChecks(graph: IRGraphLike): number {
  const dominators = computeDominators(graph);
  const { children } = buildDominatorTree(graph, dominators);
  let elimCount = 0;

  const checkKey = (node: IRNodeLike): string | null => {
    if (node.type === ir.IR_CHECK_MAP && node.inputs[0]) {
      return `map_${node.inputs[0].id}_${String(node.props.expectedMapId)}_${String(node.props.expectedMapVersion ?? "any")}`;
    } else if (node.type === ir.IR_CHECK_SMI && node.inputs[0]) {
      return `smi_${node.inputs[0].id}`;
    } else if (node.type === ir.IR_CHECK_NUMBER && node.inputs[0]) {
      return `num_${node.inputs[0].id}`;
    } else if (node.type === ir.IR_CHECK_ELEMENTS_KIND && node.inputs[0]) {
      return `elements_${node.inputs[0].id}_${String(node.props.elementsKind)}`;
    }
    return null;
  };

  const walkBlock = (
    block: IRBlockLike,
    inherited: Map<string, IRNodeLike>,
  ): void => {
    const seenChecks = new Map<string, IRNodeLike>(inherited);
    const toRemove: IRNodeLike[] = [];

    for (const node of block.nodes) {
      const key = checkKey(node);
      if (key !== null) {
        if (seenChecks.has(key)) {
          const original = seenChecks.get(key)!;
          replaceValue(node, original);
          replaceGraphFrameStateValue(
            graph,
            node,
            original,
          );
          toRemove.push(node);
          elimCount++;
        } else {
          seenChecks.set(key, node);
        }
      }
    }

    if (toRemove.length > 0) {
      removeNodes(graph, toRemove);
    }

    const childBlocks = children.get(block) as IRBlockLike[] | undefined;
    for (const child of childBlocks || []) {
      walkBlock(child, seenChecks);
    }
  };

  const entry = graph.blocks[0];
  if (entry) walkBlock(entry, new Map());
  return elimCount;
}

export function rangeAnalysisAndBoundsCheckElimination(graph: IRGraphLike): number {
  const blockById = new Map<number, IRBlockLike>();
  for (const block of graph.blocks) blockById.set(block.id, block);
  const ranges = new Map<number, Range>();
  const INF = 0x7fffffff;
  const NEG_INF = -0x80000000;

  const setRange = (id: number, min: number, max: number): void => {
    ranges.set(id, { min, max });
  };
  const getRange = (id: number): Range =>
    ranges.get(id) || { min: NEG_INF, max: INF };

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      switch (node.type) {
        case ir.IR_CONSTANT: {
          const v = node.props.value;
          if (typeof v === "number" && Number.isInteger(v)) {
            setRange(node.id, v, v);
          }
          break;
        }
        case ir.IR_PARAMETER:
          setRange(node.id, NEG_INF, INF);
          break;

        case ir.IR_CHECK_SMI:
        case ir.IR_CHECK_NUMBER: {
          if (node.inputs[0]) {
            const r = getRange(node.inputs[0].id);
            setRange(node.id, r.min, r.max);
          }
          break;
        }
        case ir.IR_CHECK_ELEMENTS_KIND:
          if (node.inputs[0]) {
            const r = getRange(node.inputs[0].id);
            setRange(node.id, r.min, r.max);
          }
          break;

        case ir.IR_INT32_ADD: {
          if (node.inputs.length === 2) {
            const l = getRange(node.inputs[0].id);
            const r = getRange(node.inputs[1].id);
            const lo = l.min + r.min;
            const hi = l.max + r.max;
            setRange(
              node.id,
              lo >= NEG_INF ? lo : NEG_INF,
              hi <= INF ? hi : INF,
            );
          }
          break;
        }
        case ir.IR_INT32_SUB: {
          if (node.inputs.length === 2) {
            const l = getRange(node.inputs[0].id);
            const r = getRange(node.inputs[1].id);
            const lo = l.min - r.max;
            const hi = l.max - r.min;
            setRange(
              node.id,
              lo >= NEG_INF ? lo : NEG_INF,
              hi <= INF ? hi : INF,
            );
          }
          break;
        }
        case ir.IR_INT32_MUL: {
          if (node.inputs.length === 2) {
            const l = getRange(node.inputs[0].id);
            const r = getRange(node.inputs[1].id);
            if (l.min >= 0 && r.min >= 0) {
              const hi =
                l.max <= INF && r.max <= INF
                  ? Math.min(l.max * r.max, INF)
                  : INF;
              setRange(node.id, l.min * r.min, hi);
            } else if (l.min === l.max) {
              const c = l.min;
              if (c >= 0) {
                setRange(
                  node.id,
                  Math.max(c * r.min, NEG_INF),
                  Math.min(c * r.max, INF),
                );
              } else {
                setRange(
                  node.id,
                  Math.max(c * r.max, NEG_INF),
                  Math.min(c * r.min, INF),
                );
              }
            } else if (r.min === r.max) {
              const c = r.min;
              if (c >= 0) {
                setRange(
                  node.id,
                  Math.max(c * l.min, NEG_INF),
                  Math.min(c * l.max, INF),
                );
              } else {
                setRange(
                  node.id,
                  Math.max(c * l.max, NEG_INF),
                  Math.min(c * l.min, INF),
                );
              }
            } else {
              const corners = [
                l.min * r.min,
                l.min * r.max,
                l.max * r.min,
                l.max * r.max,
              ];
              setRange(
                node.id,
                Math.max(Math.min(...corners), NEG_INF),
                Math.min(Math.max(...corners), INF),
              );
            }
          }
          break;
        }
        case ir.IR_INT32_DIV: {
          if (node.inputs.length === 2) {
            const l = getRange(node.inputs[0].id);
            const r = getRange(node.inputs[1].id);
            if (r.min > 0 || r.max < 0) {
              const corners = [
                Math.trunc(l.min / r.min),
                Math.trunc(l.min / r.max),
                Math.trunc(l.max / r.min),
                Math.trunc(l.max / r.max),
              ];
              setRange(
                node.id,
                Math.max(Math.min(...corners), NEG_INF),
                Math.min(Math.max(...corners), INF),
              );
            } else if (r.min === 0 && r.max > 0) {
              const corners = [
                Math.trunc(l.min / 1),
                Math.trunc(l.min / r.max),
                Math.trunc(l.max / 1),
                Math.trunc(l.max / r.max),
              ];
              setRange(
                node.id,
                Math.max(Math.min(...corners), NEG_INF),
                Math.min(Math.max(...corners), INF),
              );
            } else if (r.min < 0 && r.max === 0) {
              const corners = [
                Math.trunc(l.min / r.min),
                Math.trunc(l.min / -1),
                Math.trunc(l.max / r.min),
                Math.trunc(l.max / -1),
              ];
              setRange(
                node.id,
                Math.max(Math.min(...corners), NEG_INF),
                Math.min(Math.max(...corners), INF),
              );
            } else {
              setRange(node.id, NEG_INF, INF);
            }
          }
          break;
        }
        case ir.IR_INT32_MOD: {
          if (node.inputs.length === 2) {
            const l = getRange(node.inputs[0].id);
            const r = getRange(node.inputs[1].id);
            if (l.min >= 0 && r.min > 0) {
              setRange(node.id, 0, r.max - 1);
            } else if (r.min > 0 || r.max < 0) {
              const absMax = Math.max(Math.abs(r.min), Math.abs(r.max));
              setRange(node.id, -(absMax - 1), absMax - 1);
            } else {
              setRange(node.id, NEG_INF, INF);
            }
          }
          break;
        }

        case ir.IR_PHI: {
          let lo = INF,
            hi = NEG_INF;
          for (const inp of node.inputs) {
            const r = getRange(inp.id);
            if (r.min < lo) lo = r.min;
            if (r.max > hi) hi = r.max;
          }
          setRange(node.id, lo, hi);
          break;
        }

        case ir.IR_LOAD_FIELD:
        case ir.IR_LOAD_ELEMENT:
          setRange(node.id, NEG_INF, INF);
          break;
      }
    }
  }

  const preNarrowRanges = new Map<number, Range>();
  for (const [id, r] of ranges) {
    preNarrowRanges.set(id, { min: r.min, max: r.max });
  }
  const getPreNarrowRange = (id: number): Range =>
    preNarrowRanges.get(id) || { min: NEG_INF, max: INF };

  const narrowRange = (
    _block: IRBlockLike,
    leftId: number,
    newMin: number,
    newMax: number,
  ): void => {
    const cur = getRange(leftId);
    setRange(
      leftId,
      Math.max(newMin, cur.min),
      Math.min(newMax, cur.max === INF ? newMax : cur.max),
    );
  };

  for (const block of graph.blocks) {
    const term = block.nodes[block.nodes.length - 1];
    if (!term || term.type !== ir.IR_BRANCH) continue;
    if (!term.inputs[0]) continue;

    const cmpNode = term.inputs[0];
    if (
      cmpNode.type !== ir.IR_INT32_COMPARE &&
      cmpNode.type !== ir.IR_FLOAT64_COMPARE
    )
      continue;
    if (cmpNode.inputs.length < 2) continue;

    const op = String(cmpNode.props.op);
    const leftId = cmpNode.inputs[0].id;
    const rightId = cmpNode.inputs[1].id;
    const rightRange = getRange(rightId);
    const leftRange = getRange(leftId);

    const trueBlockId = term.props.trueBlock as number;
    const falseBlockId = term.props.falseBlock as number;
    const trueBlock = blockById.get(trueBlockId);
    const falseBlock = blockById.get(falseBlockId);

    if (op === "<") {
      if (trueBlock && rightRange.max < INF) {
        narrowRange(trueBlock, leftId, leftRange.min, rightRange.max - 1);
      }
      if (falseBlock && rightRange.min > NEG_INF) {
        narrowRange(falseBlock, leftId, rightRange.min, leftRange.max);
      }
    } else if (op === "<=") {
      if (trueBlock && rightRange.max < INF) {
        narrowRange(trueBlock, leftId, leftRange.min, rightRange.max);
      }
      if (falseBlock && rightRange.min > NEG_INF) {
        narrowRange(falseBlock, leftId, rightRange.min + 1, leftRange.max);
      }
    } else if (op === ">") {
      if (trueBlock && rightRange.min > NEG_INF) {
        narrowRange(trueBlock, leftId, rightRange.min + 1, leftRange.max);
      }
      if (falseBlock && rightRange.max < INF) {
        narrowRange(falseBlock, leftId, leftRange.min, rightRange.max);
      }
    } else if (op === ">=") {
      if (trueBlock && rightRange.min > NEG_INF) {
        narrowRange(trueBlock, leftId, rightRange.min, leftRange.max);
      }
      if (falseBlock && rightRange.max < INF) {
        narrowRange(falseBlock, leftId, leftRange.min, rightRange.max - 1);
      }
    }
  }

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (
        node.type === ir.IR_INT32_ADD ||
        node.type === ir.IR_INT32_SUB ||
        node.type === ir.IR_INT32_MUL
      ) {
        const r = getRange(node.id);
        if (
          r.min >= NEG_INF &&
          r.max <= INF &&
          r.min > -2147483648 &&
          r.max < 2147483647
        ) {
          if (!node.props) node.props = {};
          node.props.noOverflow = true;
        }
      }
    }
  }

  let branchElimCount = 0;
  for (const block of graph.blocks) {
    const term = block.nodes[block.nodes.length - 1];
    if (!term || term.type !== ir.IR_BRANCH) continue;
    if (!term.inputs[0]) continue;
    const cmpNode = term.inputs[0];
    if (cmpNode.type !== ir.IR_INT32_COMPARE) continue;
    if (cmpNode.inputs.length < 2) continue;

    const op = String(cmpNode.props.op);
    const l = getPreNarrowRange(cmpNode.inputs[0].id);
    const r = getPreNarrowRange(cmpNode.inputs[1].id);
    if (
      l.min === NEG_INF ||
      l.max === INF ||
      r.min === NEG_INF ||
      r.max === INF
    )
      continue;

    let alwaysTrue = false;
    let alwaysFalse = false;

    if (op === "<") {
      if (l.max < r.min) alwaysTrue = true;
      else if (l.min >= r.max) alwaysFalse = true;
    } else if (op === "<=") {
      if (l.max <= r.min) alwaysTrue = true;
      else if (l.min > r.max) alwaysFalse = true;
    } else if (op === ">") {
      if (l.min > r.max) alwaysTrue = true;
      else if (l.max <= r.min) alwaysFalse = true;
    } else if (op === ">=") {
      if (l.min >= r.max) alwaysTrue = true;
      else if (l.max < r.min) alwaysFalse = true;
    } else if (op === "==") {
      if (l.min === l.max && r.min === r.max && l.min === r.min)
        alwaysTrue = true;
      else if (l.max < r.min || l.min > r.max) alwaysFalse = true;
    } else if (op === "!=") {
      if (l.max < r.min || l.min > r.max) alwaysTrue = true;
      else if (l.min === l.max && r.min === r.max && l.min === r.min)
        alwaysFalse = true;
    }

    if (alwaysTrue || alwaysFalse) {
      const targetBlockId = alwaysTrue
        ? (term.props.trueBlock as number)
        : (term.props.falseBlock as number);
      const deadBlockId = alwaysTrue
        ? (term.props.falseBlock as number)
        : (term.props.trueBlock as number);
      rewriteBranchAsJump(block, term, targetBlockId, deadBlockId, blockById);
      branchElimCount++;
      tracer.jitCompile(
        "",
        `BranchElim: folded Branch(${op}) → Jump to B${targetBlockId}`,
      );
    }
  }

  let elimCount = 0;

  const loopHeaderBlocks = new Set<number>();
  for (const block of graph.blocks) {
    if (block.isLoopHeader) loopHeaderBlocks.add(block.id);
  }
  const boundsChecksToRemove: IRNodeLike[] = [];

  function detectInductionVariable(phiNode: IRNodeLike): InductionVariable | null {
    if (phiNode.type !== ir.IR_PHI || phiNode.inputs.length !== 2) return null;

    const inp0 = phiNode.inputs[0];
    const inp1 = phiNode.inputs[1];
    let initNode: IRNodeLike | null = null;
    let stepNode: IRNodeLike | null = null;

    if (inp1.type === ir.IR_INT32_ADD && inp1.inputs.some((i) => i === phiNode)) {
      initNode = inp0;
      stepNode = inp1;
    } else if (
      inp0.type === ir.IR_INT32_ADD &&
      inp0.inputs.some((i) => i === phiNode)
    ) {
      initNode = inp1;
      stepNode = inp0;
    }

    if (!initNode || !stepNode) return null;

    const stepInc = stepNode.inputs.find((i) => i !== phiNode);
    if (!stepInc) return null;

    const initRange = getRange(initNode.id);
    const stepRange = getRange(stepInc.id);

    if (initRange.min < 0 || stepRange.min <= 0) return null;

    return { phi: phiNode, initNode, stepNode, stepInc, initRange, stepRange };
  }

  const loopGuardIndex = new Map<number, LoopGuardEntry>();
  for (const b of graph.blocks) {
    const term = b.nodes[b.nodes.length - 1];
    if (!term || term.type !== ir.IR_BRANCH || !term.inputs[0]) continue;
    const cmp = term.inputs[0];
    if (cmp.type !== ir.IR_INT32_COMPARE && cmp.type !== ir.IR_FLOAT64_COMPARE)
      continue;
    if (cmp.inputs.length < 2) continue;
    if (cmp.props.op !== "<" && cmp.props.op !== "<=") continue;
    const phiId = cmp.inputs[0].id;
    if (!loopGuardIndex.has(phiId)) {
      loopGuardIndex.set(phiId, {
        guardBlock: b,
        cmp,
        bound: cmp.inputs[1],
        op: String(cmp.props.op),
      });
    }
  }

  function findLoopGuard(iv: InductionVariable): LoopGuardEntry | null {
    const entry = loopGuardIndex.get(iv.phi.id);
    if (!entry) return null;
    const { bound } = entry;
    if (bound.type === "LoadArrayLength") return entry;
    const boundRange = getRange(bound.id);
    if (boundRange.max < INF) return entry;
    return null;
  }

  for (const block of graph.blocks) {
    if (!block.isLoopHeader) continue;
    for (const phi of block.params) {
      const iv = detectInductionVariable(phi);
      if (!iv) continue;
      const guardEntry = loopGuardIndex.get(phi.id);
      if (!guardEntry) continue;
      const boundRange = getRange(guardEntry.bound.id);
      if (boundRange.max >= INF) continue;
      const phiMin = iv.initRange.min;
      const phiMax =
        guardEntry.op === "<" ? boundRange.max : boundRange.max + 1;
      const stepMax = phiMax + iv.stepRange.max;
      if (phiMin <= NEG_INF || stepMax >= INF) continue;
      if (!iv.stepNode.props) iv.stepNode.props = {};
      iv.stepNode.props.noOverflow = true;
    }
  }

  const arrayLengthNodes = new Map<number, IRNodeLike[]>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === "LoadArrayLength" && node.inputs[0]) {
        const arrId = node.inputs[0].id;
        if (!arrayLengthNodes.has(arrId)) arrayLengthNodes.set(arrId, []);
        arrayLengthNodes.get(arrId)!.push(node);
      }
    }
  }

  for (const block of graph.blocks) {
    for (let i = 0; i < block.nodes.length; i++) {
      const node = block.nodes[i];
      if (node.type !== ir.IR_CHECK_BOUNDS) continue;
      if (node.inputs.length < 2) continue;

      const indexNode = node.inputs[0];
      const arrayNode = node.inputs[1];
      const indexRange = getRange(indexNode.id);

      if (indexRange.min >= 0 && indexRange.max >= 0 && indexRange.max < INF) {
        let bounded = false;

        for (const pred of block.predecessors) {
          const predTerm = pred.nodes[pred.nodes.length - 1];
          if (predTerm && predTerm.type === ir.IR_BRANCH && predTerm.inputs[0]) {
            const cmp = predTerm.inputs[0];
            if (
              (cmp.type === ir.IR_INT32_COMPARE ||
                cmp.type === ir.IR_FLOAT64_COMPARE) &&
              (cmp.props.op === "<" || cmp.props.op === "<=") &&
              cmp.inputs[0] &&
              cmp.inputs[1]
            ) {
              if (
                cmp.inputs[0].id === indexNode.id ||
                cmp.inputs[0] === indexNode
              ) {
                if (predTerm.props.trueBlock === block.id) {
                  bounded = true;
                  break;
                }
              }
            }
          }
        }

        if (!bounded) {
          const iv = detectInductionVariable(indexNode);
          if (iv) {
            const guard = findLoopGuard(iv);
            if (guard) {
              bounded = true;
              tracer.jitCompile(
                "",
                `BCE-IV: index v${indexNode.id} is IV(init≥${iv.initRange.min}, step≥${iv.stepRange.min}) guarded by ${guard.op} at B${guard.guardBlock.id}`,
              );
            }
          }
        }

        if (!bounded && indexRange.min >= 0 && indexRange.max < INF) {
          const lenNodes = arrayLengthNodes.get(arrayNode.id) || [];
          for (const n of lenNodes) {
            const lenRange = getRange(n.id);
            if (lenRange.min > indexRange.max) {
              bounded = true;
              tracer.jitCompile(
                "",
                `BCE-Range: index [${indexRange.min},${indexRange.max}] < array.length [${lenRange.min},${lenRange.max}]`,
              );
              break;
            }
          }
        }

        if (bounded && indexRange.min >= 0) {
          replaceValue(node, indexNode);
          replaceGraphFrameStateValue(
            graph as Parameters<typeof replaceGraphFrameStateValue>[0],
            node,
            indexNode,
          );
          boundsChecksToRemove.push(node);
          elimCount++;
          tracer.jitCompile(
            "",
            `RangeAnalysis: eliminated CheckBounds (index range [${indexRange.min},${indexRange.max}])`,
          );
        }
      }
    }
  }

  if (boundsChecksToRemove.length > 0) {
    removeNodes(graph, boundsChecksToRemove);
  }

  if (elimCount > 0) {
    removeDeadPureNodes(graph);
  }

  return elimCount + branchElimCount;
}

function removeDeadPureNodes(graph: IRGraphLike): void {
  let changed = true;
  while (changed) {
    changed = false;
    const toRemove: IRNodeLike[] = [];
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (isDeadPureNode(node)) toRemove.push(node);
      }
    }
    if (toRemove.length > 0) {
      removeNodes(graph, toRemove);
      changed = true;
    }
  }
}

function isDeadPureNode(node: IRNodeLike): boolean {
  if (node.uses.length > 0) return false;
  if (node.inputs.length === 0) return false;
  if (node.effectKind !== "none") return false;
  return (
    node.type !== ir.IR_RETURN &&
    node.type !== ir.IR_BRANCH &&
    node.type !== ir.IR_JUMP &&
    node.type !== ir.IR_DEOPTIMIZE &&
    node.type !== ir.IR_PARAMETER &&
    node.type !== ir.IR_CONSTANT &&
    node.type !== ir.IR_PHI
  );
}
