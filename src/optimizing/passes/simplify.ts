import * as ir from "../ir/index.js";

import { tracer } from "../../core/tracing/index.js";
import { replaceGraphFrameStateValue } from "./frame-state-values.js";

type SimplifyNode = ir.CFGInstruction;
type SimplifyBlock = ir.CFGBlock;
type SimplifyGraph = ir.CFGFunction;

type BinaryNumberFolder = (a: number, b: number) => number;
type CompareFolder = (a: number, b: number) => boolean;

function nodeFromIr(value: ir.CFGInstruction): SimplifyNode {
  return value;
}

const BOOLEAN_PRODUCING = new Set([
  ir.IR_NOT,
  ir.IR_INT32_COMPARE,
  ir.IR_FLOAT64_COMPARE,
  ir.IR_GENERIC_COMPARE,
  ir.IR_GENERIC_INSTANCEOF,
  ir.IR_GENERIC_IN,
  ir.IR_CHECK_CALL_TARGET,
]);

function producesBoolean(node: SimplifyNode | undefined): boolean {
  if (!node) return false;
  if (node.type === ir.IR_CONSTANT) return typeof node.props.value === "boolean";
  return BOOLEAN_PRODUCING.has(node.type);
}

function rewireUses(
  graph: SimplifyGraph,
  node: SimplifyNode,
  replacement: SimplifyNode,
): void {
  for (const use of node.uses) {
    for (let j = 0; j < use.inputs.length; j++) {
      if (use.inputs[j] === node) {
        use.inputs[j] = replacement;
        replacement.uses.push(use);
      }
    }
  }
  for (const inp of node.inputs) {
    if (inp) inp.uses = inp.uses.filter((u) => u !== node);
  }
  replaceGraphFrameStateValue(graph, node, replacement);
}

export function constantFolding(graph: SimplifyGraph): number {
  const ARITH_OPS: Record<string, BinaryNumberFolder> = {
    [ir.IR_INT32_ADD]: (a, b) => (a + b) | 0,
    [ir.IR_INT32_SUB]: (a, b) => (a - b) | 0,
    [ir.IR_INT32_MUL]: (a, b) => Math.imul(a, b),
    [ir.IR_INT32_DIV]: (a, b) => (b !== 0 ? (a / b) | 0 : a / b),
    [ir.IR_INT32_MOD]: (a, b) => a % b,
    [ir.IR_INT32_SHL]: (a, b) => (a << b) | 0,
    [ir.IR_INT32_SHR]: (a, b) => (a >> b) | 0,
    [ir.IR_INT32_AND]: (a, b) => (a & b) | 0,
    [ir.IR_FLOAT64_ADD]: (a, b) => a + b,
    [ir.IR_FLOAT64_SUB]: (a, b) => a - b,
    [ir.IR_FLOAT64_MUL]: (a, b) => a * b,
    [ir.IR_FLOAT64_DIV]: (a, b) => a / b,
  };

  const COMPARE_OPS: Record<string, CompareFolder> = {
    "==": (a, b) => a === b,
    "!=": (a, b) => a !== b,
    "loose==": (a, b) => a == b,
    "loose!=": (a, b) => a != b,
    "<": (a, b) => a < b,
    ">": (a, b) => a > b,
    "<=": (a, b) => a <= b,
    ">=": (a, b) => a >= b,
  };

  let foldCount = 0;
  const dead = new Set<SimplifyNode>();

  const replaceInPlace = (
    node: SimplifyNode,
    replacement: SimplifyNode,
    block: SimplifyBlock,
    index: number,
  ): void => {
    rewireUses(graph, node, replacement);
    replacement.block = block;
    block.nodes[index] = replacement;
    foldCount++;
  };

  const bypassWith = (node: SimplifyNode, replacement: SimplifyNode): void => {
    rewireUses(graph, node, replacement);
    dead.add(node);
    foldCount++;
  };

  let changed = true;
  while (changed) {
    changed = false;
    dead.clear();

    for (const block of graph.blocks) {
      for (let i = 0; i < block.nodes.length; i++) {
        const node = block.nodes[i];

        const folder = ARITH_OPS[node.type];
        if (
          folder &&
          node.inputs.length === 2 &&
          node.inputs[0]?.type === ir.IR_CONSTANT &&
          node.inputs[1]?.type === ir.IR_CONSTANT
        ) {
          const a = node.inputs[0].props.value;
          const b = node.inputs[1].props.value;
          if (typeof a === "number" && typeof b === "number") {
            replaceInPlace(node, nodeFromIr(ir.irConstant(folder(a, b))), block, i);
            changed = true;
            continue;
          }
        }

        if (
          (node.type === ir.IR_INT32_COMPARE ||
            node.type === ir.IR_FLOAT64_COMPARE) &&
          node.inputs.length === 2 &&
          node.inputs[0]?.type === ir.IR_CONSTANT &&
          node.inputs[1]?.type === ir.IR_CONSTANT
        ) {
          const a = node.inputs[0].props.value;
          const b = node.inputs[1].props.value;
          const op = node.props.op;
          const cmpFn = typeof op === "string" ? COMPARE_OPS[op] : undefined;
          if (typeof a === "number" && typeof b === "number" && cmpFn) {
            replaceInPlace(
              node,
              nodeFromIr(ir.irConstant(!!cmpFn(a, b))),
              block,
              i,
            );
            changed = true;
            continue;
          }
        }

        if (
          node.type === ir.IR_NOT &&
          node.inputs.length === 1 &&
          node.inputs[0]?.type === ir.IR_CONSTANT
        ) {
          replaceInPlace(
            node,
            nodeFromIr(ir.irConstant(!node.inputs[0].props.value)),
            block,
            i,
          );
          changed = true;
          continue;
        }

        if (
          node.type === ir.IR_NEG &&
          node.inputs.length === 1 &&
          node.inputs[0]?.type === ir.IR_CONSTANT
        ) {
          const val = node.inputs[0].props.value;
          if (typeof val === "number") {
            replaceInPlace(node, nodeFromIr(ir.irConstant(-val)), block, i);
            changed = true;
            continue;
          }
        }

        if (
          (node.type === ir.IR_INT32_ADD || node.type === ir.IR_FLOAT64_ADD) &&
          node.inputs.length === 2
        ) {
          if (
            node.inputs[1]?.type === ir.IR_CONSTANT &&
            node.inputs[1].props.value === 0
          ) {
            bypassWith(node, node.inputs[0]);
            changed = true;
            continue;
          }
          if (
            node.inputs[0]?.type === ir.IR_CONSTANT &&
            node.inputs[0].props.value === 0
          ) {
            bypassWith(node, node.inputs[1]);
            changed = true;
            continue;
          }
        }

        if (
          (node.type === ir.IR_INT32_MUL || node.type === ir.IR_FLOAT64_MUL) &&
          node.inputs.length === 2
        ) {
          if (
            node.inputs[1]?.type === ir.IR_CONSTANT &&
            node.inputs[1].props.value === 1
          ) {
            bypassWith(node, node.inputs[0]);
            changed = true;
            continue;
          }
          if (
            node.inputs[0]?.type === ir.IR_CONSTANT &&
            node.inputs[0].props.value === 1
          ) {
            bypassWith(node, node.inputs[1]);
            changed = true;
            continue;
          }
          if (
            (node.inputs[0]?.type === ir.IR_CONSTANT &&
              node.inputs[0].props.value === 0) ||
            (node.inputs[1]?.type === ir.IR_CONSTANT &&
              node.inputs[1].props.value === 0)
          ) {
            replaceInPlace(node, nodeFromIr(ir.irConstant(0)), block, i);
            changed = true;
            continue;
          }
        }

        if (
          node.type === ir.IR_NEG &&
          node.inputs.length === 1 &&
          node.inputs[0]?.type === ir.IR_NEG
        ) {
          bypassWith(node, node.inputs[0].inputs[0]);
          changed = true;
          continue;
        }

        if (
          node.type === ir.IR_NOT &&
          node.inputs.length === 1 &&
          node.inputs[0]?.type === ir.IR_NOT &&
          producesBoolean(node.inputs[0].inputs[0])
        ) {
          bypassWith(node, node.inputs[0].inputs[0]);
          changed = true;
          continue;
        }

        if (
          node.type === ir.IR_GENERIC_ADD &&
          node.inputs.length === 2 &&
          node.inputs[0]?.type === ir.IR_CONSTANT &&
          node.inputs[1]?.type === ir.IR_CONSTANT
        ) {
          const a = node.inputs[0].props.value;
          const b = node.inputs[1].props.value;
          if (typeof a === "string" && typeof b === "string") {
            replaceInPlace(node, nodeFromIr(ir.irConstant(a + b)), block, i);
            tracer.jitCompile(
              graph.name,
              `ConstantFold: string concat "${a}" + "${b}" → "${a + b}"`,
            );
            changed = true;
            continue;
          }
        }
      }

      if (dead.size > 0) {
        block.nodes = block.nodes.filter((n) => !dead.has(n));
        dead.clear();
      }
    }
  }

  return foldCount;
}

export function constantPropagation(graph: SimplifyGraph): number {
  let propCount = 0;
  const knownValues = new Map<ir.IRMetadataValue, SimplifyNode>();

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (
        node.type === ir.IR_STORE_LOCAL &&
        node.inputs.length === 1 &&
        node.inputs[0]?.type === ir.IR_CONSTANT
      ) {
        knownValues.set(node.props.slot, node.inputs[0]);
      }

      if (
        node.type === ir.IR_STORE_LOCAL &&
        node.inputs.length === 1 &&
        node.inputs[0]?.type !== ir.IR_CONSTANT
      ) {
        knownValues.delete(node.props.slot);
      }
    }
  }

  for (const block of graph.blocks) {
    const localState = new Map(knownValues);

    for (const node of block.nodes) {
      if (node.type === ir.IR_STORE_LOCAL && node.inputs.length === 1) {
        if (node.inputs[0]?.type === ir.IR_CONSTANT) {
          localState.set(node.props.slot, node.inputs[0]);
        } else {
          localState.delete(node.props.slot);
        }
        continue;
      }

      if (node.type === ir.IR_LOAD_LOCAL) {
        const known = localState.get(node.props.slot);
        if (known && known.type === ir.IR_CONSTANT) {
          rewireUses(graph, node, known);
          propCount++;
        }
        continue;
      }

      for (let k = 0; k < node.inputs.length; k++) {
        const inp = node.inputs[k];
        if (
          inp &&
          inp.type === ir.IR_CHECK_SMI &&
          inp.inputs[0]?.type === ir.IR_CONSTANT
        ) {
          const val = inp.inputs[0].props.value;
          if (
            typeof val === "number" &&
            Number.isInteger(val) &&
            val === (val | 0)
          ) {
            const replacement = inp.inputs[0];
            node.inputs[k] = replacement;
            replacement.uses.push(node);
            inp.uses = inp.uses.filter((u: SimplifyNode) => u !== node);
            propCount++;
          }
        }
        if (
          inp &&
          inp.type === ir.IR_CHECK_NUMBER &&
          inp.inputs[0]?.type === ir.IR_CONSTANT
        ) {
          const val = inp.inputs[0].props.value;
          if (typeof val === "number") {
            const replacement = inp.inputs[0];
            node.inputs[k] = replacement;
            replacement.uses.push(node);
            inp.uses = inp.uses.filter((u: SimplifyNode) => u !== node);
            propCount++;
          }
        }
      }
    }
  }

  return propCount;
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
    rewireUses(graph, node, replacement);
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
    rewireUses(graph, node, replacement);
    for (const item of sequence) item.block = block;
    block.nodes.splice(index, 1, ...sequence);
  };

  for (const block of graph.blocks) {
    for (let i = 0; i < block.nodes.length; i++) {
      const node = block.nodes[i];

      if (node.type === ir.IR_INT32_MUL && node.inputs.length === 2) {
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
            if (shift > 0 && shift < 31) {
              const shlNode = nodeFromIr(
                ir.irInt32Shl(otherInput, nodeFromIr(ir.irConstant(shift))),
              );
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
          if (decomp && decomp.shift > 0 && decomp.shift < 31) {
            const shifted = nodeFromIr(
              ir.irInt32Shl(
                otherInput,
                nodeFromIr(ir.irConstant(decomp.shift)),
              ),
            );
            let result: SimplifyNode;
            if (decomp.op === "add") {
              result = nodeFromIr(ir.irInt32Add(shifted, otherInput));
            } else {
              result = nodeFromIr(ir.irInt32Sub(shifted, otherInput));
            }
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
        const result = nodeFromIr(ir.irConstant(0));
        replaceInPlace(node, result, block, i);
        count++;
      }
    }
  }

  return count;
}
