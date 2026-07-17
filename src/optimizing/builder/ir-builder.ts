import * as ir from "../ir/index.js";

import * as bytecode from "../../bytecode/register/ops/bytecode.js";

import {
  FeedbackNexus,
  FEEDBACK_HINT_MONOMORPHIC,
  FEEDBACK_HINT_POLYMORPHIC,
} from "../../feedback/nexus/index.js";
import type { FeedbackVector } from "../../feedback/vector/index.js";
import type { FrameState } from "../../deopt/frame-state.js";
import type { SimpleConstructorField } from "../../bytecode/register/ops/bytecode.js";
import { tracer } from "../../core/tracing/index.js";
import {
  PACKED_SMI,
  PACKED_DOUBLE,
} from "../../objects/elements/elements-kind.js";
import { createJSObject } from "../../objects/heap/factory.js";
import { mkUndefined } from "../../core/value/index.js";
import {
  DEP_MAP,
  DEP_ELEMENTS_KIND,
  DEP_CALL_TARGET,
} from "../../deopt/dependencies.js";
import { analyzeSimpleConstructor } from "../../bytecode/register/compiler/helpers.js";
import {
  COMPARE_OP_MAP,
  numericPackedElementRep,
  numericFeedbackKind,
  constantString,
} from "./feedback-utils.js";
import { rememberIncomingState, restoreIncomingState, type IncomingStatesByTarget } from "./cfg-state.js";
import { captureFrameState } from "./frame-state.js";
import {
  buildPolymorphicDispatch,
  selectInlineTarget,
  recordInlineDecision,
  tryInline,
} from "./inline.js";

type AnyNode = ir.CFGInstruction | null;
type AnyBlock = ir.CFGBlock;
type AnyGraph = ir.CFGFunction & {
  inlineBudgetRemaining: number;
  recordInlineDecision?: (name: string, kind: string, reason: string) => void;
};
type AnyCompiledFunction = bytecode.RegisterCompiledFunction;
type FeedbackSource = FeedbackNexus | FeedbackVector | null;
type FeedbackLike = FeedbackNexus;
type NodeMap = Map<number, AnyNode>;
type BlockMap = Map<number, AnyBlock>;
type LoopPhiMap = Map<number, Map<number, ir.CFGInstruction>>;
type SavedBlockRegs = IncomingStatesByTarget;
type FrameStateList = FrameState[];
type RegisterInstructionLike = bytecode.RegisterInstruction;
type ConstructorLayoutEntry = { field: SimpleConstructorField; offset: number };

export function buildIR(
  graph: AnyGraph,
  currentBlock: AnyBlock,
  compiledFn: AnyCompiledFunction,
  feedback: FeedbackSource,
  frameStates: FrameStateList,
): void {
  const nexus =
    feedback instanceof FeedbackNexus ? feedback : new FeedbackNexus(feedback);
  let acc: AnyNode = null;
  const regs: NodeMap = new Map();
  graph.inlineBudgetRemaining = 400;

  for (let i = 0; i < compiledFn.paramCount; i++) {
    regs.set(i, graph.parameters[i]);
  }

  const instructions = compiledFn.instructions;
  const blockMap: BlockMap = new Map();

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (
      instr.opcode === bytecode.ROP_JUMP ||
      instr.opcode === bytecode.ROP_JUMP_IF_FALSE ||
      instr.opcode === bytecode.ROP_JUMP_IF_TRUE
    ) {
      const target = instr.operands[0];
      if (!blockMap.has(target)) {
        blockMap.set(target, graph.addBlock());
      }
      if (i + 1 < instructions.length && !blockMap.has(i + 1)) {
        blockMap.set(i + 1, graph.addBlock());
      }
    }
  }

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (
      instr.opcode === bytecode.ROP_JUMP ||
      instr.opcode === bytecode.ROP_JUMP_IF_FALSE ||
      instr.opcode === bytecode.ROP_JUMP_IF_TRUE
    ) {
      const target = instr.operands[0];
      if (target <= i && blockMap.has(target)) {
        blockMap.get(target)!.isLoopHeader = true;
      }
    }
  }

  const loopPhiMap: LoopPhiMap = new Map();
  const savedBlockRegs: SavedBlockRegs = new Map();

  for (let i = 0; i < instructions.length; i++) {
    if (blockMap.has(i)) {
      const nextBlock = blockMap.get(i)!;
      const predecessor = currentBlock;
      let initialLoopArgs: ir.CFGInstruction[] = [];
      if (!currentBlock.isTerminated()) {
        rememberIncomingState(savedBlockRegs, i, currentBlock, regs, acc);
        const jmp = ir.irJump(nextBlock);
        currentBlock.addNode(jmp);
        currentBlock.addSuccessor(nextBlock);
      }
      currentBlock = nextBlock;

      if (savedBlockRegs.has(i) && !nextBlock.isLoopHeader) {
        acc = restoreIncomingState(nextBlock, savedBlockRegs.get(i), regs, acc);
      }

      if (nextBlock.isLoopHeader) {
        const phis = new Map<number, ir.CFGInstruction>();
        for (const [slot, value] of regs) {
          if (!value) continue;
          const phi = nextBlock.addParam([value]);
          phis.set(slot, phi);
          initialLoopArgs.push(value);
          regs.set(slot, phi);
        }
        loopPhiMap.set(nextBlock.id, phis);
        if (
          !predecessor.isTerminated() ||
          predecessor.successors.includes(nextBlock)
        ) {
          predecessor.setEdgeArgs(nextBlock, initialLoopArgs);
        }
      }
    }

    const instr = instructions[i];
    currentBlock = compileInstruction(
      instr,
      i,
      graph,
      currentBlock,
      acc,
      regs,
      compiledFn,
      nexus,
      blockMap,
      loopPhiMap,
      frameStates,
      savedBlockRegs,
    );
    acc = currentBlock._lastAcc !== undefined ? currentBlock._lastAcc : acc;
  }

  for (const [blockId, phis] of loopPhiMap) {
    for (const [slot, phi] of phis) {
      if (phi.inputs.length === 1) {
        phi.addInput(phi.inputs[0]);
      }
    }
  }
}

function functionName(fn: AnyCompiledFunction): string {
  return fn.name || "<anonymous>";
}

function compileInstruction(
  instr: RegisterInstructionLike,
  bytecodeIdx: number,
  graph: AnyGraph,
  block: AnyBlock,
  acc: AnyNode,
  regs: NodeMap,
  compiledFn: AnyCompiledFunction,
  feedback: FeedbackLike,
  blockMap: BlockMap,
  loopPhiMap: LoopPhiMap,
  frameStates: FrameStateList,
  savedBlockRegs: SavedBlockRegs,
): AnyBlock {
  const op = instr.opcode;
  const operands = instr.operands;

  switch (op) {
    case bytecode.ROP_LDA_CONST: {
      const value = compiledFn.constants[operands[0]];
      const node = ir.irConstant(value);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_MAKE_CLOSURE: {
      const value = compiledFn.constants[operands[0]];
      const node = ir.irConstant(value);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_LDA_TRUE: {
      const node = ir.irConstant(true);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_LDA_FALSE: {
      const node = ir.irConstant(false);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_LDA_UNDEFINED: {
      const node = ir.irConstant(undefined);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_LDA_NULL: {
      const node = ir.irConstant(null);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_LDA_THIS: {
      const node = ir.irConstant(undefined);
      node.props.isThis = true;
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_LDA_REG: {
      const reg = operands[0];
      const node = regs.get(reg) || ir.irConstant(undefined);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_STAR: {
      const reg = operands[0];
      regs.set(reg, acc);
      break;
    }

    case bytecode.ROP_MOV: {
      const dst = operands[0];
      const src = operands[1];
      regs.set(dst, regs.get(src) || ir.irConstant(undefined));
      break;
    }

    case bytecode.ROP_LDA_GLOBAL: {
      const nameIdx = operands[0];
      const name = constantString(compiledFn.constants, nameIdx);
      const node = ir.irLoadGlobal(name);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_STA_GLOBAL: {
      const nameIdx = operands[0];
      const name = constantString(compiledFn.constants, nameIdx);
      const node = ir.irStoreGlobal(name, acc);
      block.addNode(node);
      break;
    }

    case bytecode.ROP_ADD:
    case bytecode.ROP_SUB:
    case bytecode.ROP_MUL:
    case bytecode.ROP_DIV:
    case bytecode.ROP_MOD: {
      const rhsReg = operands[0];
      const feedbackSlotIdx = operands.length > 1 ? operands[1] : -1;
      const left = acc;
      const right = regs.get(rhsReg) || ir.irConstant(undefined);
      const feedbackKind = numericFeedbackKind(
        feedback,
        feedbackSlotIdx,
        "binary",
      );

      if (feedbackKind === "smi") {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [left],
          frameStates,
        );
        const checkLeft = ir.irCheckSmi(left);
        checkLeft.frameState = frameState;
        block.addNode(checkLeft);
        const checkRight = ir.irCheckSmi(right);
        checkRight.frameState = frameState;
        block.addNode(checkRight);

        let result;
        if (op === bytecode.ROP_ADD)
          result = ir.irInt32Add(checkLeft, checkRight);
        else if (op === bytecode.ROP_SUB)
          result = ir.irInt32Sub(checkLeft, checkRight);
        else if (op === bytecode.ROP_MUL)
          result = ir.irInt32Mul(checkLeft, checkRight);
        else if (op === bytecode.ROP_DIV)
          result = ir.irFloat64Div(checkLeft, checkRight);
        else result = ir.irInt32Mod(checkLeft, checkRight);
        if (
          op === bytecode.ROP_ADD ||
          op === bytecode.ROP_SUB ||
          op === bytecode.ROP_MUL ||
          op === bytecode.ROP_DIV ||
          op === bytecode.ROP_MOD
        ) {
          result.frameState = frameState;
        }
        block.addNode(result);
        block._lastAcc = result;

        const opName = ["Add", "Sub", "Mul", "Div", "Mod"][
          [
            bytecode.ROP_ADD,
            bytecode.ROP_SUB,
            bytecode.ROP_MUL,
            bytecode.ROP_DIV,
            bytecode.ROP_MOD,
          ].indexOf(op)
        ];
        tracer.jitCompile(
          functionName(compiledFn),
          `${opName} at bc:${bytecodeIdx} → Int32${opName} (smi speculation)`,
        );
      } else if (feedbackKind === "number") {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [left],
          frameStates,
        );
        const checkLeft = ir.irCheckNumber(left);
        checkLeft.frameState = frameState;
        block.addNode(checkLeft);
        const checkRight = ir.irCheckNumber(right);
        checkRight.frameState = frameState;
        block.addNode(checkRight);

        let result;
        if (op === bytecode.ROP_ADD)
          result = ir.irFloat64Add(checkLeft, checkRight);
        else if (op === bytecode.ROP_SUB)
          result = ir.irFloat64Sub(checkLeft, checkRight);
        else if (op === bytecode.ROP_MUL)
          result = ir.irFloat64Mul(checkLeft, checkRight);
        else if (op === bytecode.ROP_DIV)
          result = ir.irFloat64Div(checkLeft, checkRight);
        else result = ir.irGenericMod(checkLeft, checkRight);
        block.addNode(result);
        block._lastAcc = result;

        const opName = ["Add", "Sub", "Mul", "Div", "Mod"][
          [
            bytecode.ROP_ADD,
            bytecode.ROP_SUB,
            bytecode.ROP_MUL,
            bytecode.ROP_DIV,
            bytecode.ROP_MOD,
          ].indexOf(op)
        ];
        tracer.jitCompile(
          functionName(compiledFn),
          `${opName} at bc:${bytecodeIdx} → Float64${opName} (number speculation)`,
        );
      } else {
        let result;
        if (op === bytecode.ROP_ADD) result = ir.irGenericAdd(left, right);
        else if (op === bytecode.ROP_SUB) result = ir.irGenericSub(left, right);
        else if (op === bytecode.ROP_MUL) result = ir.irGenericMul(left, right);
        else if (op === bytecode.ROP_DIV) result = ir.irGenericDiv(left, right);
        else result = ir.irGenericMod(left, right);
        block.addNode(result);
        block._lastAcc = result;
      }
      break;
    }

    case bytecode.ROP_NOT: {
      const node = ir.irNot(acc);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_NEG: {
      const feedbackSlotIdx = operands.length > 0 ? operands[0] : -1;
      const feedbackKind = numericFeedbackKind(
        feedback,
        feedbackSlotIdx,
        "unary",
      );

      if (feedbackKind === "smi") {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [acc],
          frameStates,
        );
        const check = ir.irCheckSmi(acc);
        check.frameState = frameState;
        block.addNode(check);
        const neg = ir.irNeg(check);
        block.addNode(neg);
        block._lastAcc = neg;
        tracer.jitCompile(
          functionName(compiledFn),
          `Neg at bc:${bytecodeIdx} → speculative smi negate`,
        );
      } else if (feedbackKind === "number") {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [acc],
          frameStates,
        );
        const check = ir.irCheckNumber(acc);
        check.frameState = frameState;
        block.addNode(check);
        const neg = ir.irNeg(check);
        block.addNode(neg);
        block._lastAcc = neg;
        tracer.jitCompile(
          functionName(compiledFn),
          `Neg at bc:${bytecodeIdx} → speculative number negate`,
        );
      } else {
        const node = ir.irNeg(acc);
        block.addNode(node);
        block._lastAcc = node;
      }
      break;
    }

    case bytecode.ROP_TYPEOF: {
      const node = new ir.IRNode(ir.IR_TYPEOF, {});
      node.addInput(acc);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_BITAND:
    case bytecode.ROP_BITOR:
    case bytecode.ROP_BITXOR:
    case bytecode.ROP_SHL:
    case bytecode.ROP_SHR:
    case bytecode.ROP_USHR:
    case bytecode.ROP_POW: {
      const rhsReg = operands[0];
      const left = acc;
      const right = regs.get(rhsReg) || ir.irConstant(undefined);
      let result;
      if (op === bytecode.ROP_BITAND) result = ir.irGenericBitand(left, right);
      else if (op === bytecode.ROP_BITOR)
        result = ir.irGenericBitor(left, right);
      else if (op === bytecode.ROP_BITXOR)
        result = ir.irGenericBitxor(left, right);
      else if (op === bytecode.ROP_SHL) result = ir.irGenericShl(left, right);
      else if (op === bytecode.ROP_SHR) result = ir.irGenericShr(left, right);
      else if (op === bytecode.ROP_USHR) result = ir.irGenericUshr(left, right);
      else result = ir.irGenericPow(left, right);
      block.addNode(result);
      block._lastAcc = result;
      break;
    }

    case bytecode.ROP_BITNOT: {
      const node = ir.irGenericBitnot(acc);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_INSTANCEOF: {
      const rhsReg = operands[0];
      const left = acc;
      const right = regs.get(rhsReg) || ir.irConstant(undefined);
      const node = ir.irGenericInstanceof(left, right);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_IN: {
      const rhsReg = operands[0];
      const left = acc;
      const right = regs.get(rhsReg) || ir.irConstant(undefined);
      const node = ir.irGenericIn(left, right);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_VOID: {
      const node = ir.irConstant(undefined);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_IS_NULLISH: {
      const left = acc || ir.irConstant(undefined);
      const nullConstant = ir.irConstant(null);
      block.addNode(nullConstant);
      const node = ir.irGenericCompare("loose==", left, nullConstant);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_EQ:
    case bytecode.ROP_NEQ:
    case bytecode.ROP_LOOSE_EQ:
    case bytecode.ROP_LOOSE_NEQ:
    case bytecode.ROP_LT:
    case bytecode.ROP_GT:
    case bytecode.ROP_LTE:
    case bytecode.ROP_GTE: {
      const rhsReg = operands[0];
      const feedbackSlotIdx = operands.length > 1 ? operands[1] : -1;
      const left = acc;
      const right = regs.get(rhsReg) || ir.irConstant(undefined);
      const feedbackKind = numericFeedbackKind(
        feedback,
        feedbackSlotIdx,
        "binary",
      );
      const cmpOp = COMPARE_OP_MAP[op];

      if (feedbackKind === "smi") {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [left],
          frameStates,
        );
        const checkLeft = ir.irCheckSmi(left);
        checkLeft.frameState = frameState;
        block.addNode(checkLeft);
        const checkRight = ir.irCheckSmi(right);
        checkRight.frameState = frameState;
        block.addNode(checkRight);
        const cmp = ir.irInt32Compare(cmpOp, checkLeft, checkRight);
        block.addNode(cmp);
        block._lastAcc = cmp;
        tracer.jitCompile(
          functionName(compiledFn),
          `Compare(${cmpOp}) at bc:${bytecodeIdx} → Int32Compare (smi speculation)`,
        );
      } else if (feedbackKind === "number") {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [left],
          frameStates,
        );
        const checkLeft = ir.irCheckNumber(left);
        checkLeft.frameState = frameState;
        block.addNode(checkLeft);
        const checkRight = ir.irCheckNumber(right);
        checkRight.frameState = frameState;
        block.addNode(checkRight);
        const cmp = ir.irFloat64Compare(cmpOp, checkLeft, checkRight);
        block.addNode(cmp);
        block._lastAcc = cmp;
      } else {
        const node = ir.irGenericCompare(cmpOp, left, right);
        block.addNode(node);
        block._lastAcc = node;
      }
      break;
    }

    case bytecode.ROP_LDA_PROP: {
      const objReg = operands[0];
      const propNameIdx = operands[1];
      const feedbackSlotIdx = operands.length > 2 ? operands[2] : -1;
      const propName = constantString(compiledFn.constants, propNameIdx);
      const propertyHint =
        feedbackSlotIdx >= 0 ? feedback.property(feedbackSlotIdx) : null;
      const elementsHint =
        feedbackSlotIdx >= 0 ? feedback.elements(feedbackSlotIdx) : null;
      const obj = regs.get(objReg) || ir.irConstant(undefined);

      if (
        propName === "length" &&
        elementsHint &&
        elementsHint.lengthAccess &&
        elementsHint.elementsKind != null
      ) {
        const elementsKind = elementsHint.elementsKind;
        const elementRep = numericPackedElementRep(elementsKind);
        if (elementRep) {
          const frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [],
            frameStates,
          );
          const chkArray = ir.irCheckArray(obj);
          chkArray.frameState = frameState;
          block.addNode(chkArray);
          const chkKind = ir.irCheckElementsKind(chkArray, elementsKind);
          chkKind.frameState = frameState;
          block.addNode(chkKind);
          graph.addDependency(DEP_ELEMENTS_KIND, elementsKind);
          const loadLength = ir.irLoadArrayLength(chkKind);
          block.addNode(loadLength);
          block._lastAcc = loadLength;
          tracer.jitCompile(
            functionName(compiledFn),
            `GetProp "length" at bc:${bytecodeIdx} → LoadArrayLength (${elementsKind})`,
          );
        } else {
          const node = ir.irGenericGetProp(obj, propName);
          node.frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [],
            frameStates,
          );
          block.addNode(node);
          block._lastAcc = node;
        }
      } else if (
        propertyHint &&
        propertyHint.kind === FEEDBACK_HINT_MONOMORPHIC
      ) {
        const mapId = propertyHint.map;
        const offset = propertyHint.offset;
        const mapVersion = propertyHint.mapVersion;
        const protoDepth = propertyHint.protoDepth;
        if (
          protoDepth === 0 &&
          mapId != null &&
          offset != null &&
          mapVersion != null
        ) {
          const frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [],
            frameStates,
          );
          const check = ir.irCheckMap(obj, mapId, mapVersion);
          check.frameState = frameState;
          block.addNode(check);
          graph.addDependency(DEP_MAP, mapId, mapVersion);
          const load = ir.irLoadField(check, offset);
          block.addNode(load);
          block._lastAcc = load;
          tracer.jitCompile(
            functionName(compiledFn),
            `GetProp "${propName}" at bc:${bytecodeIdx} → LoadField(offset=${offset}) (monomorphic, map=HC${mapId})`,
          );
        } else {
          const node = ir.irGenericGetProp(obj, propName);
          node.frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [],
            frameStates,
          );
          block.addNode(node);
          block._lastAcc = node;
        }
      } else if (
        propertyHint &&
        propertyHint.kind === FEEDBACK_HINT_POLYMORPHIC
      ) {
        const maps = propertyHint.maps;
        const offsets = propertyHint.offsets;
        const protoDepths = propertyHint.protoDepths || [];
        if (
          maps &&
          offsets &&
          protoDepths.every((depth: number | null | undefined) => depth === 0)
        ) {
          const frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [],
            frameStates,
          );
          const load = ir.irPolymorphicLoad(obj, maps, offsets);
          load.frameState = frameState;
          block.addNode(load);
          block._lastAcc = load;
          tracer.jitCompile(
            functionName(compiledFn),
            `GetProp "${propName}" at bc:${bytecodeIdx} → PolymorphicLoad(degree=${maps.length})`,
          );
        } else {
          const node = ir.irGenericGetProp(obj, propName);
          node.frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [],
            frameStates,
          );
          block.addNode(node);
          block._lastAcc = node;
        }
      } else {
        const node = ir.irGenericGetProp(obj, propName);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [],
          frameStates,
        );
        block.addNode(node);
        block._lastAcc = node;
      }
      break;
    }

    case bytecode.ROP_STA_PROP: {
      const objReg = operands[0];
      const propNameIdx = operands[1];
      const feedbackSlotIdx = operands.length > 2 ? operands[2] : -1;
      const propName = constantString(compiledFn.constants, propNameIdx);
      const propertyHint =
        feedbackSlotIdx >= 0 ? feedback.property(feedbackSlotIdx) : null;
      const obj = regs.get(objReg) || ir.irConstant(undefined);
      const value = acc;

      if (propertyHint && propertyHint.kind === FEEDBACK_HINT_MONOMORPHIC) {
        const mapId = propertyHint.map;
        const offset = propertyHint.offset;
        const mapVersion = propertyHint.mapVersion;
        const protoDepth = propertyHint.protoDepth;
        if (
          protoDepth !== 0 ||
          mapId == null ||
          offset == null ||
          mapVersion == null
        ) {
          const node = ir.irGenericSetProp(obj, propName, value);
          node.frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [value],
            frameStates,
          );
          block.addNode(node);
          break;
        }
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [value],
          frameStates,
        );
        const check = ir.irCheckMap(obj, mapId, mapVersion);
        check.frameState = frameState;
        block.addNode(check);
        graph.addDependency(DEP_MAP, mapId, mapVersion);
        const store = ir.irStoreField(check, offset, value);
        block.addNode(store);
        tracer.jitCompile(
          functionName(compiledFn),
          `SetProp "${propName}" at bc:${bytecodeIdx} → StoreField(offset=${offset}) (monomorphic, map=HC${mapId})`,
        );
      } else if (
        propertyHint &&
        propertyHint.kind === FEEDBACK_HINT_POLYMORPHIC
      ) {
        const maps = propertyHint.maps;
        const offsets = propertyHint.offsets;
        const protoDepths = propertyHint.protoDepths || [];
        if (
          maps &&
          offsets &&
          protoDepths.every((depth: number | null | undefined) => depth === 0)
        ) {
          const frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [value],
            frameStates,
          );
          const store = ir.irPolymorphicStore(obj, maps, offsets, value);
          store.frameState = frameState;
          block.addNode(store);
          tracer.jitCompile(
            functionName(compiledFn),
            `SetProp "${propName}" at bc:${bytecodeIdx} → PolymorphicStore(degree=${maps.length})`,
          );
        } else {
          const node = ir.irGenericSetProp(obj, propName, value);
          node.frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [value],
            frameStates,
          );
          block.addNode(node);
        }
      } else {
        const node = ir.irGenericSetProp(obj, propName, value);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [value],
          frameStates,
        );
        block.addNode(node);
      }
      break;
    }

    case bytecode.ROP_LDA_INDEX: {
      const objReg = operands[0];
      const indexReg = operands[1];
      const feedbackSlotIdx = operands.length > 2 ? operands[2] : -1;
      const elementsHint =
        feedbackSlotIdx >= 0 ? feedback.elements(feedbackSlotIdx) : null;
      const obj = regs.get(objReg) || ir.irConstant(undefined);
      const index = regs.get(indexReg) || ir.irConstant(undefined);

      if (
        elementsHint &&
        elementsHint.arrayAccess &&
        elementsHint.elementsKind != null
      ) {
        const elementsKind = elementsHint.elementsKind;
        const elementRep = numericPackedElementRep(elementsKind);
        if (!elementRep) {
          const node = ir.irGenericGetIndex(obj, index);
          node.frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [],
            frameStates,
          );
          block.addNode(node);
          block._lastAcc = node;
          break;
        }
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [],
          frameStates,
        );
        const chkArray = ir.irCheckArray(obj);
        chkArray.frameState = frameState;
        block.addNode(chkArray);
        const chkKind = ir.irCheckElementsKind(chkArray, elementsKind);
        chkKind.frameState = frameState;
        block.addNode(chkKind);
        graph.addDependency(DEP_ELEMENTS_KIND, elementsKind);

        const chkSmi = ir.irCheckSmi(index);
        chkSmi.frameState = frameState;
        block.addNode(chkSmi);

        const chkBounds = ir.irCheckBounds(chkSmi, chkKind);
        chkBounds.frameState = frameState;
        block.addNode(chkBounds);

        const loadElem = ir.irLoadElement(
          chkKind,
          chkSmi,
          elementsKind,
          elementRep,
          true,
        );
        block.addNode(loadElem);
        block._lastAcc = loadElem;
        tracer.jitCompile(
          functionName(compiledFn),
          `GetIndex at bc:${bytecodeIdx} → LoadElement(${elementsKind})`,
        );
      } else {
        const node = ir.irGenericGetIndex(obj, index);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [],
          frameStates,
        );
        block.addNode(node);
        block._lastAcc = node;
      }
      break;
    }

    case bytecode.ROP_STA_INDEX: {
      const objReg = operands[0];
      const indexReg = operands[1];
      const feedbackSlotIdx = operands.length > 2 ? operands[2] : -1;
      const elementsHint =
        feedbackSlotIdx >= 0 ? feedback.elements(feedbackSlotIdx) : null;
      const obj = regs.get(objReg) || ir.irConstant(undefined);
      const index = regs.get(indexReg) || ir.irConstant(undefined);
      const value = acc;

      if (
        elementsHint &&
        elementsHint.arrayAccess &&
        elementsHint.elementsKind != null
      ) {
        const elementsKind = elementsHint.elementsKind;
        const elementRep = numericPackedElementRep(elementsKind);
        if (!elementRep) {
          const node = ir.irGenericSetIndex(obj, index, value);
          node.frameState = captureFrameState(
            compiledFn,
            bytecodeIdx,
            regs,
            [value],
            frameStates,
          );
          block.addNode(node);
          break;
        }
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [value],
          frameStates,
        );
        const chkArray = ir.irCheckArray(obj);
        chkArray.frameState = frameState;
        block.addNode(chkArray);
        const chkKind = ir.irCheckElementsKind(chkArray, elementsKind);
        chkKind.frameState = frameState;
        block.addNode(chkKind);
        graph.addDependency(DEP_ELEMENTS_KIND, elementsKind);

        const chkSmi = ir.irCheckSmi(index);
        chkSmi.frameState = frameState;
        block.addNode(chkSmi);

        const chkBounds = ir.irCheckBounds(chkSmi, chkKind);
        chkBounds.frameState = frameState;
        block.addNode(chkBounds);

        const storeElem = ir.irStoreElement(
          chkKind,
          chkSmi,
          value,
          elementsKind,
          elementRep,
          true,
        );
        block.addNode(storeElem);
        tracer.jitCompile(
          functionName(compiledFn),
          `SetIndex at bc:${bytecodeIdx} → StoreElement(${elementsKind})`,
        );
      } else {
        const node = ir.irGenericSetIndex(obj, index, value);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [value],
          frameStates,
        );
        block.addNode(node);
      }
      break;
    }

    case bytecode.ROP_JUMP: {
      const target = operands[0];
      const targetBlock = blockMap.get(target);
      if (targetBlock) {
        rememberIncomingState(savedBlockRegs, target, block, regs, acc);
        const edgeArgs = [];
        if (targetBlock.isLoopHeader && loopPhiMap) {
          const phis = loopPhiMap.get(targetBlock.id);
          if (phis) {
            for (const [slot, phi] of phis) {
              const currentVal = regs.get(slot);
              if (currentVal && phi.inputs.length < 2) {
                phi.addInput(currentVal);
              }
              edgeArgs.push(currentVal || phi);
            }
          }
        }
        const jmp = ir.irJump(targetBlock);
        block.addNode(jmp);
        block.addSuccessor(targetBlock, edgeArgs);
      }
      break;
    }

    case bytecode.ROP_JUMP_IF_FALSE:
    case bytecode.ROP_JUMP_IF_TRUE: {
      const target = operands[0];
      const condition = acc;
      const falseBlock = blockMap.get(target);
      const trueBlock = blockMap.get(bytecodeIdx + 1);

      rememberIncomingState(savedBlockRegs, target, block, regs, acc);
      if (bytecodeIdx + 1 < compiledFn.instructions.length) {
        rememberIncomingState(
          savedBlockRegs,
          bytecodeIdx + 1,
          block,
          regs,
          acc,
        );
      }

      if (falseBlock && trueBlock) {
        const branch =
          op === bytecode.ROP_JUMP_IF_FALSE
            ? ir.irBranch(condition, trueBlock, falseBlock)
            : ir.irBranch(condition, falseBlock, trueBlock);
        block.addNode(branch);
        block.addSuccessor(trueBlock);
        block.addSuccessor(falseBlock);
      } else if (falseBlock) {
        const branch = new ir.IRNode(ir.IR_BRANCH, {
          trueBlock: -1,
          falseBlock: falseBlock.id,
        });
        branch.addInput(condition);
        block.addNode(branch);
        block.addSuccessor(falseBlock);
      }
      break;
    }

    case bytecode.ROP_CALL: {
      const calleeReg = operands[0];
      const arg0Reg = operands[1];
      const argCount = operands[2];
      const feedbackSlotIdx = operands.length > 3 ? operands[3] : -1;
      const callHint =
        feedbackSlotIdx >= 0 ? feedback.call(feedbackSlotIdx) : null;
      const callee = regs.get(calleeReg) || ir.irConstant(undefined);
      const args = [];
      for (let i = 0; i < argCount; i++) {
        args.push(regs.get(arg0Reg + i) || ir.irConstant(undefined));
      }

      const decision = selectInlineTarget(
        callHint,
        compiledFn,
        argCount,
        graph,
      );
      const inlineTarget = decision.target;

      if (inlineTarget) {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [callee],
          frameStates,
        );
        const targetCheck = ir.irCheckCallTarget(callee, inlineTarget);
        targetCheck.props.deoptOnMiss = true;
        targetCheck.frameState = frameState;
        block.addNode(targetCheck);
        const inlinedResult = tryInline(
          inlineTarget,
          graph,
          block,
          acc,
          regs,
          args,
          compiledFn,
          bytecodeIdx,
          blockMap,
          loopPhiMap,
          frameStates,
          null,
        );
        if (inlinedResult !== null) {
          graph.inlineBudgetRemaining -= inlineTarget.instructions.length;
          graph.addDependency(
            DEP_CALL_TARGET,
            inlineTarget.id,
            inlineTarget.version,
          );
          recordInlineDecision(
            callHint,
            "inlined",
            inlineTarget.name || "<anonymous>",
          );
          block = inlinedResult.block;
          block._lastAcc = inlinedResult.value;
          tracer.jitCompile(
            functionName(compiledFn),
            `Inlined call to "${inlineTarget.name}" at bc:${bytecodeIdx}`,
          );
          return block;
        }
        recordInlineDecision(callHint, "failed", "unsupported-opcode");
        tracer.jitCompile(
          functionName(compiledFn),
          `Inline failed for "${inlineTarget.name}" at bc:${bytecodeIdx}: unsupported-opcode`,
        );
      } else if (decision.targets && callee.type !== ir.IR_POLYMORPHIC_LOAD) {
        const polyResult = buildPolymorphicDispatch(
          decision.targets,
          callee,
          args,
          graph,
          block,
          acc,
          regs,
          compiledFn,
          bytecodeIdx,
          blockMap,
          loopPhiMap,
          frameStates,
          null,
        );
        recordInlineDecision(
          callHint,
          "polymorphic-inlined",
          `${decision.targets.length} targets`,
        );
        block = polyResult.block;
        block._lastAcc = polyResult.value;
        break;
      } else if (callHint && callHint.slot) {
        recordInlineDecision(callHint, "failed", decision.reason);
        tracer.jitCompile(
          functionName(compiledFn),
          `Inline skipped at bc:${bytecodeIdx}: ${decision.reason}`,
        );
      }

      if (
        callHint &&
        callHint.targetRef === compiledFn &&
        argCount === compiledFn.paramCount
      ) {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [callee],
          frameStates,
        );
        graph.addDependency(
          DEP_CALL_TARGET,
          compiledFn.id,
          compiledFn.version,
        );
        if (callee) callee._deadForSelfRecursion = true;
        const knownCall = ir.irCallKnownFunction(compiledFn, args);
        knownCall.frameState = frameState;
        block.addNode(knownCall);
        block._lastAcc = knownCall;
        break;
      }

      const node = ir.irGenericCall(callee, args);
      node.frameState = captureFrameState(
        compiledFn,
        bytecodeIdx,
        regs,
        [callee],
        frameStates,
      );
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_CALL_METHOD: {
      const receiverReg = operands[0];
      const arg0Reg = operands[1];
      const argCount = operands[2];
      const feedbackSlotIdx = operands.length > 3 ? operands[3] : -1;
      const callHint =
        feedbackSlotIdx >= 0 ? feedback.call(feedbackSlotIdx) : null;
      const receiver = regs.get(receiverReg) || ir.irConstant(undefined);
      const args = [];
      for (let i = 0; i < argCount; i++) {
        args.push(regs.get(arg0Reg + i) || ir.irConstant(undefined));
      }

      const callee = acc || ir.irConstant(undefined);
      const decision = selectInlineTarget(
        callHint,
        compiledFn,
        argCount,
        graph,
      );
      const inlineTarget = decision.target;

      if (inlineTarget) {
        const frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [callee],
          frameStates,
        );
        const targetCheck = ir.irCheckCallTarget(callee, inlineTarget);
        targetCheck.props.deoptOnMiss = true;
        targetCheck.frameState = frameState;
        block.addNode(targetCheck);
        const inlinedResult = tryInline(
          inlineTarget,
          graph,
          block,
          acc,
          regs,
          args,
          compiledFn,
          bytecodeIdx,
          blockMap,
          loopPhiMap,
          frameStates,
          receiver,
        );
        if (inlinedResult !== null) {
          graph.inlineBudgetRemaining -= inlineTarget.instructions.length;
          graph.addDependency(
            DEP_CALL_TARGET,
            inlineTarget.id,
            inlineTarget.version,
          );
          recordInlineDecision(
            callHint,
            "inlined",
            inlineTarget.name || "<anonymous>",
          );
          block = inlinedResult.block;
          block._lastAcc = inlinedResult.value;
          tracer.jitCompile(
            functionName(compiledFn),
            `Inlined method call to "${inlineTarget.name}" at bc:${bytecodeIdx}`,
          );
          return block;
        }
        recordInlineDecision(callHint, "failed", "unsupported-opcode");
        tracer.jitCompile(
          functionName(compiledFn),
          `Inline failed for method "${inlineTarget.name}" at bc:${bytecodeIdx}: unsupported-opcode`,
        );
      } else if (decision.targets && callee.type !== ir.IR_POLYMORPHIC_LOAD) {
        const polyResult = buildPolymorphicDispatch(
          decision.targets,
          callee,
          args,
          graph,
          block,
          acc,
          regs,
          compiledFn,
          bytecodeIdx,
          blockMap,
          loopPhiMap,
          frameStates,
          receiver,
        );
        recordInlineDecision(
          callHint,
          "polymorphic-inlined",
          `${decision.targets.length} targets`,
        );
        block = polyResult.block;
        block._lastAcc = polyResult.value;
        break;
      } else if (callHint && callHint.slot) {
        recordInlineDecision(callHint, "failed", decision.reason);
        tracer.jitCompile(
          functionName(compiledFn),
          `Inline skipped for method at bc:${bytecodeIdx}: ${decision.reason}`,
        );
      }

      const node = ir.irGenericCall(callee, [receiver, ...args]);
      node.props.isMethod = true;
      node.frameState = captureFrameState(
        compiledFn,
        bytecodeIdx,
        regs,
        [callee],
        frameStates,
      );
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_NEW: {
      const calleeReg = operands[0];
      const arg0Reg = operands[1];
      const argCount = operands[2];
      const fbSlotIdx = operands.length > 3 ? operands[3] : -1;
      const callHint = fbSlotIdx >= 0 ? feedback.call(fbSlotIdx) : null;
      const constructor = regs.get(calleeReg) || ir.irConstant(undefined);
      const args = [];
      for (let i = 0; i < argCount; i++) {
        args.push(regs.get(arg0Reg + i) || ir.irConstant(undefined));
      }

      const frameState = captureFrameState(
        compiledFn,
        bytecodeIdx,
        regs,
        [],
        frameStates,
      );
      const newObj = ir.irNewObject();
      newObj.frameState = frameState;
      block.addNode(newObj);

      const decision = selectInlineTarget(
        callHint,
        compiledFn,
        argCount,
        graph,
      );
      const inlineTarget = decision.target;
      if (inlineTarget) {
        const ctorInfo =
          inlineTarget.simpleConstructorInfo !== undefined
            ? inlineTarget.simpleConstructorInfo
            : analyzeSimpleConstructor(inlineTarget);
        if (ctorInfo && ctorInfo.length > 0) {
          const shapeObj = createJSObject();
          for (const field of ctorInfo)
            shapeObj.setProperty(field.name, mkUndefined());
          const layout = ctorInfo.map((field: SimpleConstructorField) => {
            const desc = shapeObj.hiddenClass.lookupProperty(field.name);
            return desc ? { field, offset: desc.offset } : null;
          });
          if (layout.every((item): item is ConstructorLayoutEntry => item !== null)) {
            newObj.props.targetHiddenClassId = shapeObj.hiddenClass.id;
            newObj.props.targetSlotCount = ctorInfo.length;
            for (const item of layout) {
              let value: ir.CFGInstruction;
              if (item.field.source.kind === "local")
                value =
                  args[item.field.source.index] || ir.irConstant(undefined);
              else if (item.field.source.kind === "const") {
                value = ir.irConstant(
                  inlineTarget.constants[item.field.source.index],
                );
                block.addNode(value);
              } else if (item.field.source.kind === "null") {
                value = ir.irConstant(null);
                block.addNode(value);
              } else if (item.field.source.kind === "true") {
                value = ir.irConstant(true);
                block.addNode(value);
              } else if (item.field.source.kind === "false") {
                value = ir.irConstant(false);
                block.addNode(value);
              } else {
                value = ir.irConstant(undefined);
                block.addNode(value);
              }
              const store = ir.irStoreField(newObj, item.offset, value);
              block.addNode(store);
            }
            graph.inlineBudgetRemaining -= ctorInfo.length;
            graph.addDependency(
              DEP_CALL_TARGET,
              inlineTarget.id,
              inlineTarget.version,
            );
            recordInlineDecision(
              callHint,
              "inlined",
              inlineTarget.name || "<anonymous>",
            );
            block._lastAcc = newObj;
            tracer.jitCompile(
              functionName(compiledFn),
              `Inlined constructor "${inlineTarget.name}" at bc:${bytecodeIdx} → ${ctorInfo.length} StoreField`,
            );
            break;
          }
        }
        const inlinedResult = tryInline(
          inlineTarget,
          graph,
          block,
          acc,
          regs,
          args,
          compiledFn,
          bytecodeIdx,
          blockMap,
          loopPhiMap,
          frameStates,
          newObj,
        );
        if (inlinedResult !== null) {
          graph.inlineBudgetRemaining -= inlineTarget.instructions.length;
          graph.addDependency(
            DEP_CALL_TARGET,
            inlineTarget.id,
            inlineTarget.version,
          );
          recordInlineDecision(
            callHint,
            "inlined",
            inlineTarget.name || "<anonymous>",
          );
          block._lastAcc = newObj;
          block = inlinedResult.block;
          tracer.jitCompile(
            functionName(compiledFn),
            `Inlined constructor "${inlineTarget.name}" at bc:${bytecodeIdx}`,
          );
          return block;
        }
        recordInlineDecision(callHint, "failed", "unsupported-opcode");
        tracer.jitCompile(
          functionName(compiledFn),
          `Inline failed for constructor "${inlineTarget.name}" at bc:${bytecodeIdx}: unsupported-opcode`,
        );
      } else if (callHint && callHint.slot) {
        recordInlineDecision(callHint, "failed", decision.reason);
      }

      const callNode = ir.irGenericCall(constructor, [newObj, ...args]);
      callNode.props.isNew = true;
      callNode.frameState = frameState;
      block.addNode(callNode);
      block._lastAcc = callNode;
      break;
    }

    case bytecode.ROP_NEW_OBJECT: {
      const node = ir.irNewObject();
      node.frameState = captureFrameState(
        compiledFn,
        bytecodeIdx,
        regs,
        [],
        frameStates,
      );
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_NEW_ARRAY: {
      const startReg = operands[0];
      const elementCount = operands[1];
      const elements = [];
      for (let i = 0; i < elementCount; i++) {
        elements.push(regs.get(startReg + i) || ir.irConstant(undefined));
      }
      const node = ir.irNewArray(elements);
      node.frameState = captureFrameState(
        compiledFn,
        bytecodeIdx,
        regs,
        [],
        frameStates,
      );
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_NEW_REGEX: {
      const node = ir.irNewRegex(operands[0]);
      node.frameState = captureFrameState(
        compiledFn,
        bytecodeIdx,
        regs,
        [],
        frameStates,
      );
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_RETURN: {
      const value = acc || ir.irConstant(undefined);
      const ret = ir.irReturn(value);
      block.addNode(ret);
      break;
    }

    default: {
      tracer.jitCompile(
        functionName(compiledFn),
        `Warning: unhandled opcode ${bytecode.rOpcodeName(op)} (0x${op.toString(16)}) at bc:${bytecodeIdx}`,
      );
      break;
    }
  }
  return block;
}

export { captureFrameState, COMPARE_OP_MAP };

