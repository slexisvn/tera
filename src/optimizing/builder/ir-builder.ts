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
  constantStrings,
} from "./feedback-utils.js";
import { genericDeletePropNode } from "./property-nodes.js";
import {
  openLoopHeader,
  addLoopBackedgeInputs,
  rememberIncomingState,
  mergeIncomingState,
  type IncomingStatesByTarget,
} from "./cfg-state.js";
import { addPhi, link } from "../ir/cfg-edit.js";
import {
  handlerStacksOf,
  recordPendingThrow,
  recoverAfterCall,
  returnPendingThrow,
  type PendingThrowLanding,
} from "./throw-recovery.js";

import {
  CLASS_PROTOTYPE_PROPERTY,
  superClassBindingOwner,
} from "../../core/class-member.js";
import { CLASS_VALUE_PROP, classValueNameOf } from "../metadata/class-symbols.js";
import { NAMED_ARGUMENTS_PROP } from "../metadata/call-signatures.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  THROW_BUILTIN,
} from "../metadata/builtin-methods.js";

const HANDLER_OPCODES = {
  tryStart: bytecode.ROP_TRY_START,
  tryEnd: bytecode.ROP_TRY_END,
  jump: bytecode.ROP_JUMP,
  jumpIfTrue: bytecode.ROP_JUMP_IF_TRUE,
  jumpIfFalse: bytecode.ROP_JUMP_IF_FALSE,
  returns: bytecode.ROP_RETURN,
  throws: bytecode.ROP_THROW,
} as const;

const RECOVERABLE_CALLS: ReadonlySet<number> = new Set([
  bytecode.ROP_CALL,
  bytecode.ROP_CALL_METHOD,
  bytecode.ROP_CALL_NAMED,
  bytecode.ROP_CALL_METHOD_NAMED,
  bytecode.ROP_AWAIT,
]);

const ITERATOR_NODES: ReadonlyMap<number, (value: ir.CFGInstruction) => ir.CFGInstruction> =
  new Map([
    [bytecode.ROP_GET_ITERATOR, ir.irIteratorInit],
    [bytecode.ROP_ITER_NEXT, ir.irIteratorNext],
    [bytecode.ROP_ITER_DONE, ir.irIteratorDone],
    [bytecode.ROP_ITER_VALUE, ir.irIteratorValue],
  ]);

const CLASS_DECLARATION_OPCODES: ReadonlySet<number> = new Set<number>([
  bytecode.ROP_DEFINE_CLASS_MEMBER,
  bytecode.ROP_DEFINE_ACCESSOR,
  bytecode.ROP_SET_PROTO,
  bytecode.ROP_ASSERT_CLASS_CONTRACTS,
]);

export const AWAITED_CALL_PROP = "awaited";

const AWAITABLE_CALLS: ReadonlySet<number> = new Set<number>([
  bytecode.ROP_CALL,
  bytecode.ROP_CALL_METHOD,
  bytecode.ROP_CALL_INTRINSIC,
]);

export const SUSPENDING_AWAIT_REASON =
  "await of a value that is not the call it came from suspends this function, " +
  "and the compiler has no coroutines yet; await each call where it is made, " +
  "or keep the suspending part interpreted";

const UNSUPPORTED_REASONS: ReadonlyMap<number, string> = new Map([
  [bytecode.ROP_AWAIT, SUSPENDING_AWAIT_REASON],
]);

function bailOut(
  graph: AnyGraph,
  compiledFn: AnyCompiledFunction,
  op: number,
  bytecodeIdx: number,
): void {
  const explained = UNSUPPORTED_REASONS.get(op);
  const reason =
    explained ??
    `unhandled opcode ${bytecode.rOpcodeName(op)} (0x${op.toString(16)}) at bc:${bytecodeIdx}`;
  graph.bailout ??= reason;
  tracer.jitCompile(functionName(compiledFn), `Bailout: ${reason}`);
}

function isClassMemberValue(value: unknown): boolean {
  return (
    value instanceof bytecode.RegisterCompiledFunction &&
    value.classMemberKind !== null &&
    value.classMemberKind !== undefined
  );
}

function classConstructorName(value: unknown): string | null {
  if (!(value instanceof bytecode.RegisterCompiledFunction)) return null;
  if (value.classMemberKind !== "constructor") return null;
  return value.classOwnerName ?? value.name;
}

function superClassValueName(graph: AnyGraph, binding: string | undefined): string | null {
  const derived = superClassBindingOwner(binding);
  return derived === null ? null : graph.classes?.shapeOf(derived)?.parent ?? null;
}

function markClassValue(graph: AnyGraph, node: AnyNode, name: string | null): void {
  if (graph.classes === null || node === null || name === null) return;
  if (graph.classes.shapeOf(name) === null) return;
  node.props[CLASS_VALUE_PROP] = name;
}

function isClassValue(node: AnyNode | undefined): boolean {
  return classValueNameOf(node ?? null) !== null;
}

function defineStaticField(
  graph: AnyGraph,
  block: AnyBlock,
  acc: AnyNode,
  regs: NodeMap,
  compiledFn: AnyCompiledFunction,
  operands: readonly number[],
): void {
  const owner = regs.get(operands[0]!) ?? null;
  const name = classValueNameOf(owner);
  const shape = name === null ? null : graph.classes?.shapeOf(name) ?? null;
  const member = constantString(compiledFn.constants, operands[1]!);
  if (shape === null || acc === null || !shape.staticFields.has(member)) return;
  block.addNode(ir.irGenericSetProp(owner!, member, acc));
}
import { captureFrameState } from "./frame-state.js";
import {
  buildPolymorphicDispatch,
  selectInlineTarget,
  recordInlineDecision,
  tryInline,
} from "./inline.js";
import { createIntrinsicOptimizationMetadata, intrinsicCallMetadata, type IntrinsicOptimizationMetadata } from "../metadata/intrinsics.js";

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

function upvalueSlot(upvalue: bytecode.UpvalueDescriptor | undefined): number | null {
  if (!upvalue) return null;
  const slot = upvalue.outerSlot ?? upvalue.index;
  return typeof slot === "number" ? slot : null;
}

function closureCaptures(target: bytecode.RegisterCompiledFunction): ir.ClosureCapture[] {
  const captures: ir.ClosureCapture[] = [];
  for (const upvalue of target.upvalues) {
    const slot = upvalueSlot(upvalue);
    if (slot === null) continue;
    captures.push({
      source:
        upvalue?.outerType === "upvalue" || upvalue?.isLocal === false
          ? "upvalue"
          : "local",
      slot,
    });
  }
  return captures;
}

function capturedLocalSlots(
  compiledFn: AnyCompiledFunction,
  erased: ReadonlySet<number>,
): Set<number> {
  const slots = new Set<number>();
  for (const instr of compiledFn.instructions) {
    if (instr.opcode !== bytecode.ROP_MAKE_CLOSURE) continue;
    const target = compiledFn.constants[instr.operands[0]];
    if (!(target instanceof bytecode.RegisterCompiledFunction)) continue;
    for (const capture of closureCaptures(target)) {
      if (capture.source === "local" && !erased.has(capture.slot)) slots.add(capture.slot);
    }
  }
  return slots;
}

function genericGetPropWithHint(
  obj: ir.CFGInstruction,
  propName: string,
  hint: { primitiveReceiver?: string } | null,
): ir.CFGInstruction {
  const node = ir.irGenericGetProp(obj, propName);
  if (hint?.primitiveReceiver !== undefined) {
    node.props.receiverPrimitive = hint.primitiveReceiver;
  }
  return node;
}

function landingOf(handlers: readonly number[], blockMap: BlockMap): PendingThrowLanding | null {
  const target = handlers.length === 0 ? undefined : handlers[handlers.length - 1];
  if (target === undefined) return null;
  const handler = blockMap.get(target);
  return handler === undefined ? null : { handler, target };
}

export function buildIR(
  graph: AnyGraph,
  currentBlock: AnyBlock,
  compiledFn: AnyCompiledFunction,
  feedback: FeedbackSource,
  frameStates: FrameStateList,
  intrinsicMetadata: IntrinsicOptimizationMetadata = createIntrinsicOptimizationMetadata(),
): void {
  const nexus =
    feedback instanceof FeedbackNexus ? feedback : new FeedbackNexus(feedback);
  let acc: AnyNode = null;
  const regs: NodeMap = new Map();
  graph.inlineBudgetRemaining = 400;

  const receiverSlots = graph.receiver === true ? 1 : 0;
  for (let i = 0; i < compiledFn.paramCount; i++) {
    regs.set(i, graph.parameters[i + receiverSlots]);
  }

  const contextSlots = capturedLocalSlots(
    compiledFn,
    graph.classes === null ? new Set<number>() : new Set(compiledFn.classBindingSlots ?? []),
  );
  if (contextSlots.size > 0) {
    for (const slot of contextSlots) {
      const initial =
        regs.get(slot) || ir.homeInstruction(ir.irConstant(undefined), currentBlock);
      const store = ir.irStoreContextSlot(slot, initial);
      store.frameState = captureFrameState(
        compiledFn,
        0,
        regs,
        [initial],
        frameStates,
      );
      currentBlock.addNode(store);
      regs.set(slot, store);
    }
  }

  const instructions = compiledFn.instructions;
  const blockMap: BlockMap = new Map();

  const recovers = graph.recoversThrows;
  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (
      instr.opcode === bytecode.ROP_JUMP ||
      instr.opcode === bytecode.ROP_JUMP_IF_FALSE ||
      instr.opcode === bytecode.ROP_JUMP_IF_TRUE ||
      (recovers && instr.opcode === bytecode.ROP_TRY_START)
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
  const handlerStacks = recovers
    ? handlerStacksOf(instructions, HANDLER_OPCODES)
    : ([] as ReadonlyArray<readonly number[]>);

  for (let i = 0; i < instructions.length; i++) {
    if (blockMap.has(i)) {
      const nextBlock = blockMap.get(i)!;
      const predecessorBlock = currentBlock;
      const hasFallthrough = !predecessorBlock.isTerminated();
      if (hasFallthrough) {
        rememberIncomingState(savedBlockRegs, i, predecessorBlock, regs, acc);
        const jmp = ir.irJump(nextBlock);
        predecessorBlock.addNode(jmp);
        link(predecessorBlock, nextBlock);
      }
      currentBlock = nextBlock;

      const incomingStates = savedBlockRegs.get(i) ?? [];
      if (!nextBlock.isLoopHeader) {
        acc = mergeIncomingState(nextBlock, incomingStates, regs, acc);
      }

      if (nextBlock.isLoopHeader) {
        const phis = openLoopHeader(
          nextBlock,
          incomingStates,
          regs,
          compiledFn.localCount,
          hasFallthrough ? predecessorBlock : nextBlock,
        );
        const slots = [...phis.keys()];
        loopPhiMap.set(nextBlock.id, phis);
        graph.osrCandidates.set(i, {
          headerBlockId: nextBlock.id,
          slots,
          phiIds: slots.map((slot) => phis.get(slot)!.id),
        });
      }
    }

    const instr = instructions[i];
    if (currentBlock.isTerminated()) continue;
    const handlers = handlerStacks[i] ?? [];
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
      intrinsicMetadata,
      contextSlots,
      handlers,
    );
    acc = currentBlock._lastAcc !== undefined ? currentBlock._lastAcc : acc;
    if (recovers && RECOVERABLE_CALLS.has(instr.opcode) && !currentBlock.isTerminated()) {
      currentBlock = recoverAfterCall(
        graph,
        currentBlock,
        landingOf(handlers, blockMap),
        regs,
        savedBlockRegs,
      );
      currentBlock._lastAcc = acc;
    }
  }

  for (const block of graph.blocks) {
    const phis = loopPhiMap.get(block.id);
    if (!phis) continue;
    for (const phi of phis.values()) {
      while (phi.inputs.length < block.predecessors.length) phi.addInput(phi);
    }
  }
}

function closeLoopEdge(
  targetBlock: AnyBlock,
  target: number,
  block: AnyBlock,
  regs: NodeMap,
  loopPhiMap: LoopPhiMap,
  savedBlockRegs: SavedBlockRegs,
): void {
  if (!targetBlock.isLoopHeader) return;
  const phis = loopPhiMap.get(targetBlock.id);
  if (!phis) return;
  addLoopBackedgeInputs(targetBlock, phis, savedBlockRegs, target, block, regs);
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
  intrinsicMetadata: IntrinsicOptimizationMetadata,
  contextSlots: ReadonlySet<number>,
  handlers: readonly number[],
): AnyBlock {
  const op = instr.opcode;
  const operands = instr.operands;

  switch (op) {
    case bytecode.ROP_LDA_CONST: {
      const value = compiledFn.constants[operands[0]];
      const node = ir.irConstant(value);
      markClassValue(graph, node, classConstructorName(value));
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_MAKE_CLOSURE: {
      const value = compiledFn.constants[operands[0]];
      let captures: ir.ClosureCapture[] = [];
      if (value instanceof bytecode.RegisterCompiledFunction) {
        captures = closureCaptures(value);
        if (captures.length !== value.upvalues.length) {
          throw new Error("Invalid closure capture descriptor");
        }
      }
      const node =
        value instanceof bytecode.RegisterCompiledFunction && value.upvalues.length > 0
          ? ir.irMakeClosure(operands[0], value, captures)
          : ir.irConstant(value);
      markClassValue(graph, node, classConstructorName(value));
      if (graph.classes !== null && isClassMemberValue(value)) {
        block._lastAcc = node;
        break;
      }
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

    case bytecode.ROP_LDA_UPVALUE: {
      const node = ir.irLoadContextSlot(operands[0], "upvalue");
      markClassValue(
        graph,
        node,
        superClassValueName(graph, compiledFn.upvalues[operands[0]]?.name),
      );
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

    case bytecode.ROP_STA_UPVALUE: {
      const value = acc || ir.homeInstruction(ir.irConstant(undefined), block);
      const node = ir.irStoreContextSlot(operands[0], value, "upvalue");
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
      if (graph.receiver === true) {
        block._lastAcc = graph.parameters[0];
        break;
      }
      const node = ir.irConstant(undefined);
      node.props.isThis = true;
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_LDA_REG: {
      const reg = operands[0];
      if (contextSlots.has(reg)) {
        const node = ir.irLoadContextSlot(reg);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [],
          frameStates,
        );
        block.addNode(node);
        regs.set(reg, node);
        block._lastAcc = node;
        break;
      }
      const node = regs.get(reg) || ir.irConstant(undefined);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_STAR: {
      const reg = operands[0];
      if (contextSlots.has(reg)) {
        const value = acc || ir.homeInstruction(ir.irConstant(undefined), block);
        const node = ir.irStoreContextSlot(reg, value);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [value],
          frameStates,
        );
        block.addNode(node);
        regs.set(reg, node);
        break;
      }
      regs.set(reg, acc);
      break;
    }

    case bytecode.ROP_MOV: {
      const src = operands[0];
      const dst = operands[1];
      let value: ir.CFGInstruction;
      if (contextSlots.has(src)) {
        const node = ir.irLoadContextSlot(src);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [],
          frameStates,
        );
        block.addNode(node);
        regs.set(src, node);
        value = node;
      } else {
        value = regs.get(src) || ir.homeInstruction(ir.irConstant(undefined), block);
      }
      if (contextSlots.has(dst)) {
        const node = ir.irStoreContextSlot(dst, value);
        node.frameState = captureFrameState(
          compiledFn,
          bytecodeIdx,
          regs,
          [value],
          frameStates,
        );
        block.addNode(node);
        regs.set(dst, node);
      } else {
        regs.set(dst, value);
      }
      break;
    }

    case bytecode.ROP_LDA_GLOBAL: {
      const nameIdx = operands[0];
      const name = constantString(compiledFn.constants, nameIdx);
      const node = ir.irLoadGlobal(name);
      markClassValue(graph, node, name);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_STA_GLOBAL: {
      if (isClassValue(acc)) break;
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
      const classValue = regs.get(objReg);
      if (propName === CLASS_PROTOTYPE_PROPERTY && isClassValue(classValue)) {
        block._lastAcc = classValue ?? null;
        break;
      }
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
          const node = genericGetPropWithHint(obj, propName, propertyHint);
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
          const node = genericGetPropWithHint(obj, propName, propertyHint);
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
          const node = genericGetPropWithHint(obj, propName, propertyHint);
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
        const node = genericGetPropWithHint(obj, propName, propertyHint);
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
        const store = ir.irStoreField(check, offset, value, propName);
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

    case bytecode.ROP_DELETE_PROP: {
      const node = genericDeletePropNode(instr, compiledFn, regs);
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
        closeLoopEdge(targetBlock, target, block, regs, loopPhiMap, savedBlockRegs);
        const jmp = ir.irJump(targetBlock);
        block.addNode(jmp);
        link(block, targetBlock);
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
      if (falseBlock) {
        closeLoopEdge(falseBlock, target, block, regs, loopPhiMap, savedBlockRegs);
      }

      if (falseBlock && trueBlock && trueBlock !== falseBlock) {
        const branch =
          op === bytecode.ROP_JUMP_IF_FALSE
            ? ir.irBranch(condition, trueBlock, falseBlock)
            : ir.irBranch(condition, falseBlock, trueBlock);
        block.addNode(branch);
        link(block, trueBlock);
        link(block, falseBlock);
      } else if (falseBlock && trueBlock) {
        const jmp = ir.irJump(trueBlock);
        block.addNode(jmp);
        link(block, trueBlock);
      } else if (falseBlock) {
        const branch = new ir.IRNode(ir.IR_BRANCH, {
          trueBlock: -1,
          falseBlock: falseBlock.id,
        });
        branch.addInput(condition);
        block.addNode(branch);
        link(block, falseBlock);
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

    case bytecode.ROP_CALL_INTRINSIC: {
      const name = constantString(compiledFn.constants, operands[0]);
      const arg0Reg = operands[1];
      const argCount = operands[2];
      const args = [];
      for (let i = 0; i < argCount; i++) {
        args.push(regs.get(arg0Reg + i) || ir.irConstant(undefined));
      }
      const node = new ir.IRNode(ir.IR_CALL_INTRINSIC, {
        ...intrinsicCallMetadata(name, argCount, intrinsicMetadata),
      });
      for (const arg of args) node.addInput(arg);
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

    case bytecode.ROP_GET_ITERATOR:
    case bytecode.ROP_ITER_NEXT:
    case bytecode.ROP_ITER_DONE:
    case bytecode.ROP_ITER_VALUE: {
      if (graph.classes === null || acc === null) {
        bailOut(graph, compiledFn, op, bytecodeIdx);
        break;
      }
      const node = ITERATOR_NODES.get(op)!(acc);
      block.addNode(node);
      if (op === bytecode.ROP_ITER_NEXT) {
        for (const [slot, value] of regs) {
          if (value === acc) regs.set(slot, node);
        }
      }
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_CALL_NAMED:
    case bytecode.ROP_CALL_METHOD_NAMED: {
      const isMethod = op === bytecode.ROP_CALL_METHOD_NAMED;
      const [leadReg, arg0Reg, argCount, named0Reg, namesIdx, namedCount] = operands;
      const lead = regs.get(leadReg) || ir.irConstant(undefined);
      const callee = isMethod ? acc || ir.irConstant(undefined) : lead;
      const args: ir.CFGInstruction[] = isMethod ? [lead] : [];
      for (let i = 0; i < argCount; i++) {
        args.push(regs.get(arg0Reg + i) || ir.irConstant(undefined));
      }
      for (let i = 0; i < namedCount; i++) {
        args.push(regs.get(named0Reg + i) || ir.irConstant(undefined));
      }
      const node = ir.irGenericCall(callee, args);
      if (isMethod) node.props.isMethod = true;
      node.props[NAMED_ARGUMENTS_PROP] = constantStrings(compiledFn.constants, namesIdx);
      node.frameState = captureFrameState(compiledFn, bytecodeIdx, regs, [callee], frameStates);
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
              const store = ir.irStoreField(newObj, item.offset, value, item.field.name);
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

    case bytecode.ROP_TRY_START:
    case bytecode.ROP_TRY_END: {
      if (!graph.recoversThrows) bailOut(graph, compiledFn, op, bytecodeIdx);
      break;
    }

    case bytecode.ROP_CALL_SPREAD: {
      const spread = regs.get(operands[1]) ?? null;
      if (spread === null || spread.type !== ir.IR_NEW_ARRAY || spread.uses.length > 0) {
        bailOut(graph, compiledFn, op, bytecodeIdx);
        break;
      }
      const callee = regs.get(operands[0]) || ir.irConstant(undefined);
      const receiver = operands[2] ? regs.get(operands[2]) ?? null : null;
      const args = receiver === null ? [...spread.inputs] : [receiver, ...spread.inputs];
      const node = ir.irGenericCall(callee, args);
      if (receiver !== null) node.props.isMethod = true;
      node.frameState = captureFrameState(compiledFn, bytecodeIdx, regs, [callee], frameStates);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    case bytecode.ROP_REST_ARGS: {
      if (graph.gatheredArguments === null) {
        bailOut(graph, compiledFn, op, bytecodeIdx);
        break;
      }
      const first = operands[0] + (graph.receiver === true ? 1 : 0);
      const gathered = ir.irNewArray(graph.parameters.slice(first));
      gathered.frameState = captureFrameState(compiledFn, bytecodeIdx, regs, [], frameStates);
      block.addNode(gathered);
      block._lastAcc = gathered;
      break;
    }

    case bytecode.ROP_THROW: {
      const thrown = acc ?? ir.irConstant(undefined);
      if (graph.recoversThrows) {
        const landing = landingOf(handlers, blockMap);
        if (landing === null) {
          recordPendingThrow(block, thrown);
          returnPendingThrow(block);
          break;
        }
        rememberIncomingState(savedBlockRegs, landing.target, block, regs, thrown);
        block.addNode(ir.irJump(landing.handler));
        link(block, landing.handler);
        break;
      }
      const intrinsic = builtinGlobalIntrinsicByName(THROW_BUILTIN)!;
      const node = ir.irCallBuiltin(
        THROW_BUILTIN,
        [thrown],
        builtinMethodCallMetadata(intrinsic),
      );
      node.frameState = captureFrameState(
        compiledFn,
        bytecodeIdx,
        regs,
        [thrown],
        frameStates,
      );
      block.addNode(node);
      break;
    }

    case bytecode.ROP_RETURN: {
      const constructed =
        graph.receiver === true && compiledFn.classMemberKind === "constructor"
          ? graph.parameters[0]
          : null;
      const value = constructed ?? acc ?? ir.irConstant(undefined);
      const ret = ir.irReturn(value);
      block.addNode(ret);
      break;
    }

    case bytecode.ROP_AWAIT: {
      const awaited = block._lastAcc ?? acc;
      if (!awaited) {
        bailOut(graph, compiledFn, op, bytecodeIdx);
        break;
      }
      const previous = compiledFn.instructions[bytecodeIdx - 1];
      if (previous !== undefined && AWAITABLE_CALLS.has(previous.opcode)) {
        awaited.props[AWAITED_CALL_PROP] = true;
      }
      const node = ir.irAwait(awaited);
      block.addNode(node);
      block._lastAcc = node;
      break;
    }

    default: {
      if (graph.classes !== null && CLASS_DECLARATION_OPCODES.has(op)) {
        if (op === bytecode.ROP_DEFINE_CLASS_MEMBER) {
          defineStaticField(graph, block, acc, regs, compiledFn, operands);
        }
        break;
      }
      bailOut(graph, compiledFn, op, bytecodeIdx);
      break;
    }
  }
  return block;
}

export { captureFrameState, COMPARE_OP_MAP };

