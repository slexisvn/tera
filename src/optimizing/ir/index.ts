export const IR_PARAMETER = "Parameter";
export const IR_CONSTANT = "Constant";
export const IR_CHECK_MAP = "CheckMap";
export const IR_CHECK_SMI = "CheckSmi";
export const IR_CHECK_NUMBER = "CheckNumber";
export const IR_CHECK_CALL_TARGET = "CheckCallTarget";
export const IR_CALL_KNOWN_FUNCTION = "CallKnownFunction";
export const IR_INT32_ADD = "Int32Add";
export const IR_INT32_SUB = "Int32Sub";
export const IR_INT32_MUL = "Int32Mul";
export const IR_INT32_DIV = "Int32Div";
export const IR_INT32_MOD = "Int32Mod";
export const IR_FLOAT64_ADD = "Float64Add";
export const IR_FLOAT64_SUB = "Float64Sub";
export const IR_FLOAT64_MUL = "Float64Mul";
export const IR_FLOAT64_DIV = "Float64Div";
export const IR_INT32_COMPARE = "Int32Compare";
export const IR_FLOAT64_COMPARE = "Float64Compare";
export const IR_LOAD_FIELD = "LoadField";
export const IR_STORE_FIELD = "StoreField";
export const IR_GENERIC_ADD = "GenericAdd";
export const IR_GENERIC_SUB = "GenericSub";
export const IR_GENERIC_MUL = "GenericMul";
export const IR_GENERIC_DIV = "GenericDiv";
export const IR_GENERIC_MOD = "GenericMod";
export const IR_GENERIC_COMPARE = "GenericCompare";
export const IR_CHECK_ARRAY = "CheckArray";
export const IR_CHECK_ELEMENTS_KIND = "CheckElementsKind";
export const IR_CHECK_BOUNDS = "CheckBounds";
export const IR_LOAD_ARRAY_LENGTH = "LoadArrayLength";
export const IR_LOAD_ELEMENT = "LoadElement";
export const IR_STORE_ELEMENT = "StoreElement";
export const IR_POLYMORPHIC_LOAD = "PolymorphicLoad";
export const IR_POLYMORPHIC_STORE = "PolymorphicStore";
export const IR_GENERIC_GET_PROP = "GenericGetProp";
export const IR_GENERIC_SET_PROP = "GenericSetProp";
export const IR_GENERIC_CALL = "GenericCall";
export const IR_LOAD_LOCAL = "LoadLocal";
export const IR_STORE_LOCAL = "StoreLocal";
export const IR_LOAD_GLOBAL = "LoadGlobal";
export const IR_STORE_GLOBAL = "StoreGlobal";
export const IR_BRANCH = "Branch";
export const IR_JUMP = "Jump";
export const IR_RETURN = "Return";
export const IR_DEOPTIMIZE = "Deoptimize";
export const IR_BLOCK_PARAM = "BlockParam";
export const IR_PHI = IR_BLOCK_PARAM;
export const IR_BOX = "Box";
export const IR_UNBOX = "Unbox";
export const IR_LOAD_CONST = "LoadConst";
export const IR_CALL_BUILTIN = "CallBuiltin";
export const IR_NEW_OBJECT = "NewObject";
export const IR_NEW_ARRAY = "NewArray";
export const IR_TYPEOF = "TypeOf";
export const IR_NOT = "Not";
export const IR_NEG = "Neg";
export const IR_GENERIC_GET_INDEX = "GenericGetIndex";
export const IR_GENERIC_SET_INDEX = "GenericSetIndex";
export const IR_INT32_SHL = "Int32Shl";
export const IR_INT32_SHR = "Int32Shr";
export const IR_INT32_USHR = "Int32Ushr";
export const IR_INT32_AND = "Int32And";
export const IR_INT32_OR = "Int32Or";
export const IR_INT32_XOR = "Int32Xor";
export const IR_INT32_NOT = "Int32Not";
export const IR_FLOAT64_POW = "Float64Pow";
export const IR_GENERIC_BITAND = "GenericBitwiseAnd";
export const IR_GENERIC_BITOR = "GenericBitwiseOr";
export const IR_GENERIC_BITXOR = "GenericBitwiseXor";
export const IR_GENERIC_SHL = "GenericShiftLeft";
export const IR_GENERIC_SHR = "GenericShiftRight";
export const IR_GENERIC_USHR = "GenericShiftRightLogical";
export const IR_GENERIC_POW = "GenericPow";
export const IR_GENERIC_BITNOT = "GenericBitwiseNot";
export const IR_GENERIC_INSTANCEOF = "GenericInstanceOf";
export const IR_GENERIC_IN = "GenericIn";
export const IR_DISPATCH_MAP = "DispatchMap";
export const IR_MEGAMORPHIC_LOAD = "MegamorphicLoad";
export const IR_MEGAMORPHIC_STORE = "MegamorphicStore";
export const IR_NEW_REGEX = "NewRegex";

import type { FrameState, FrameValue } from "../../deopt/frame-state.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";

let nextNodeId = 0;

export type EffectKind =
  | typeof EFFECT_NONE
  | typeof EFFECT_GUARD
  | typeof EFFECT_READ
  | typeof EFFECT_WRITE
  | typeof EFFECT_CALL
  | typeof EFFECT_ALLOC
  | typeof EFFECT_TERMINATOR;

export type IRPrimitive = string | number | boolean | symbol | null | undefined;
export type IRMetadataValue =
  | IRPrimitive
  | RuntimeValue
  | CFGValue
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
  | CFGValue
  | CFGInstruction
  | CFGBlock
  | CFGFunction
  | RegisterCompiledFunction;
type CFGDependency = { kind: string; id: string | number; version: number | null };

export const EFFECT_NONE = "none";
export const EFFECT_GUARD = "guard";
export const EFFECT_READ = "read";
export const EFFECT_WRITE = "write";
export const EFFECT_CALL = "call";
export const EFFECT_ALLOC = "alloc";
export const EFFECT_TERMINATOR = "terminator";

const TERMINATORS = new Set([IR_BRANCH, IR_JUMP, IR_RETURN, IR_DEOPTIMIZE]);
const WRITES = new Set([
  IR_STORE_FIELD,
  IR_STORE_ELEMENT,
  IR_STORE_GLOBAL,
  IR_STORE_LOCAL,
  IR_GENERIC_SET_PROP,
  IR_GENERIC_SET_INDEX,
  IR_POLYMORPHIC_STORE,
  IR_MEGAMORPHIC_STORE,
]);
const CALLS = new Set([
  IR_GENERIC_CALL,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
]);
const ALLOCS = new Set([IR_NEW_OBJECT, IR_NEW_ARRAY, IR_NEW_REGEX]);
const READS = new Set([
  IR_LOAD_FIELD,
  IR_LOAD_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_LOAD_GLOBAL,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_GET_INDEX,
  IR_POLYMORPHIC_LOAD,
  IR_DISPATCH_MAP,
  IR_MEGAMORPHIC_LOAD,
]);
const GUARDS = new Set([
  IR_CHECK_MAP,
  IR_CHECK_SMI,
  IR_CHECK_NUMBER,
  IR_CHECK_CALL_TARGET,
  IR_CHECK_ARRAY,
  IR_CHECK_ELEMENTS_KIND,
  IR_CHECK_BOUNDS,
]);
const DEOPT_CAPABLE = new Set([
  IR_CHECK_ARRAY,
  IR_CHECK_BOUNDS,
  IR_CHECK_CALL_TARGET,
  IR_CHECK_ELEMENTS_KIND,
  IR_CHECK_MAP,
  IR_CHECK_NUMBER,
  IR_CHECK_SMI,
  IR_DEOPTIMIZE,
  IR_GENERIC_CALL,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_NEW_OBJECT,
  IR_NEW_ARRAY,
  IR_NEW_REGEX,
  IR_POLYMORPHIC_LOAD,
  IR_POLYMORPHIC_STORE,
  IR_DISPATCH_MAP,
  IR_MEGAMORPHIC_LOAD,
  IR_MEGAMORPHIC_STORE,
]);
const OVERFLOW_DEOPT_CAPABLE = new Set([
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
]);

function inferEffectKind(opcode: string, metadata: IRMetadata = {}): EffectKind {
  if (TERMINATORS.has(opcode)) return EFFECT_TERMINATOR;
  if (opcode === IR_DISPATCH_MAP && metadata.isStore === true)
    return EFFECT_WRITE;
  if (WRITES.has(opcode)) return EFFECT_WRITE;
  if (CALLS.has(opcode)) return EFFECT_CALL;
  if (ALLOCS.has(opcode)) return EFFECT_ALLOC;
  if (READS.has(opcode)) return EFFECT_READ;
  if (GUARDS.has(opcode)) return EFFECT_GUARD;
  return EFFECT_NONE;
}

export function irRequiresFrameState(node: IRValueLike) {
  if (!(node instanceof CFGInstruction)) return false;
  if (DEOPT_CAPABLE.has(node.type)) return true;
  if (OVERFLOW_DEOPT_CAPABLE.has(node.type))
    return node.props.noOverflow !== true;
  return false;
}

export class CFGValue {
  id: number;
  def: CFGInstruction | CFGValue | null;
  rep: IRMetadataValue | null;
  uses: CFGInstruction[];

  constructor(def: CFGInstruction | CFGValue | null = null, props: IRMetadata = {}) {
    this.id = nextNodeId++;
    this.def = def;
    this.rep = props.rep || null;
    this.uses = [];
  }

  toString() {
    return `v${this.id}`;
  }
}

export class CFGInstruction {
  id: number;
  opcode: string;
  type: string;
  metadata: IRMetadata;
  props: IRMetadata;
  inputs: CFGInstruction[];
  uses: CFGInstruction[];
  rep: IRMetadataValue | null;
  effectKind: EffectKind;
  frameState: FrameState | null;
  block: CFGBlock | null;
  _deadForSelfRecursion?: boolean;
  _speculativeType?: string;
  _constPtrIndex?: number;

  constructor(opcode: string, metadata: IRMetadata = {}) {
    this.id = nextNodeId++;
    this.opcode = opcode;
    this.type = opcode;
    this.metadata = metadata;
    this.props = metadata;
    this.inputs = [];
    this.uses = [];
    this.rep = metadata._rep || null;
    this.effectKind =
      typeof metadata.effectKind === "string"
        ? (metadata.effectKind as EffectKind)
        : inferEffectKind(opcode, metadata);
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
    old.uses = old.uses.filter((u) => u !== this);
    this.inputs[index] = value;
    value.uses.push(this);
  }

  toString() {
    const inputIds = this.inputs.map((n) => valueLabel(n)).join(", ");
    const propsStr = Object.entries(this.props)
      .filter(([k]) => k !== "effectKind")
      .map(([k, v]) => `${k}=${typeof v === "string" ? '"' + v + '"' : String(v)}`)
      .join(", ");
    const fs = this.frameState ? ` {fs}` : "";
    const rep = this.props._rep ? ` :${String(this.props._rep)}` : "";
    return `v${this.id} = ${this.opcode}(${inputIds})${rep}${propsStr ? " [" + propsStr + "]" : ""}${this.effectKind !== EFFECT_NONE ? ` <${this.effectKind}>` : ""}${fs}`;
  }
}

export class CFGBlock {
  id: number;
  nodes: CFGInstruction[];
  instructions: CFGInstruction[];
  params: CFGInstruction[];
  predecessors: CFGBlock[];
  successors: CFGBlock[];
  edgeArgs: Map<number, CFGInstruction[]>;
  terminator: CFGInstruction | null;
  isLoopHeader: boolean;
  _lastAcc?: CFGInstruction | null;

  constructor(id: number) {
    this.id = id;
    this.nodes = [];
    this.instructions = this.nodes;
    this.params = [];
    this.predecessors = [];
    this.successors = [];
    this.edgeArgs = new Map();
    this.terminator = null;
    this.isLoopHeader = false;
  }

  addParam(initialInputs: CFGInstruction[] = []) {
    const param = new CFGInstruction(IR_BLOCK_PARAM, {
      index: this.params.length,
    });
    for (const input of initialInputs) param.addInput(input);
    param.block = this;
    this.params.push(param);
    this.nodes.splice(this.params.length - 1, 0, param);
    return param;
  }

  addNode(instruction: CFGInstruction) {
    instruction.block = this;
    if (TERMINATORS.has(instruction.type)) this.terminator = instruction;
    this.nodes.push(instruction);
    return instruction;
  }

  addSuccessor(block: CFGBlock, args: CFGInstruction[] = []) {
    if (!this.successors.includes(block)) this.successors.push(block);
    if (!block.predecessors.includes(this)) block.predecessors.push(this);
    this.edgeArgs.set(block.id, args);
  }

  setEdgeArgs(block: CFGBlock, args: CFGInstruction[]) {
    this.edgeArgs.set(block.id, args);
  }

  getEdgeArgs(block: CFGBlock) {
    return this.edgeArgs.get(block.id) || [];
  }

  getTerminator() {
    if (this.terminator && this.nodes.includes(this.terminator))
      return this.terminator;
    const last = this.nodes[this.nodes.length - 1];
    if (last && TERMINATORS.has(last.type)) {
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
  inlineBudgetRemaining: number;
  _frameStateIndex?: Map<FrameValue, { replace(next: FrameValue): void }[]> | null;

  constructor(name: string) {
    this.name = name;
    this.blocks = [];
    this.entry = null;
    this.parameterCount = 0;
    this.parameters = [];
    this.dependencies = [];
    this.inlineBudgetRemaining = 0;
  }

  addBlock() {
    const block = new CFGBlock(this.blocks.length);
    this.blocks.push(block);
    if (!this.entry) this.entry = block;
    return block;
  }

  addParameter(index: number) {
    const param = new CFGInstruction(IR_PARAMETER, { index });
    this.parameters.push(param);
    this.parameterCount++;
    return param;
  }

  addDependency(kind: string, id: string | number, version: number | null = null) {
    const key = `${kind}:${id}:${version ?? ""}`;
    for (const dep of this.dependencies) {
      if (`${dep.kind}:${dep.id}:${dep.version ?? ""}` === key) return;
    }
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
      const succs = block.successors
        .map((b) => {
          const args = block
            .getEdgeArgs(b)
            .map((v) => valueLabel(v))
            .join(", ");
          return `B${b.id}${args ? `(${args})` : ""}`;
        })
        .join(", ");
      const params = block.params.map((p) => `v${p.id}`).join(", ");
      const flags = [];
      if (block.isLoopHeader) flags.push("loop-header");
      const flagStr = flags.length ? ` (${flags.join(", ")})` : "";
      const predsStr = preds ? ` <- [${preds}]` : "";
      const succsStr = succs ? ` -> [${succs}]` : "";

      out += `\nBlock B${block.id}${params ? `(${params})` : ""}${flagStr}${predsStr}${succsStr}:\n`;
      for (const node of block.nodes) out += `  ${node.toString()}\n`;
    }

    out += `=== End CFG Function ===\n`;
    return out;
  }
}

export const IRNode = CFGInstruction;
export const IRBlock = CFGBlock;
export const IRGraph = CFGFunction;

function valueLabel(value: IRValueLike): string {
  if (value instanceof CFGInstruction || value instanceof CFGValue) return `v${value.id}`;
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
  return new IRNode(IR_PARAMETER, { index });
}

export function irConstant(value: IRValueLike) {
  return new IRNode(IR_CONSTANT, { value });
}

export function irCheckMap(obj: IRValueLike, expectedMapId: IRValueLike, expectedMapVersion: IRValueLike= null) {
  const node = new IRNode(IR_CHECK_MAP, { expectedMapId, expectedMapVersion });
  node.addInput(obj);
  return node;
}

export function irCheckSmi(value: IRValueLike) {
  const node = new IRNode(IR_CHECK_SMI);
  node.addInput(value);
  return node;
}

export function irCheckNumber(value: IRValueLike) {
  const node = new IRNode(IR_CHECK_NUMBER);
  node.addInput(value);
  return node;
}

export function irInt32Add(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_ADD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Sub(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_SUB);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Mul(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_MUL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Div(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_DIV);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Mod(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_MOD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Add(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_FLOAT64_ADD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Sub(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_FLOAT64_SUB);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Mul(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_FLOAT64_MUL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Div(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_FLOAT64_DIV);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Compare(op: string, left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_COMPARE, { op });
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irFloat64Compare(op: string, left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_FLOAT64_COMPARE, { op });
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irLoadField(obj: IRValueLike, offset: number) {
  const node = new IRNode(IR_LOAD_FIELD, { offset });
  node.addInput(obj);
  return node;
}

export function irPolymorphicLoad(obj: IRValueLike, maps: IRValueLike[], offsets: IRValueLike[]) {
  const node = new IRNode(IR_POLYMORPHIC_LOAD, { maps, offsets });
  node.addInput(obj);
  return node;
}

export function irPolymorphicStore(obj: IRValueLike, maps: IRValueLike[], offsets: IRValueLike[], value: IRValueLike) {
  const node = new IRNode(IR_POLYMORPHIC_STORE, { maps, offsets });
  node.addInput(obj);
  node.addInput(value);
  return node;
}

export function irStoreField(obj: IRValueLike, offset: number, value: IRValueLike) {
  const node = new IRNode(IR_STORE_FIELD, { offset });
  node.addInput(obj);
  node.addInput(value);
  return node;
}

export function irGenericAdd(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_ADD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericSub(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_SUB);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericMul(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_MUL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericDiv(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_DIV);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericMod(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_MOD);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericCompare(op: string, left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_COMPARE, { op });
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericGetProp(obj: IRValueLike, propName: IRValueLike) {
  const node = new IRNode(IR_GENERIC_GET_PROP, { propName });
  node.addInput(obj);
  return node;
}

export function irGenericSetProp(obj: IRValueLike, propName: IRValueLike, value: IRValueLike) {
  const node = new IRNode(IR_GENERIC_SET_PROP, { propName });
  node.addInput(obj);
  node.addInput(value);
  return node;
}

export function irGenericCall(callee: IRValueLike, args: IRValueLike[]) {
  const node = new IRNode(IR_GENERIC_CALL, { argCount: args.length });
  node.addInput(callee);
  for (const arg of args) {
    node.addInput(arg);
  }
  return node;
}

export function irCheckCallTarget(callee: IRValueLike, expectedTarget: IRValueLike) {
  const node = new IRNode(IR_CHECK_CALL_TARGET, { expectedTarget });
  node.addInput(callee);
  return node;
}

export function irCallKnownFunction(target: IRValueLike, args: IRValueLike[]) {
  const node = new IRNode(IR_CALL_KNOWN_FUNCTION, {
    target,
    argCount: args.length,
  });
  for (const arg of args) {
    node.addInput(arg);
  }
  return node;
}

export function irGenericGetIndex(obj: IRValueLike, index: IRValueLike) {
  const node = new IRNode(IR_GENERIC_GET_INDEX);
  node.addInput(obj);
  node.addInput(index);
  return node;
}

export function irGenericSetIndex(obj: IRValueLike, index: IRValueLike, value: IRValueLike) {
  const node = new IRNode(IR_GENERIC_SET_INDEX);
  node.addInput(obj);
  node.addInput(index);
  node.addInput(value);
  return node;
}

export function irInt32Or(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_OR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Xor(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_XOR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Ushr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_USHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Not(value: IRValueLike) {
  const node = new IRNode(IR_INT32_NOT);
  node.addInput(value);
  return node;
}

export function irFloat64Pow(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_FLOAT64_POW);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitand(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_BITAND);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitor(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_BITOR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitxor(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_BITXOR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericShl(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_SHL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericShr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_SHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericUshr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_USHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericPow(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_POW);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericBitnot(value: IRValueLike) {
  const node = new IRNode(IR_GENERIC_BITNOT);
  node.addInput(value);
  return node;
}

export function irGenericInstanceof(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_INSTANCEOF);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irGenericIn(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_GENERIC_IN);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irReturn(value: IRValueLike) {
  const node = new IRNode(IR_RETURN);
  node.addInput(value);
  return node;
}

export function irBranch(condition: IRValueLike, trueBlock: CFGBlock, falseBlock: CFGBlock) {
  const node = new IRNode(IR_BRANCH, {
    trueBlock: trueBlock.id,
    falseBlock: falseBlock.id,
  });
  node.addInput(condition);
  return node;
}

export function irJump(targetBlock: CFGBlock) {
  return new IRNode(IR_JUMP, { targetBlock: targetBlock.id });
}

export function irDeoptimize(reason: string) {
  return new IRNode(IR_DEOPTIMIZE, { reason });
}

export function irBox(value: IRValueLike, fromType: string) {
  const node = new IRNode(IR_BOX, { fromType });
  node.addInput(value);
  return node;
}

export function irUnbox(value: IRValueLike, toType: string) {
  const node = new IRNode(IR_UNBOX, { toType });
  node.addInput(value);
  return node;
}

export function irNot(value: IRValueLike) {
  const node = new IRNode(IR_NOT);
  node.addInput(value);
  return node;
}

export function irNeg(value: IRValueLike) {
  const node = new IRNode(IR_NEG);
  node.addInput(value);
  return node;
}

export function irNewObject() {
  return new IRNode(IR_NEW_OBJECT);
}

export function irNewArray(elements: IRValueLike[]) {
  const node = new IRNode(IR_NEW_ARRAY, { elementCount: elements.length });
  for (const el of elements) {
    node.addInput(el);
  }
  return node;
}

export function irNewRegex(constIdx: number) {
  return new IRNode(IR_NEW_REGEX, { constIdx });
}

export function irLoadLocal(slot: number) {
  return new IRNode(IR_LOAD_LOCAL, { slot });
}

export function irStoreLocal(slot: number, value: IRValueLike) {
  const node = new IRNode(IR_STORE_LOCAL, { slot });
  node.addInput(value);
  return node;
}

export function irLoadGlobal(name: string) {
  return new IRNode(IR_LOAD_GLOBAL, { name });
}

export function irStoreGlobal(name: string, value: IRValueLike) {
  const node = new IRNode(IR_STORE_GLOBAL, { name });
  node.addInput(value);
  return node;
}

export function irCheckArray(obj: IRValueLike) {
  const node = new IRNode(IR_CHECK_ARRAY);
  node.addInput(obj);
  return node;
}

export function irCheckElementsKind(arrayObj: IRValueLike, elementsKind: IRValueLike) {
  const node = new IRNode(IR_CHECK_ELEMENTS_KIND, { elementsKind });
  node.addInput(arrayObj);
  return node;
}

export function irCheckBounds(index: IRValueLike, arrayObj: IRValueLike) {
  const node = new IRNode(IR_CHECK_BOUNDS);
  node.addInput(index);
  node.addInput(arrayObj);
  return node;
}

export function irLoadArrayLength(arrayObj: IRValueLike) {
  const node = new IRNode(IR_LOAD_ARRAY_LENGTH);
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
  const node = new IRNode(IR_LOAD_ELEMENT, {
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
  const node = new IRNode(IR_STORE_ELEMENT, {
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
  const node = new IRNode(IR_INT32_SHL);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32Shr(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_SHR);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function irInt32And(left: IRValueLike, right: IRValueLike) {
  const node = new IRNode(IR_INT32_AND);
  node.addInput(left);
  node.addInput(right);
  return node;
}

export function resetIRNodeIds() {
  nextNodeId = 0;
}

