import * as ir from "../ir/index.js";

import { tracer } from "../../core/tracing/index.js";
import { detachInputs, replaceValueUses, retainNodes } from "../ir/graph-edit.js";
import { INT32_SHIFT_MASK } from "../target/integer.js";

type SimplifyNode = ir.CFGInstruction;
type SimplifyBlock = ir.CFGBlock;
type SimplifyGraph = ir.CFGFunction;

function producesBoolean(node: SimplifyNode | undefined): boolean {
  if (!node) return false;
  if (node.type === ir.IR_CONSTANT) return typeof node.props.value === "boolean";
  return ir.alwaysProducesBoolean(node.type);
}

function constantInput(node: SimplifyNode, index: number): ir.IRMetadataValue | undefined {
  const input = node.inputs[index];
  return input?.type === ir.IR_CONSTANT ? input.props.value : undefined;
}

function identityOperand(node: SimplifyNode, neutral: number): SimplifyNode | null {
  if (node.inputs.length !== 2) return null;
  if (constantInput(node, 1) === neutral) return node.inputs[0]!;
  if (constantInput(node, 0) === neutral) return node.inputs[1]!;
  return null;
}

function involution(node: SimplifyNode, opcode: string): SimplifyNode | null {
  if (node.inputs.length !== 1) return null;
  const input = node.inputs[0]!;
  return input.type === opcode ? (input.inputs[0] ?? null) : null;
}

function simplified(node: SimplifyNode): SimplifyNode | null {
  if (node.type === ir.IR_INT32_ADD || node.type === ir.IR_FLOAT64_ADD) {
    return identityOperand(node, 0);
  }
  if (node.type === ir.IR_INT32_MUL || node.type === ir.IR_FLOAT64_MUL) {
    return identityOperand(node, 1);
  }
  if (node.type === ir.IR_NEG) return involution(node, ir.IR_NEG);
  if (node.type === ir.IR_NOT) {
    const inner = involution(node, ir.IR_NOT);
    return inner !== null && producesBoolean(inner) ? inner : null;
  }
  return null;
}

export function algebraicSimplification(graph: SimplifyGraph): number {
  let count = 0;
  let changed = true;

  while (changed) {
    changed = false;
    for (const block of graph.blocks) {
      const dead = new Set<SimplifyNode>();
      for (const node of block.nodes) {
        const replacement = simplified(node);
        if (replacement === null) continue;
        replaceValueUses(graph, node, replacement);
        detachInputs(node);
        node.block = null;
        dead.add(node);
        count++;
        changed = true;
      }
      retainNodes(block, dead);
    }
  }

  return count;
}

interface MultiplierDecomposition {
  shift: number;
  op: "add" | "sub";
}

export function strengthReduction(graph: SimplifyGraph): number {
  let count = 0;

  function isPowerOf2(n: ir.IRMetadataValue): n is number {
    return (
      typeof n === "number" &&
      Number.isInteger(n) &&
      n > 0 &&
      (n & (n - 1)) === 0
    );
  }

  function log2(n: number): number {
    let p = 0;
    while (1 << p < n) p++;
    return p;
  }

  function decomposeMultiplier(c: ir.IRMetadataValue): MultiplierDecomposition | null {
    if (typeof c !== "number" || !Number.isInteger(c) || c <= 1) return null;
    if (isPowerOf2(c)) return null;

    const cMinus1 = c - 1;
    if (cMinus1 > 0 && isPowerOf2(cMinus1)) {
      return { shift: log2(cMinus1), op: "add" };
    }

    const cPlus1 = c + 1;
    if (cPlus1 > 0 && isPowerOf2(cPlus1)) {
      return { shift: log2(cPlus1), op: "sub" };
    }

    return null;
  }

  const replaceInPlace = (
    node: SimplifyNode,
    replacement: SimplifyNode,
    block: SimplifyBlock,
    index: number,
  ): void => {
    replaceValueUses(graph, node, replacement);
    replacement.block = block;
    block.nodes[index] = replacement;
  };

  const replaceWithSequence = (
    node: SimplifyNode,
    sequence: SimplifyNode[],
    block: SimplifyBlock,
    index: number,
  ): void => {
    const replacement = sequence[sequence.length - 1]!;
    replaceValueUses(graph, node, replacement);
    for (const item of sequence) item.block = block;
    block.nodes.splice(index, 1, ...sequence);
  };

  for (const block of graph.blocks) {
    for (let i = 0; i < block.nodes.length; i++) {
      const node = block.nodes[i];

      if (
        node.type === ir.IR_INT32_MUL &&
        node.inputs.length === 2 &&
        node.props.noOverflow === true
      ) {
        let constInput: SimplifyNode | null = null;
        let otherInput: SimplifyNode | null = null;
        if (node.inputs[1]?.type === ir.IR_CONSTANT) {
          constInput = node.inputs[1];
          otherInput = node.inputs[0];
        } else if (node.inputs[0]?.type === ir.IR_CONSTANT) {
          constInput = node.inputs[0];
          otherInput = node.inputs[1];
        }

        if (constInput && otherInput) {
          const c = constInput.props.value;

          if (isPowerOf2(c)) {
            const shift = log2(c);
            if (shift > 0 && shift < INT32_SHIFT_MASK) {
              const shlNode = ir.irInt32Shl(otherInput, ir.irConstant(shift));
              shlNode.frameState = node.frameState;
              replaceInPlace(node, shlNode, block, i);
              tracer.jitCompile(
                graph.name,
                `StrengthReduce: v${node.id} Int32Mul * ${c} → Int32Shl by ${shift}`,
              );
              count++;
              continue;
            }
          }

          const decomp = decomposeMultiplier(c);
          if (decomp && decomp.shift > 0 && decomp.shift < INT32_SHIFT_MASK) {
            const shifted = ir.irInt32Shl(otherInput, ir.irConstant(decomp.shift));
            let result: SimplifyNode;
            if (decomp.op === "add") {
              result = ir.irInt32Add(shifted, otherInput);
            } else {
              result = ir.irInt32Sub(shifted, otherInput);
            }
            result.props.noOverflow = true;
            result.frameState = node.frameState;
            replaceWithSequence(node, [shifted, result], block, i);
            tracer.jitCompile(
              graph.name,
              `StrengthReduce: v${node.id} Int32Mul * ${String(c)} → (x << ${decomp.shift}) ${decomp.op === "add" ? "+" : "-"} x`,
            );
            count++;
            continue;
          }
        }
      }

      if (
        node.type === ir.IR_INT32_SUB &&
        node.inputs.length === 2 &&
        node.inputs[0] === node.inputs[1]
      ) {
        const result = ir.irConstant(0);
        replaceInPlace(node, result, block, i);
        count++;
      }
    }
  }

  return count;
}
