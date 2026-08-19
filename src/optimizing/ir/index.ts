import type { RuntimeValue } from "../../core/value/index.js";
import type { DeclaredSignature } from "../types/signature.js";
import type { Representation } from "../types/representation.js";
import type { ClassTable } from "../metadata/class-table.js";
import type { StringEscapeModel } from "../analyses/aot-legality.js";
import type { AotScalar } from "../types/scalar.js";
import * as ops from "./operations.js";
import { canDeoptimize, isTerminator } from "./operations.js";

export * from "./operations.js";


import type { FrameState, FrameValue } from "../../deopt/frame-state.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";

export class IRNodeIdAllocator {
  private nextNodeId: number;

  constructor(start = 0) {
    this.nextNodeId = start;
  }

  next(): number {
    return this.nextNodeId++;
  }

  reset(): void {
    this.nextNodeId = 0;
  }
}

const defaultIRNodeIdAllocator = new IRNodeIdAllocator();
let activeIRNodeIdAllocator = defaultIRNodeIdAllocator;

export function withIRNodeIdAllocator<T>(allocator: IRNodeIdAllocator, run: () => T): T {
  const previous = activeIRNodeIdAllocator;
  activeIRNodeIdAllocator = allocator;
  try {
    return run();
  } finally {
    activeIRNodeIdAllocator = previous;
  }
}

export function getCurrentIRNodeIdAllocator(): IRNodeIdAllocator {
  return activeIRNodeIdAllocator;
}

export function getDefaultIRNodeIdAllocator(): IRNodeIdAllocator {
  return defaultIRNodeIdAllocator;
}

export type IRPrimitive = string | number | boolean | symbol | null | undefined;
export type IRMetadataValue =
  | IRPrimitive
  | RuntimeValue
  | CFGInstruction
  | CFGBlock
  | CFGFunction
  | FrameState
  | RegisterCompiledFunction
  | { readonly [key: string]: IRMetadataValue }
  | IRMetadataValue[]
  | Map<IRMetadataValue, IRMetadataValue>
  | Set<IRMetadataValue>;
export type IRMetadata = Record<string, IRMetadataValue>;
export type IRValueLike =
  | RuntimeValue
  | IRPrimitive
  | CFGInstruction
  | CFGBlock
  | CFGFunction
  | RegisterCompiledFunction;
type CFGDependency = { kind: string; id: string | number; version: number | null };
export type OsrCandidate = {
  headerBlockId: number;
  slots: number[];
  phiIds: number[];
};
export type ContextSlotSource = "local" | "upvalue";
export type ClosureCapture = { source: ContextSlotSource; slot: number };

export function irRequiresFrameState(node: IRValueLike) {
  if (!(node instanceof CFGInstruction)) return false;
  return canDeoptimize(node);
}

function dropOneUse(producer: CFGInstruction, user: CFGInstruction): void {
  const at = producer.uses.indexOf(user);
  if (at >= 0) producer.uses.splice(at, 1);
}

export class CFGInstruction {
  id: number;
  type: ops.Opcode;
  props: IRMetadata;
  inputs: CFGInstruction[];
  uses: CFGInstruction[];
  rep: IRMetadataValue | null;
  frameState: FrameState | null;
  block: CFGBlock | null;
  _deadForSelfRecursion?: boolean;
  _speculativeType?: string;
  _constPtrIndex?: number;
  _inlineNumericStore?: boolean;

  constructor(opcode: ops.Opcode, props: IRMetadata = {}) {
    this.id = activeIRNodeIdAllocator.next();
    this.type = opcode;
    this.props = props;
    this.inputs = [];
    this.uses = [];
    this.rep = props._rep || null;
    this.frameState = null;
    this.block = null;
  }

  addInput(value: IRValueLike) {
    if (!(value instanceof CFGInstruction)) {
      throw new Error(`IR input must be an instruction, got ${valueLabel(value)}`);
    }
    this.inputs.push(value);
    value.uses.push(this);
  }

  replaceInput(index: number, value: IRValueLike) {
    if (!(value instanceof CFGInstruction)) {
      throw new Error(`IR input must be an instruction, got ${valueLabel(value)}`);
    }
    const old = this.inputs[index];
    dropOneUse(old, this);
    this.inputs[index] = value;
    value.uses.push(this);
  }

  toString() {
    const inputIds = this.inputs.map((n) => valueLabel(n)).join(", ");
    const propsStr = Object.entries(this.props)
      .map(([k, v]) => `${k}=${typeof v === "string" ? '"' + v + '"' : String(v)}`)
      .join(", ");
    const fs = this.frameState ? ` {fs}` : "";
    const rep = this.props._rep ? ` :${String(this.props._rep)}` : "";
    const effectTag = isTerminator(this.type) ? " <terminator>" : "";
    return `v${this.id} = ${this.type}(${inputIds})${rep}${propsStr ? " [" + propsStr + "]" : ""}${effectTag}${fs}`;
  }
}

export function trivialPhiInput<T extends { inputs?: readonly (T | null | undefined)[] }>(
  phi: T,
): T | null {
  let candidate: T | null = null;
  for (const input of phi.inputs ?? []) {
    if (!input || input === phi) continue;
    if (!candidate) {
      candidate = input;
      continue;
    }
    if (candidate !== input) return null;
  }
  return candidate;
}

export function missingPhiRuntimeValueMessage(phi: { id?: unknown }): string {
  return `Cannot materialize non-trivial Phi v${String(phi.id ?? "?")} without runtime value`;
}

export class CFGBlock {
  id: number;
  nodes: CFGInstruction[];
  instructions: CFGInstruction[];
  phis: CFGInstruction[];
  predecessors: CFGBlock[];
  successors: CFGBlock[];
  terminator: CFGInstruction | null;
  isLoopHeader: boolean;
  _lastAcc?: CFGInstruction | null;

  constructor(id: number) {
    this.id = id;
    this.nodes = [];
    this.instructions = this.nodes;
    this.phis = [];
    this.predecessors = [];
    this.successors = [];
    this.terminator = null;
    this.isLoopHeader = false;
  }

  addNode(instruction: CFGInstruction) {
    instruction.block = this;
    if (isTerminator(instruction.type)) this.terminator = instruction;
    this.nodes.push(instruction);
    return instruction;
  }

  getTerminator() {
    if (this.terminator && this.nodes.includes(this.terminator))
      return this.terminator;
    const last = this.nodes[this.nodes.length - 1];
    if (last && isTerminator(last.type)) {
      this.terminator = last;
      return last;
    }
    return null;
  }

  isTerminated() {
    return this.getTerminator() !== null;
  }
}

export class CFGFunction {
  name: string;
  blocks: CFGBlock[];
  entry: CFGBlock | null;
  parameterCount: number;
  parameters: CFGInstruction[];
  dependencies: CFGDependency[];
  private readonly dependencyKeys: Set<string>;
  inlineBudgetRemaining: number;
  bailout: string | null;
  osrCandidates: Map<number, OsrCandidate>;
  osrParamSlots: number[] | null;
  declaredSignature: DeclaredSignature | null;
  returnRepresentation: Representation | null;
  classes: ClassTable | null;
  classOwner: string | null;
  calleeSignatures: ReadonlyMap<string, DeclaredSignature> | null;
  stringEscapes: StringEscapeModel | null;
  receiver: boolean;
  internal: boolean;
  reentrant: boolean;
  recoversThrows: boolean;
  isAsync: boolean;
  gatheredArguments: number | null;
  private nextBlockId: number;
  _frameStateIndex?: Map<FrameValue, { replace(next: FrameValue): void }[]> | null;

  constructor(name: string) {
    this.name = name;
    this.blocks = [];
    this.entry = null;
    this.parameterCount = 0;
    this.parameters = [];
    this.dependencies = [];
    this.dependencyKeys = new Set();
    this.bailout = null;
    this.inlineBudgetRemaining = 0;
    this.osrCandidates = new Map();
    this.osrParamSlots = null;
    this.declaredSignature = null;
    this.returnRepresentation = null;
    this.classes = null;
    this.classOwner = null;
    this.calleeSignatures = null;
    this.stringEscapes = null;
    this.reentrant = false;
    this.receiver = false;
    this.internal = false;
    this.recoversThrows = false;
    this.isAsync = false;
    this.gatheredArguments = null;
    this.nextBlockId = 0;
  }

  addBlock() {
    const block = new CFGBlock(this.nextBlockId++);
    this.blocks.push(block);
    if (!this.entry) this.entry = block;
    return block;
  }

  addParameter(index: number) {
    const param = new CFGInstruction(ops.IR_PARAMETER, { index });
    this.parameters.push(param);
    this.parameterCount++;
    return param;
  }

  takeBlocks(blocks: CFGBlock[], entry: CFGBlock) {
    this.blocks = blocks;
    this.entry = entry;
    for (const block of blocks) this.nextBlockId = Math.max(this.nextBlockId, block.id + 1);
  }

  addDependency(kind: string, id: string | number, version: number | null = null) {
    const key = `${kind}:${id}:${version ?? ""}`;
    if (this.dependencyKeys.has(key)) return;
    this.dependencyKeys.add(key);
    this.dependencies.push({ kind, id, version });
  }

  rebuildUses() {
    const values = [...this.parameters];
    for (const block of this.blocks) values.push(...block.nodes);
    for (const value of values) value.uses = [];
    for (const block of this.blocks) {
      for (const instr of block.nodes) {
        for (const input of instr.inputs) {
          input.uses.push(instr);
        }
      }
    }
  }

  dump() {
    let out = `=== CFG Function: ${this.name} ===\n`;

    if (this.parameters.length > 0) {
      out += `Parameters:\n`;
      for (const p of this.parameters) out += `  ${p.toString()}\n`;
    }

    for (const block of this.blocks) {
      const preds = block.predecessors.map((b) => `B${b.id}`).join(", ");
      const succs = block.successors.map((b) => `B${b.id}`).join(", ");
      const phis = block.phis
        .map((p) => `v${p.id}=[${p.inputs.map((v) => valueLabel(v)).join(", ")}]`)
        .join(", ");
      const flags = [];
      if (block.isLoopHeader) flags.push("loop-header");
      const flagStr = flags.length ? ` (${flags.join(", ")})` : "";
      const predsStr = preds ? ` <- [${preds}]` : "";
      const succsStr = succs ? ` -> [${succs}]` : "";

      out += `\nBlock B${block.id}${phis ? `(${phis})` : ""}${flagStr}${predsStr}${succsStr}:\n`;
      for (const node of block.nodes) out += `  ${node.toString()}\n`;
    }

    out += `=== End CFG Function ===\n`;
    return out;
  }
}

export function homeInstruction(
  node: CFGInstruction,
  block: CFGBlock,
): CFGInstruction {
  if (node.block) {
    node.block.nodes = node.block.nodes.filter((n) => n !== node);
  }
  node.block = block;
  block.nodes.splice(block.phis.length, 0, node);
  return node;
}

export const IRNode = CFGInstruction;
export const IRBlock = CFGBlock;
export const IRGraph = CFGFunction;

function valueLabel(value: IRValueLike): string {
  if (value instanceof CFGInstruction) return `v${value.id}`;
  if (value instanceof CFGBlock) return `B${value.id}`;
  if (value instanceof CFGFunction) return value.name;
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    (typeof value.id === "string" || typeof value.id === "number")
  ) {
    return `fn${value.id}`;
  }
  return String(value);
}

export function irParameter(index: number) {
  return new IRNode(ops.IR_PARAMETER, { index });
}

export function irConstant(value: IRValueLike) {
  return new IRNode(ops.IR_CONSTANT, { value });
}

export function irCheckMap(obj: IRValueLike, expectedMapId: IRValueLike, expectedMapVersion: IRValueLike= null) {
  const node = new IRNode(ops.IR_CHECK_MAP, { expectedMapId, expectedMapVersion });
  node.addInput(obj);
  return node;
}

export function irCheckPrimitive(value: IRValueLike, primitive: string) {
  const node = new IRNode(ops.IR_CHECK_PRIMITIVE, { primitive });
  node.addInput(value);
  return node;
}

export function irCheckSmi(value: IRValueLike) {
  const node = new IRNode(ops.IR_CHECK_SMI);
  node.addInput(value);
  return node;
}

export function irCheckNumber(value: IRValueLike) {
  const node = new IRNode(ops.IR_CHECK_NUMBER);
  node.addInput(value);
  return node;
}

export function irInt32Add(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_ADD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Sub(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_SUB);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Mul(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_MUL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Div(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_DIV);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Mod(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_MOD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Add(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_FLOAT64_ADD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Sub(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_FLOAT64_SUB);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Mul(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_FLOAT64_MUL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Div(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_FLOAT64_DIV);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Compare(op: string, left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_COMPARE, { op });
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Compare(op: string, left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_FLOAT64_COMPARE, { op });
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function allocationShapeOf(node: { props: Record<string, unknown> }): { id: number; size: number } {
  const id = Number(node.props.classId);
  const size = Number(node.props.instanceSize);
  if (!Number.isInteger(id) || !Number.isInteger(size)) {
    throw new Error("allocation has no class shape");
  }
  return { id, size };
}

export function fieldScalarOf(node: { props: Record<string, unknown> }): AotScalar {
  const scalar = node.props.fieldScalar;
  if (typeof scalar !== "string") throw new Error("field access has no scalar type");
  return scalar as AotScalar;
}

export function heapElementScalarOf(node: { props: Record<string, unknown> }): AotScalar | null {
  const scalar = node.props.elementScalar;
  return typeof scalar === "string" ? (scalar as AotScalar) : null;
}

export function fieldOffsetOf(node: { props: Record<string, unknown> }): number {
  const offset = Number(node.props.offset);
  if (!Number.isInteger(offset)) throw new Error("field access has no integer offset");
  return offset;
}

export function irLoadField(obj: IRValueLike, offset: number) {
  const node = new IRNode(ops.IR_LOAD_FIELD, { offset });
  node.addInput(obj);
  return node;
}

export function irPolymorphicLoad(obj: IRValueLike, maps: IRValueLike[], offsets: IRValueLike[]) {
  const node = new IRNode(ops.IR_POLYMORPHIC_LOAD, { maps, offsets });
  node.addInput(obj);
  return node;
}

export function irPolymorphicStore(obj: IRValueLike, maps: IRValueLike[], offsets: IRValueLike[], value: IRValueLike) {
  const node = new IRNode(ops.IR_POLYMORPHIC_STORE, { maps, offsets });
  node.addInput(obj);
  node.addInput(value);
  return node;
}

export function irStoreField(
  obj: IRValueLike,
  offset: number,
  value: IRValueLike,
  propName?: string,
) {
  const node = new IRNode(ops.IR_STORE_FIELD, { offset, propName });
  node.addInput(obj);
  node.addInput(value);
  return node;
}

export function textCapacityOf(node: { props: Record<string, unknown> }): number {
  const capacity = Number(node.props.textCapacity);
  if (!Number.isInteger(capacity)) throw new Error("text access has no integer capacity");
  return capacity;
}

export function irLoadText(
  obj: IRValueLike,
  offset: number,
  textCapacity: number,
  propName?: string,
) {
  const node = new IRNode(ops.IR_LOAD_TEXT, { offset, textCapacity, propName });
  node.addInput(obj);
  return node;
}

export function irStoreText(
  obj: IRValueLike,
  offset: number,
  value: IRValueLike,
  textCapacity: number,
  propName?: string,
) {
  const node = new IRNode(ops.IR_STORE_TEXT, { offset, textCapacity, propName });
  node.addInput(obj);
  node.addInput(value);
  return node;
}

export function irGenericAdd(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_ADD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericSub(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_SUB);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericMul(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_MUL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericDiv(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_DIV);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericMod(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_MOD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericCompare(op: string, left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_COMPARE, { op });
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericGetProp(obj: IRValueLike, propName: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_GET_PROP, { propName });
  node.addInput(obj);
  return node;
}

export function irGenericSetProp(obj: IRValueLike, propName: IRValueLike, value: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_SET_PROP, { propName });
  node.addInput(obj);
  node.addInput(value);
  return node;
}

export function irGenericDeleteProp(obj: IRValueLike, keyOrPropName: IRValueLike) {
  const isDynamicKey = keyOrPropName instanceof CFGInstruction;
  const node = new IRNode(
    ops.IR_GENERIC_DELETE_PROP,
    isDynamicKey ? {} : { propName: keyOrPropName },
  );
  node.addInput(obj);
  if (isDynamicKey) node.addInput(keyOrPropName);
  return node;
}

export function irGenericCall(callee: IRValueLike, args: IRValueLike[]) {
  const node = new IRNode(ops.IR_GENERIC_CALL, { argCount: args.length });
  node.addInput(callee);
  for (const arg of args) {
    node.addInput(arg);
  }
  return node;
}

export function irCheckCallTarget(callee: IRValueLike, expectedTarget: IRValueLike) {
  const node = new IRNode(ops.IR_CHECK_CALL_TARGET, { expectedTarget });
  node.addInput(callee);
  return node;
}

export function irCallKnownFunction(target: IRValueLike, args: IRValueLike[]) {
  const node = new IRNode(ops.IR_CALL_KNOWN_FUNCTION, {
    target,
    argCount: args.length,
  });
  for (const arg of args) {
    node.addInput(arg);
  }
  return node;
}

export function irCallBuiltin(
  name: string,
  args: IRValueLike[],
  metadata: IRMetadata = {},
) {
  const node = new IRNode(ops.IR_CALL_BUILTIN, {
    ...metadata,
    name,
    argCount: args.length,
  });
  for (const arg of args) {
    node.addInput(arg);
  }
  return node;
}

export function irGenericGetIndex(obj: IRValueLike, index: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_GET_INDEX);
  node.addInput(obj);
  node.addInput(index);
  return node;
}

export function irGenericSetIndex(obj: IRValueLike, index: IRValueLike, value: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_SET_INDEX);
  node.addInput(obj);
  node.addInput(index);
  node.addInput(value);
  return node;
}

export function irInt32Or(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_OR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Xor(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_XOR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Ushr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_USHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Not(value: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_NOT);
  node.addInput(value);
  return node;
}

export function irFloat64Pow(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_FLOAT64_POW);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitand(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_BITAND);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitor(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_BITOR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitxor(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_BITXOR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericShl(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_SHL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericShr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_SHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericUshr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_USHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericPow(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_POW);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitnot(value: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_BITNOT);
  node.addInput(value);
  return node;
}

export function irGenericInstanceof(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_INSTANCEOF);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericIn(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_GENERIC_IN);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irReturn(value: IRValueLike) {
  const node = new IRNode(ops.IR_RETURN);
  node.addInput(value);
  return node;
}

export function irBranch(condition: IRValueLike, trueBlock: CFGBlock, falseBlock: CFGBlock) {
  const node = new IRNode(ops.IR_BRANCH, {
    trueBlock: trueBlock.id,
    falseBlock: falseBlock.id,
  });
  node.addInput(condition);
  return node;
}

export function irJump(targetBlock: CFGBlock) {
  return new IRNode(ops.IR_JUMP, { targetBlock: targetBlock.id });
}

export function irDeoptimize(reason: string) {
  return new IRNode(ops.IR_DEOPTIMIZE, { reason });
}

export function irBox(value: IRValueLike, fromType: string) {
  const node = new IRNode(ops.IR_BOX, { fromType });
  node.addInput(value);
  return node;
}

export function irUnbox(value: IRValueLike, toType: string) {
  const node = new IRNode(ops.IR_UNBOX, { toType });
  node.addInput(value);
  return node;
}

export function irNot(value: IRValueLike) {
  const node = new IRNode(ops.IR_NOT);
  node.addInput(value);
  return node;
}

export function irNeg(value: IRValueLike) {
  const node = new IRNode(ops.IR_NEG);
  node.addInput(value);
  return node;
}

export function irNewObject() {
  return new IRNode(ops.IR_NEW_OBJECT);
}

export function irArrayReserve(array: IRValueLike, buffer: number, elementBytes: number) {
  const node = new IRNode(ops.IR_ARRAY_RESERVE, { classId: buffer, elementBytes });
  node.addInput(array);
  return node;
}

export function arrayReserveOf(node: { props: Record<string, unknown> }): {
  buffer: number;
  elementBytes: number;
} {
  const buffer = Number(node.props.classId);
  const elementBytes = Number(node.props.elementBytes);
  if (!Number.isInteger(buffer) || !Number.isInteger(elementBytes)) {
    throw new Error("array growth has no buffer shape");
  }
  return { buffer, elementBytes };
}

export function irAwait(value: IRValueLike) {
  const node = new IRNode(ops.IR_AWAIT);
  node.addInput(value);
  return node;
}

export function irRuntimeBase(symbol: string) {
  const node = new IRNode(ops.IR_RUNTIME_BASE);
  node.props.symbol = symbol;
  return node;
}

function iteratorNode(opcode: ops.Opcode, operand: IRValueLike) {
  const node = new IRNode(opcode);
  node.addInput(operand);
  return node;
}

export function irIteratorInit(iterable: IRValueLike) {
  return iteratorNode(ops.IR_ITERATOR_INIT, iterable);
}

export function irIteratorNext(cursor: IRValueLike) {
  return iteratorNode(ops.IR_ITERATOR_NEXT, cursor);
}

export function irIteratorDone(cursor: IRValueLike) {
  return iteratorNode(ops.IR_ITERATOR_DONE, cursor);
}

export function irIteratorValue(cursor: IRValueLike) {
  return iteratorNode(ops.IR_ITERATOR_VALUE, cursor);
}

export function irNewArray(elements: IRValueLike[]) {
  const node = new IRNode(ops.IR_NEW_ARRAY, { elementCount: elements.length });
  for (const el of elements) {
    node.addInput(el);
  }
  return node;
}

export function irNewRegex(constIdx: number) {
  return new IRNode(ops.IR_NEW_REGEX, { constIdx });
}

export function irLoadLocal(slot: number) {
  return new IRNode(ops.IR_LOAD_LOCAL, { slot });
}

export function irStoreLocal(slot: number, value: IRValueLike) {
  const node = new IRNode(ops.IR_STORE_LOCAL, { slot });
  node.addInput(value);
  return node;
}

export function irLoadContextSlot(
  slot: number,
  source: ContextSlotSource = "local",
) {
  return new IRNode(ops.IR_LOAD_CONTEXT_SLOT, { slot, source });
}

export function irStoreContextSlot(
  slot: number,
  value: IRValueLike,
  source: ContextSlotSource = "local",
) {
  const node = new IRNode(ops.IR_STORE_CONTEXT_SLOT, { slot, source });
  node.addInput(value);
  return node;
}

export function irLoadGlobal(name: string) {
  return new IRNode(ops.IR_LOAD_GLOBAL, { name });
}

export function irStoreGlobal(name: string, value: IRValueLike) {
  const node = new IRNode(ops.IR_STORE_GLOBAL, { name });
  node.addInput(value);
  return node;
}

export function irMakeClosure(
  constIdx: number,
  compiled: IRMetadataValue,
  captures: ClosureCapture[],
) {
  const node = new IRNode(ops.IR_MAKE_CLOSURE, { constIdx, compiled, captures });
  return node;
}

export function irCheckArray(obj: IRValueLike) {
  const node = new IRNode(ops.IR_CHECK_ARRAY);
  node.addInput(obj);
  return node;
}

export function irCheckElementsKind(arrayObj: IRValueLike, elementsKind: IRValueLike) {
  const node = new IRNode(ops.IR_CHECK_ELEMENTS_KIND, { elementsKind });
  node.addInput(arrayObj);
  return node;
}

export function irCheckBounds(index: IRValueLike, arrayObj: IRValueLike) {
  const node = new IRNode(ops.IR_CHECK_BOUNDS);
  node.addInput(index);
  node.addInput(arrayObj);
  return node;
}

export function irLoadArrayLength(arrayObj: IRValueLike) {
  const node = new IRNode(ops.IR_LOAD_ARRAY_LENGTH);
  node.addInput(arrayObj);
  return node;
}

export function irLoadElement(
  arrayObj: IRValueLike,
  index: IRValueLike,
  elementsKind: IRValueLike = null,
  elementRep: IRValueLike = null,
  requiresBoundsCheck = true,
) {
  const node = new IRNode(ops.IR_LOAD_ELEMENT, {
    elementsKind,
    elementRep,
    requiresBoundsCheck,
  });
  node.addInput(arrayObj);
  node.addInput(index);
  return node;
}

export function irStoreElement(
  arrayObj: IRValueLike,
  index: IRValueLike,
  value: IRValueLike,
  elementsKind: IRValueLike = null,
  elementRep: IRValueLike = null,
  requiresBoundsCheck = true,
) {
  const node = new IRNode(ops.IR_STORE_ELEMENT, {
    elementsKind,
    elementRep,
    requiresBoundsCheck,
  });
  node.addInput(arrayObj);
  node.addInput(index);
  node.addInput(value);
  return node;
}

export function irInt32Shl(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_SHL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Shr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_SHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32And(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(ops.IR_INT32_AND);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function resetIRNodeIds() {
  activeIRNodeIdAllocator.reset();
}

