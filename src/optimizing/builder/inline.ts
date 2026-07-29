import * as ir from "../ir/index.js";
import * as bytecode from "../../bytecode/register/ops/bytecode.js";
import { tracer } from "../../core/tracing/index.js";
import {
  DEP_MAP,
  DEP_ELEMENTS_KIND,
  DEP_CALL_TARGET,
} from "../../deopt/dependencies.js";
import {
  FeedbackNexus,
  FEEDBACK_HINT_MONOMORPHIC,
  FEEDBACK_HINT_POLYMORPHIC,
  FEEDBACK_HINT_GENERIC,
  type PropertyHint,
  type ElementsHint,
} from "../../feedback/nexus/index.js";
import type { CallTargetProfile, FeedbackSlot } from "../../feedback/vector/index.js";
import type { FrameState } from "../../deopt/frame-state.js";
import {
  captureFrameState,
  captureFrameStateWithCaller,
} from "./frame-state.js";
import {
  COMPARE_OP_MAP,
  numericPackedElementRep,
  constantString,
} from "./feedback-utils.js";

type AnyNode = ir.CFGInstruction;
type AnyBlock = ir.CFGBlock;
type AnyGraph = ir.CFGFunction & {
  inlineBudgetRemaining: number;
  recordInlineDecision?: (name: string, kind: string, reason: string) => void;
};
type AnyCompiledFunction = bytecode.RegisterCompiledFunction;
type NodeMap = Map<number, AnyNode | null>;
type FrameStateList = FrameState[];
type InlineResult = { block: AnyBlock; value: AnyNode } | null;
type InlineStack = Array<AnyNode | null>;
type InlineTargetProfile = CallTargetProfile & { ref: AnyCompiledFunction };
type InlineDecision = {
  target: AnyCompiledFunction | null;
  targets: InlineTargetProfile[] | null;
  reason: string;
};
type RegisterInstructionLike = bytecode.RegisterInstruction;
type InlineCallHint = {
  slot: FeedbackSlot | null;
  kind: string;
  frequency: number;
  targetRef?: AnyCompiledFunction | null;
  targets?: InlineTargetProfile[] | null;
};

function referencesUpvalues(target: AnyCompiledFunction): boolean {
  const instructions = target.instructions;
  if (!instructions) return (target.upvalues?.length ?? 0) > 0;
  for (const instr of instructions) {
    if (
      instr.opcode === bytecode.ROP_LDA_UPVALUE ||
      instr.opcode === bytecode.ROP_STA_UPVALUE ||
      instr.opcode === bytecode.ROP_MAKE_CLOSURE
    )
      return true;
  }
  return false;
}

function referencesThis(target: AnyCompiledFunction): boolean {
  const instructions = target.instructions;
  if (!instructions) return false;
  for (const instr of instructions) {
    if (instr.opcode === bytecode.ROP_LDA_THIS) return true;
  }
  return false;
}

export function buildPolymorphicDispatch(
  targets: InlineTargetProfile[],
  callee: AnyNode,
  args: AnyNode[],
  graph: AnyGraph,
  block: AnyBlock,
  acc: AnyNode | null,
  regs: NodeMap,
  compiledFn: AnyCompiledFunction,
  bytecodeIdx: number,
  blockMap: Map<number, AnyBlock>,
  loopPhiMap: Map<number, Map<number, AnyNode>>,
  frameStates: FrameStateList,
  receiver: AnyNode | null,
): { block: AnyBlock; value: AnyNode } {
  const mergeBlock = graph.addBlock();
  const resultPhi = mergeBlock.addParam();

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i].ref;
    const checkBlock = block;
    const hitBlock = graph.addBlock();
    const missBlock = graph.addBlock();
    const frameState = captureFrameState(
      compiledFn,
      bytecodeIdx,
      regs,
      receiver ? [callee] : [],
      frameStates,
    );

    const check = ir.irCheckCallTarget(callee, target);
    check.frameState = frameState;
    checkBlock.addNode(check);

    const branch = ir.irBranch(check, hitBlock, missBlock);
    checkBlock.addNode(branch);
    checkBlock.addSuccessor(hitBlock);
    checkBlock.addSuccessor(missBlock);

    const inlinedResult = tryInline(
      target,
      graph,
      hitBlock,
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

    let hitEndBlock, hitValue;
    if (inlinedResult !== null) {
      graph.inlineBudgetRemaining -= target.instructions.length;
      graph.addDependency(DEP_CALL_TARGET, target.id, target.version);
      hitEndBlock = inlinedResult.block;
      hitValue = inlinedResult.value;
      tracer.jitCompile(
        compiledFn.name || "<anonymous>",
        `Poly-inlined call to "${target.name}" (target ${i + 1}/${targets.length}) at bc:${bytecodeIdx}`,
      );
    } else {
      const knownCall = ir.irCallKnownFunction(target, args);
      knownCall.frameState = frameState;
      hitBlock.addNode(knownCall);
      hitEndBlock = hitBlock;
      hitValue = knownCall;
    }

    resultPhi.addInput(hitValue);
    const jumpToMerge = ir.irJump(mergeBlock);
    hitEndBlock.addNode(jumpToMerge);
    hitEndBlock.addSuccessor(mergeBlock, [hitValue]);

    if (i === targets.length - 1) {
      const fallbackCall = ir.irGenericCall(callee, args);
      if (receiver) fallbackCall.props.isMethod = true;
      fallbackCall.frameState = frameState;
      missBlock.addNode(fallbackCall);
      resultPhi.addInput(fallbackCall);
      const jumpFallback = ir.irJump(mergeBlock);
      missBlock.addNode(jumpFallback);
      missBlock.addSuccessor(mergeBlock, [fallbackCall]);
    } else {
      block = missBlock;
    }
  }

  return { block: mergeBlock, value: resultPhi };
}

function canInlineTarget(
  target: AnyCompiledFunction | null | undefined,
  compiledFn: AnyCompiledFunction,
  argCount: number,
  graph: AnyGraph,
): boolean {
  if (!target) return false;
  if (target === compiledFn) return false;
  if (target.isClassConstructor) return false;
  if (target.paramCount !== argCount) return false;
  if (referencesUpvalues(target)) return false;
  if (referencesThis(target)) return false;
  if (!target.feedbackVector) return false;
  const size = target.instructions.length;
  const maxSize = 150;
  if (size > maxSize) return false;
  if ((graph.inlineBudgetRemaining ?? 0) < size) return false;
  return true;
}

const COLD_CALL_THRESHOLD = 5;
const ACC_SLOT = -1;

export function selectInlineTarget(
  callHint: InlineCallHint | null | undefined,
  compiledFn: AnyCompiledFunction,
  argCount: number,
  graph: AnyGraph,
): InlineDecision {
  if (!callHint || !callHint.slot)
    return { target: null, targets: null, reason: "missing-feedback" };

  if (callHint.frequency < COLD_CALL_THRESHOLD) {
    return { target: null, targets: null, reason: "cold-call-site" };
  }

  if (callHint.kind === FEEDBACK_HINT_MONOMORPHIC) {
    const target = callHint.targetRef;
    if (!canInlineTarget(target, compiledFn, argCount, graph)) {
      return { target: null, targets: null, reason: "cannot-inline" };
    }
    return { target: target ?? null, targets: null, reason: "inlined" };
  }

  if (callHint.kind === FEEDBACK_HINT_POLYMORPHIC) {
    const polyTargets = callHint.targets;
    if (!polyTargets)
      return { target: null, targets: null, reason: "no-poly-targets" };
    const viable = polyTargets.filter((t) =>
      canInlineTarget(t.ref, compiledFn, argCount, graph),
    );
    if (viable.length >= 2) {
      return { target: null, targets: viable, reason: "polymorphic-inline" };
    }
    if (viable.length === 1) {
      return { target: viable[0].ref, targets: null, reason: "inlined" };
    }
    return { target: null, targets: null, reason: "poly-no-viable" };
  }

  return {
    target: null,
    targets: null,
    reason: callHint.kind || FEEDBACK_HINT_GENERIC,
  };
}

export function recordInlineDecision(
  callHint: InlineCallHint | null | undefined,
  kind: string,
  reason: string,
): void {
  if (callHint && callHint.slot)
    callHint.slot.recordInlineDecision(kind, reason);
}

export function tryInline(
  targetFn: AnyCompiledFunction,
  graph: AnyGraph,
  block: AnyBlock,
  callerAcc: AnyNode | null,
  callerRegs: NodeMap,
  args: AnyNode[],
  callerFn: AnyCompiledFunction,
  callerBcIdx: number,
  callerBlockMap: Map<number, AnyBlock>,
  callerLoopPhiMap: Map<number, Map<number, AnyNode>>,
  frameStates: FrameStateList,
  inlineThis: AnyNode | null = null,
  callerFrameFactory: (() => FrameState) | null = null,
): InlineResult {
  if (!targetFn.feedbackVector) return null;

  const instructions = targetFn.instructions;
  const inlineRegs: NodeMap = new Map();

  for (let i = 0; i < targetFn.paramCount; i++) {
    if (i < args.length) {
      inlineRegs.set(i, args[i]);
    } else {
      const undef = ir.irConstant(undefined);
      block.addNode(undef);
      inlineRegs.set(i, undef);
    }
  }

  const inlineBlockMap = new Map<number, AnyBlock>();

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (
      instr.opcode === bytecode.ROP_JUMP ||
      instr.opcode === bytecode.ROP_JUMP_IF_FALSE ||
      instr.opcode === bytecode.ROP_JUMP_IF_TRUE
    ) {
      const target = instr.operands[0];
      if (!inlineBlockMap.has(target)) {
        inlineBlockMap.set(target, graph.addBlock());
      }
      if (i + 1 < instructions.length && !inlineBlockMap.has(i + 1)) {
        inlineBlockMap.set(i + 1, graph.addBlock());
      }
    }
  }

  const hasControlFlow = inlineBlockMap.size > 0;
  let hasBackwardJump = false;
  if (hasControlFlow) {
    for (let i = 0; i < instructions.length; i++) {
      const instr = instructions[i];
      if (
        instr.opcode === bytecode.ROP_JUMP ||
        instr.opcode === bytecode.ROP_JUMP_IF_FALSE ||
        instr.opcode === bytecode.ROP_JUMP_IF_TRUE
      ) {
        const target = instr.operands[0];
        if (target <= i) {
          hasBackwardJump = true;
          if (instructions.length > 80) return null;
          if (!inlineBlockMap.has(target)) {
            inlineBlockMap.set(target, graph.addBlock());
          }
        }
      }
    }
  }

  const feedback = new FeedbackNexus(targetFn.feedbackVector);
  const returnValues: AnyNode[] = [];
  const returnBlocks: AnyBlock[] = [];

  const blockAccs = new Map<number, AnyNode | null | undefined>();
  const blockRegsMap = new Map<number, NodeMap>();
  const makeCallerFrame =
    callerFrameFactory ||
    (() =>
      captureFrameStateWithCaller(
        callerFn,
        callerBcIdx + 1,
        callerRegs,
        [],
        frameStates,
        null,
      ));
  const captureInlineFrameState = (
    bytecodeOffset: number,
    regs: NodeMap,
    stack: InlineStack,
  ) =>
    captureFrameStateWithCaller(
      targetFn,
      bytecodeOffset,
      regs,
      stack,
      frameStates,
      makeCallerFrame(),
    );

  const compileInlineInstruction = (
    instr: RegisterInstructionLike,
    currentBlock: AnyBlock,
    inlineAcc: AnyNode | null,
    inlineRegs: NodeMap,
    inlineBcIdx: number,
  ) => {
    if (instr.opcode === bytecode.ROP_LDA_REG) {
      const reg = instr.operands[0];
      return {
        block: currentBlock,
        acc: inlineRegs.get(reg) || ir.irConstant(undefined),
      };
    }

    if (instr.opcode === bytecode.ROP_STAR) {
      const reg = instr.operands[0];
      inlineRegs.set(reg, inlineAcc);
      return { block: currentBlock, acc: inlineAcc };
    }

    if (instr.opcode === bytecode.ROP_MOV) {
      const dst = instr.operands[0];
      const src = instr.operands[1];
      inlineRegs.set(dst, inlineRegs.get(src) || ir.irConstant(undefined));
      return { block: currentBlock, acc: inlineAcc };
    }

    if (instr.opcode === bytecode.ROP_LDA_CONST) {
      const value = targetFn.constants[instr.operands[0]];
      const node = ir.irConstant(value);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_LDA_TRUE) {
      const node = ir.irConstant(true);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_LDA_FALSE) {
      const node = ir.irConstant(false);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_LDA_UNDEFINED) {
      const node = ir.irConstant(undefined);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_LDA_NULL) {
      const node = ir.irConstant(null);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (
      instr.opcode === bytecode.ROP_ADD ||
      instr.opcode === bytecode.ROP_SUB ||
      instr.opcode === bytecode.ROP_MUL ||
      instr.opcode === bytecode.ROP_DIV ||
      instr.opcode === bytecode.ROP_MOD
    ) {
      const rhsReg = instr.operands[0];
      const left = inlineAcc;
      const right = inlineRegs.get(rhsReg) || ir.irConstant(undefined);

      let result;
      if (instr.opcode === bytecode.ROP_ADD)
        result = ir.irGenericAdd(left, right);
      else if (instr.opcode === bytecode.ROP_SUB)
        result = ir.irGenericSub(left, right);
      else if (instr.opcode === bytecode.ROP_MUL)
        result = ir.irGenericMul(left, right);
      else if (instr.opcode === bytecode.ROP_DIV)
        result = ir.irGenericDiv(left, right);
      else result = ir.irGenericMod(left, right);
      currentBlock.addNode(result);
      return { block: currentBlock, acc: result };
    }

    if (
      instr.opcode === bytecode.ROP_EQ ||
      instr.opcode === bytecode.ROP_NEQ ||
      instr.opcode === bytecode.ROP_LOOSE_EQ ||
      instr.opcode === bytecode.ROP_LOOSE_NEQ ||
      instr.opcode === bytecode.ROP_LT ||
      instr.opcode === bytecode.ROP_GT ||
      instr.opcode === bytecode.ROP_LTE ||
      instr.opcode === bytecode.ROP_GTE
    ) {
      const rhsReg = instr.operands[0];
      const left = inlineAcc;
      const right = inlineRegs.get(rhsReg) || ir.irConstant(undefined);
      const cmpOp = (COMPARE_OP_MAP as Record<number, string>)[instr.opcode];

      const cmp = ir.irGenericCompare(cmpOp, left, right);
      currentBlock.addNode(cmp);
      return { block: currentBlock, acc: cmp };
    }

    if (instr.opcode === bytecode.ROP_LDA_PROP) {
      const objReg = instr.operands[0];
      const propNameIdx = instr.operands[1];
      const fbIdx = instr.operands.length > 2 ? instr.operands[2] : -1;
      const propName = targetFn.constants[propNameIdx];
      const propertyHint: PropertyHint | null = fbIdx >= 0 ? feedback.property(fbIdx) : null;
      const elementsHint: ElementsHint | null = fbIdx >= 0 ? feedback.elements(fbIdx) : null;
      const obj = inlineRegs.get(objReg) || ir.irConstant(undefined);

      if (propName === "length" && elementsHint && elementsHint.lengthAccess) {
        const elementsKind = elementsHint.elementsKind;
        const elementRep = numericPackedElementRep(elementsKind);
        if (elementRep && elementsKind != null) {
          const frameState = captureInlineFrameState(
            inlineBcIdx,
            inlineRegs,
            [inlineAcc],
          );
          const chkArray = ir.irCheckArray(obj);
          chkArray.frameState = frameState;
          currentBlock.addNode(chkArray);
          const chkKind = ir.irCheckElementsKind(chkArray, elementsKind);
          chkKind.frameState = frameState;
          currentBlock.addNode(chkKind);
          graph.addDependency(DEP_ELEMENTS_KIND, elementsKind);
          const loadLength = ir.irLoadArrayLength(chkKind);
          currentBlock.addNode(loadLength);
          return { block: currentBlock, acc: loadLength };
        } else {
          const node = ir.irGenericGetProp(obj, propName);
          currentBlock.addNode(node);
          return { block: currentBlock, acc: node };
        }
      } else if (
        propertyHint &&
        propertyHint.kind === FEEDBACK_HINT_MONOMORPHIC
      ) {
        const mapId = propertyHint.map;
        const offset = propertyHint.offset;
        const mapVersion = propertyHint.mapVersion;
        const protoDepth = propertyHint.protoDepth;
        if (protoDepth !== 0 || mapId == null || offset == null || mapVersion == null) {
          const node = ir.irGenericGetProp(obj, propName);
          currentBlock.addNode(node);
          return { block: currentBlock, acc: node };
        }
        const frameState = captureInlineFrameState(inlineBcIdx, inlineRegs, [
          inlineAcc,
        ]);
        const check = ir.irCheckMap(obj, mapId, mapVersion);
        check.frameState = frameState;
        currentBlock.addNode(check);
        graph.addDependency(DEP_MAP, mapId, mapVersion);
        const load = ir.irLoadField(check, offset);
        currentBlock.addNode(load);
        return { block: currentBlock, acc: load };
      } else if (
        propertyHint &&
        propertyHint.kind === FEEDBACK_HINT_POLYMORPHIC
      ) {
        const maps = propertyHint.maps;
        const offsets = propertyHint.offsets;
        const protoDepths = propertyHint.protoDepths || [];
        if (maps && offsets && protoDepths.every((depth) => depth === 0)) {
          const frameState = captureInlineFrameState(
            inlineBcIdx,
            inlineRegs,
            [inlineAcc],
          );
          const load = ir.irPolymorphicLoad(obj, maps, offsets);
          load.frameState = frameState;
          currentBlock.addNode(load);
          return { block: currentBlock, acc: load };
        }
        const node = ir.irGenericGetProp(obj, propName);
        currentBlock.addNode(node);
        return { block: currentBlock, acc: node };
      } else {
        const node = ir.irGenericGetProp(obj, propName);
        currentBlock.addNode(node);
        return { block: currentBlock, acc: node };
      }
    }

    if (instr.opcode === bytecode.ROP_STA_PROP) {
      const objReg = instr.operands[0];
      const propNameIdx = instr.operands[1];
      const fbIdx = instr.operands.length > 2 ? instr.operands[2] : -1;
      const propName = targetFn.constants[propNameIdx];
      const propertyHint: PropertyHint | null = fbIdx >= 0 ? feedback.property(fbIdx) : null;
      const obj = inlineRegs.get(objReg) || ir.irConstant(undefined);
      if (propertyHint && propertyHint.kind === FEEDBACK_HINT_MONOMORPHIC) {
        if (
          propertyHint.protoDepth !== 0 ||
          propertyHint.map == null ||
          propertyHint.mapVersion == null ||
          propertyHint.offset == null
        ) {
          const node = ir.irGenericSetProp(obj, propName, inlineAcc);
          currentBlock.addNode(node);
          return { block: currentBlock, acc: inlineAcc };
        }
        const frameState = captureInlineFrameState(inlineBcIdx, inlineRegs, [
          inlineAcc,
        ]);
        const check = ir.irCheckMap(
          obj,
          propertyHint.map,
          propertyHint.mapVersion,
        );
        check.frameState = frameState;
        currentBlock.addNode(check);
        graph.addDependency(DEP_MAP, propertyHint.map, propertyHint.mapVersion);
        const store = ir.irStoreField(
          check,
          propertyHint.offset,
          inlineAcc,
          typeof propName === "string" ? propName : undefined,
        );
        currentBlock.addNode(store);
      } else if (
        propertyHint &&
        propertyHint.kind === FEEDBACK_HINT_POLYMORPHIC
      ) {
        const protoDepths = propertyHint.protoDepths || [];
        if (
          propertyHint.maps &&
          propertyHint.offsets &&
          protoDepths.every((depth) => depth === 0)
        ) {
          const frameState = captureInlineFrameState(
            inlineBcIdx,
            inlineRegs,
            [inlineAcc],
          );
          const store = ir.irPolymorphicStore(
            obj,
            propertyHint.maps,
            propertyHint.offsets,
            inlineAcc,
          );
          store.frameState = frameState;
          currentBlock.addNode(store);
        } else {
          const node = ir.irGenericSetProp(obj, propName, inlineAcc);
          currentBlock.addNode(node);
        }
      } else {
        const node = ir.irGenericSetProp(obj, propName, inlineAcc);
        currentBlock.addNode(node);
      }
      return { block: currentBlock, acc: inlineAcc };
    }

    if (instr.opcode === bytecode.ROP_LDA_INDEX) {
      const objReg = instr.operands[0];
      const indexReg = instr.operands[1];
      const fbIdx = instr.operands.length > 2 ? instr.operands[2] : -1;
      const obj = inlineRegs.get(objReg) || ir.irConstant(undefined);
      const index = inlineRegs.get(indexReg) || ir.irConstant(undefined);
      const elementsHint: ElementsHint | null = fbIdx >= 0 ? feedback.elements(fbIdx) : null;
      if (elementsHint && elementsHint.arrayAccess) {
        const elementsKind = elementsHint.elementsKind;
        const elementRep = numericPackedElementRep(elementsKind);
        if (elementRep && elementsKind != null) {
          const frameState = captureInlineFrameState(
            inlineBcIdx,
            inlineRegs,
            [],
          );
          const chkArray = ir.irCheckArray(obj);
          chkArray.frameState = frameState;
          currentBlock.addNode(chkArray);
          const chkKind = ir.irCheckElementsKind(chkArray, elementsKind);
          chkKind.frameState = frameState;
          currentBlock.addNode(chkKind);
          graph.addDependency(DEP_ELEMENTS_KIND, elementsKind);
          const chkSmi = ir.irCheckSmi(index);
          chkSmi.frameState = frameState;
          currentBlock.addNode(chkSmi);
          const chkBounds = ir.irCheckBounds(chkSmi, chkKind);
          chkBounds.frameState = frameState;
          currentBlock.addNode(chkBounds);
          const loadElem = ir.irLoadElement(
            chkKind,
            chkSmi,
            elementsKind,
            elementRep,
            true,
          );
          currentBlock.addNode(loadElem);
          return { block: currentBlock, acc: loadElem };
        }
      }
      const node = ir.irGenericGetIndex(obj, index);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_STA_INDEX) {
      const objReg = instr.operands[0];
      const indexReg = instr.operands[1];
      const fbIdx = instr.operands.length > 2 ? instr.operands[2] : -1;
      const obj = inlineRegs.get(objReg) || ir.irConstant(undefined);
      const index = inlineRegs.get(indexReg) || ir.irConstant(undefined);
      const elementsHint: ElementsHint | null = fbIdx >= 0 ? feedback.elements(fbIdx) : null;
      if (elementsHint && elementsHint.arrayAccess) {
        const elementsKind = elementsHint.elementsKind;
        const elementRep = numericPackedElementRep(elementsKind);
        if (elementRep && elementsKind != null) {
          const frameState = captureInlineFrameState(
            inlineBcIdx,
            inlineRegs,
            [],
          );
          const chkArray = ir.irCheckArray(obj);
          chkArray.frameState = frameState;
          currentBlock.addNode(chkArray);
          const chkKind = ir.irCheckElementsKind(chkArray, elementsKind);
          chkKind.frameState = frameState;
          currentBlock.addNode(chkKind);
          graph.addDependency(DEP_ELEMENTS_KIND, elementsKind);
          const chkSmi = ir.irCheckSmi(index);
          chkSmi.frameState = frameState;
          currentBlock.addNode(chkSmi);
          const chkBounds = ir.irCheckBounds(chkSmi, chkKind);
          chkBounds.frameState = frameState;
          currentBlock.addNode(chkBounds);
          const storeElem = ir.irStoreElement(
            chkKind,
            chkSmi,
            inlineAcc,
            elementsKind,
            elementRep,
            true,
          );
          currentBlock.addNode(storeElem);
          return { block: currentBlock, acc: inlineAcc };
        }
      }
      const node = ir.irGenericSetIndex(obj, index, inlineAcc);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: inlineAcc };
    }

    if (instr.opcode === bytecode.ROP_NOT) {
      const node = ir.irNot(inlineAcc);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_NEG) {
      const node = ir.irNeg(inlineAcc);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_IS_NULLISH) {
      const left = inlineAcc || ir.irConstant(undefined);
      const nullConstant = ir.irConstant(null);
      currentBlock.addNode(nullConstant);
      const node = ir.irGenericCompare("loose==", left, nullConstant);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_LDA_GLOBAL) {
      const name = constantString(targetFn.constants, instr.operands[0]);
      const node = ir.irLoadGlobal(name);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_NEW_OBJECT) {
      const node = ir.irNewObject();
      node.frameState = captureInlineFrameState(inlineBcIdx, inlineRegs, []);
      currentBlock.addNode(node);
      return { block: currentBlock, acc: node };
    }

    if (instr.opcode === bytecode.ROP_LDA_THIS) {
      if (inlineThis) {
        return { block: currentBlock, acc: inlineThis };
      } else {
        const node = ir.irConstant(undefined);
        currentBlock.addNode(node);
        return { block: currentBlock, acc: node };
      }
    }

    if (
      instr.opcode === bytecode.ROP_CALL ||
      instr.opcode === bytecode.ROP_CALL_METHOD
    ) {
      let callee,
        receiver = null;
      const callArgs = [];

      if (instr.opcode === bytecode.ROP_CALL) {
        const calleeReg = instr.operands[0];
        const arg0Reg = instr.operands[1];
        const argCount = instr.operands[2];
        const fbIdx = instr.operands.length > 3 ? instr.operands[3] : -1;
        callee = inlineRegs.get(calleeReg) || ir.irConstant(undefined);
        for (let i = 0; i < argCount; i++)
          callArgs.push(
            inlineRegs.get(arg0Reg + i) || ir.irConstant(undefined),
          );
        const callHint = fbIdx >= 0 ? feedback.call(fbIdx) : null;
        const decision = selectInlineTarget(
          callHint,
          targetFn,
          argCount,
          graph,
        );
        if (decision.target) {
          const frameState = captureInlineFrameState(inlineBcIdx, inlineRegs, [
            callee,
          ]);
          const targetCheck = ir.irCheckCallTarget(callee, decision.target);
          targetCheck.props.deoptOnMiss = true;
          targetCheck.frameState = frameState;
          currentBlock.addNode(targetCheck);
          const nested = tryInline(
            decision.target,
            graph,
            currentBlock,
            inlineAcc,
            inlineRegs,
            callArgs,
            targetFn,
            inlineBcIdx,
            callerBlockMap,
            callerLoopPhiMap,
            frameStates,
            null,
            () =>
              captureFrameStateWithCaller(
                targetFn,
                inlineBcIdx + 1,
                inlineRegs,
                [],
                frameStates,
                makeCallerFrame(),
              ),
          );
          if (nested !== null) {
            graph.inlineBudgetRemaining -= decision.target.instructions.length;
            graph.addDependency(
              DEP_CALL_TARGET,
              decision.target.id,
              decision.target.version,
            );
            recordInlineDecision(
              callHint,
              "inlined",
              decision.target.name || "<anonymous>",
            );
            tracer.jitCompile(
              callerFn.name || "<anonymous>",
              `Inlined nested call to "${decision.target.name}" at caller bc:${callerBcIdx}`,
            );
            return { block: nested.block, acc: nested.value };
          }
          recordInlineDecision(callHint, "failed", "unsupported-opcode");
        } else if (callHint && callHint.slot) {
          recordInlineDecision(callHint, "failed", decision.reason);
        }
        const node = ir.irGenericCall(callee, callArgs);
        node.frameState = captureInlineFrameState(inlineBcIdx, inlineRegs, [
          callee,
        ]);
        currentBlock.addNode(node);
        return { block: currentBlock, acc: node };
      } else {
        const receiverReg = instr.operands[0];
        const arg0Reg = instr.operands[1];
        const argCount = instr.operands[2];
        const fbIdx = instr.operands.length > 3 ? instr.operands[3] : -1;
        receiver = inlineRegs.get(receiverReg) || ir.irConstant(undefined);
        for (let i = 0; i < argCount; i++)
          callArgs.push(
            inlineRegs.get(arg0Reg + i) || ir.irConstant(undefined),
          );
        callee = inlineAcc;
        const callHint = fbIdx >= 0 ? feedback.call(fbIdx) : null;
        const decision = selectInlineTarget(
          callHint,
          targetFn,
          argCount,
          graph,
        );
        if (decision.target) {
          const frameState = captureInlineFrameState(inlineBcIdx, inlineRegs, [
            callee,
          ]);
          const targetCheck = ir.irCheckCallTarget(callee, decision.target);
          targetCheck.props.deoptOnMiss = true;
          targetCheck.frameState = frameState;
          currentBlock.addNode(targetCheck);
          const nested = tryInline(
            decision.target,
            graph,
            currentBlock,
            inlineAcc,
            inlineRegs,
            callArgs,
            targetFn,
            inlineBcIdx,
            callerBlockMap,
            callerLoopPhiMap,
            frameStates,
            receiver,
            () =>
              captureFrameStateWithCaller(
                targetFn,
                inlineBcIdx + 1,
                inlineRegs,
                [],
                frameStates,
                makeCallerFrame(),
              ),
          );
          if (nested !== null) {
            graph.inlineBudgetRemaining -= decision.target.instructions.length;
            graph.addDependency(
              DEP_CALL_TARGET,
              decision.target.id,
              decision.target.version,
            );
            recordInlineDecision(
              callHint,
              "inlined",
              decision.target.name || "<anonymous>",
            );
            return { block: nested.block, acc: nested.value };
          }
          recordInlineDecision(callHint, "failed", "unsupported-opcode");
        } else if (callHint && callHint.slot) {
          recordInlineDecision(callHint, "failed", decision.reason);
        }
        const node = ir.irGenericCall(callee, [receiver, ...callArgs]);
        node.props.isMethod = true;
        node.frameState = captureInlineFrameState(inlineBcIdx, inlineRegs, [
          callee,
        ]);
        currentBlock.addNode(node);
        return { block: currentBlock, acc: node };
      }
    }
    return null;
  };

  let currentBlock = block;
  let inlineAcc: AnyNode | null = null;
  let currentRegs: NodeMap;

  if (!hasControlFlow) {
    currentRegs = inlineRegs;
    let returnValue = null;

    for (let i = 0; i < instructions.length; i++) {
      const instr = instructions[i];

      if (instr.opcode === bytecode.ROP_RETURN) {
        returnValue = inlineAcc || ir.irConstant(undefined);
        break;
      }

      const result = compileInlineInstruction(
        instr,
        currentBlock,
        inlineAcc,
        currentRegs,
        i,
      );
      if (result === null) return null;
      currentBlock = result.block;
      inlineAcc = result.acc;
    }

    if (returnValue === null) {
      returnValue = ir.irConstant(undefined);
      currentBlock.addNode(returnValue);
    }

    return { value: returnValue, block: currentBlock };
  }

  currentRegs = inlineRegs;
  inlineAcc = null;

  const visitedBlocks = new Set();

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];

    if (inlineBlockMap.has(i)) {
      const targetBlock = inlineBlockMap.get(i);
      if (!targetBlock) return null;

      if (!currentBlock.isTerminated()) {
        const jumpNode = ir.irJump(targetBlock);
        currentBlock.addNode(jumpNode);
        currentBlock.addSuccessor(targetBlock);
      }

      if (!blockAccs.has(i)) {
        blockAccs.set(i, inlineAcc);
        blockRegsMap.set(i, new Map<number, AnyNode | null>(currentRegs));
      }

      currentBlock = targetBlock;

      if (blockAccs.has(i)) {
        inlineAcc = blockAccs.get(i) ?? null;
        const savedRegs = blockRegsMap.get(i);
        if (!savedRegs) return null;
        currentRegs = new Map<number, AnyNode | null>(savedRegs);
      }
    }

    if (currentBlock.isTerminated()) continue;

    if (instr.opcode === bytecode.ROP_RETURN) {
      const retVal = inlineAcc || ir.irConstant(undefined);
      if (retVal.type === undefined) {
        currentBlock.addNode(retVal);
      }
      returnValues.push(retVal);
      returnBlocks.push(currentBlock);
      continue;
    }

    if (instr.opcode === bytecode.ROP_JUMP) {
      const target = instr.operands[0];
      const targetBlock = inlineBlockMap.get(target);
      if (!targetBlock) return null;

      if (!blockAccs.has(target)) {
        blockAccs.set(target, inlineAcc);
        blockRegsMap.set(target, new Map<number, AnyNode | null>(currentRegs));
      }

      const jumpNode = ir.irJump(targetBlock);
      currentBlock.addNode(jumpNode);
      currentBlock.addSuccessor(targetBlock);
      continue;
    }

    if (
      instr.opcode === bytecode.ROP_JUMP_IF_FALSE ||
      instr.opcode === bytecode.ROP_JUMP_IF_TRUE
    ) {
      const target = instr.operands[0];
      const condition = inlineAcc;
      const falseTarget = inlineBlockMap.get(target);
      const trueTarget = inlineBlockMap.get(i + 1);
      if (!falseTarget || !trueTarget) return null;

      if (!blockAccs.has(target)) {
        blockAccs.set(target, inlineAcc);
        blockRegsMap.set(target, new Map<number, AnyNode | null>(currentRegs));
      }
      if (!blockAccs.has(i + 1)) {
        blockAccs.set(i + 1, inlineAcc);
        blockRegsMap.set(i + 1, new Map<number, AnyNode | null>(currentRegs));
      }

      const branchNode =
        instr.opcode === bytecode.ROP_JUMP_IF_FALSE
          ? ir.irBranch(condition, trueTarget, falseTarget)
          : ir.irBranch(condition, falseTarget, trueTarget);
      currentBlock.addNode(branchNode);
      currentBlock.addSuccessor(trueTarget);
      currentBlock.addSuccessor(falseTarget);
      continue;
    }

    const result = compileInlineInstruction(
      instr,
      currentBlock,
      inlineAcc,
      currentRegs,
      i,
    );
    if (result === null) return null;
    currentBlock = result.block;
    inlineAcc = result.acc;
  }

  if (returnValues.length === 0) {
    const retVal = ir.irConstant(undefined);
    currentBlock.addNode(retVal);
    return { value: retVal, block: currentBlock };
  }

  if (returnValues.length === 1) {
    const continuationBlock = graph.addBlock();
    const retBlock = returnBlocks[0];
    if (!retBlock.isTerminated()) {
      const jumpNode = ir.irJump(continuationBlock);
      retBlock.addNode(jumpNode);
      retBlock.addSuccessor(continuationBlock);
    }
    return { value: returnValues[0], block: continuationBlock };
  }

  const mergeBlock = graph.addBlock();
  for (let r = 0; r < returnBlocks.length; r++) {
    const retBlock = returnBlocks[r];
    if (!retBlock.isTerminated()) {
      const jumpNode = ir.irJump(mergeBlock);
      retBlock.addNode(jumpNode);
      retBlock.addSuccessor(mergeBlock, [returnValues[r]]);
    }
  }

  const phi = mergeBlock.addParam(returnValues);

  return { value: phi, block: mergeBlock };
}
