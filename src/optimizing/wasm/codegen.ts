import * as ir from "../ir/index.js";
import type { SpeculativeCompileResult } from "../optimizer.js";
import type {
  OptimizedCode,
  RegisterCompiledFunction,
} from "../../bytecode/register/ops/bytecode.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";

import { RegisterFrame } from "../../bytecode/register/interpreter/index.js";
import {
  isSmi,
  isDouble,
  isNumber,
  isObject,
  isBool,
  isArray,
  mkSmi,
  mkDouble,
  mkNumber,
  mkBool,
  mkString,
  mkNull,
  mkObject,
  mkFunction,
  JSFunction,
  mkArray,
  mkUndefined,
  mkRegex,
  toNumber,
  toBool,
  toDisplayString,
  typeOf,
  TAG_SMI,
  TAG_DOUBLE,
  SMI_MIN,
  SMI_MAX,
  getPayload,
  getTag,
  strictEqual,
  isTaggedValue,
  type TaggedValue,
  type HeapPayload,
} from "../../core/value/index.js";
import {
  DeoptSignal,
  DEOPT_ARRAY_CHECK_FAILED,
  DEOPT_BOUNDS_CHECK_FAILED,
  DEOPT_DIVISION_BY_ZERO,
  DEOPT_ELEMENTS_KIND_CHECK_FAILED,
  DEOPT_GUARD_FAILURE,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_OVERFLOW,
  DEOPT_RUNTIME_STUB_FAILURE,
  DEOPT_SMI_CHECK_FAILED,
  DEOPT_WRONG_CALL_TARGET,
} from "../../deopt/deoptimizer.js";
import { tracer } from "../../core/tracing/index.js";
import {
  runtimeGetProperty as proxyRuntimeGetProperty,
  runtimeSetProperty as proxyRuntimeSetProperty,
  runtimeHasProperty as proxyRuntimeHasProperty,
} from "../../objects/exotic/proxy-ops.js";
import {
  PACKED_SMI,
  PACKED_DOUBLE,
  HOLEY_SMI,
  HOLEY_DOUBLE,
  PACKED_TAGGED,
  HOLEY_TAGGED,
} from "../../objects/elements/elements-kind.js";
import { createJSObject, createJSArray } from "../../objects/heap/factory.js";
import type { JSObject } from "../../objects/heap/js-object.js";
import type { JSArray } from "../../objects/heap/js-array.js";
import { getHiddenClassById } from "../../objects/maps/hidden-class.js";
import { dependencyRegistry } from "../../deopt/dependencies.js";
import {
  REP_INT32,
  REP_FLOAT64,
  REP_TAGGED_NUMBER,
  REP_HANDLE,
  REP_BOOL,
} from "../passes/repr-selection.js";
import { validateOptimizedGraph } from "../validation/graph-validator.js";
import {
  frameStateValueIds,
  visitDeoptSnapshotValues,
} from "../passes/frame-state-values.js";
import * as wasmFormat from "./wasm-format.js";
import { elementsKindId, elementsKindName } from "./object-layout.js";
import {
  metadataString,
  metadataNumber,
  metadataNumberArray,
  metadataStringArray,
} from "../ir/metadata.js";
import {
  RUNTIME_STUB_NODES,
  HEAP_MEMORY_STORE_NODES,
  VALUE_PRODUCING,
  INT32_ARITH,
  FLOAT64_ARITH,
  INT32_OVERFLOW_CHECK,
  needsOverflowCheck,
  COMPARE_OPS,
  INT32_ARITH_OPCODES,
  INT64_ARITH_OPCODES,
  FLOAT64_ARITH_OPCODES,
  RuntimeStubTable,
  repForNode,
  wasmTypeForRep,
  valueRepForRep,
  compileRejectionForNode,
  computeBlockOrder,
  findBackEdges,
  findLoopHeaders,
  findLoopBlocks,
  buildRegions,
  CONDITIONALLY_NATIVE,
  GENERIC_BITWISE_OPCODES,
  isNativeEligible,
  mathIntrinsicForNode,
  MATH_INTRINSICS,
  SPECULATIVE_ARITH_I32,
  SPECULATIVE_ARITH_F64,
  SPECULATIVE_COMPARE,
} from "./graph-support.js";
import {
  deoptReasonId,
  deoptReasonFromId,
  deoptReasonForNode,
  materializeFrameFromState,
  resumeFrameStateChain,
} from "./deopt-frame.js";
import {
  executeRuntimeStub,
  serializeObject,
  deserializeObject,
} from "./runtime-support.js";

type ThreadLocalState = {
  currentObjPtrs: Map<number, ObjectPointerInfo> | null;
  currentRuntime: WasmRuntime | null;
};

const threadLocal: ThreadLocalState = {
  currentObjPtrs: null,
  currentRuntime: null,
};

const MAX_WASM_CALL_DEPTH = 1000;
let wasmCallDepth = 0;

function resolveNodeLocal(nodeId: number, analysis: AnyAnalysis): WasmLocalId | undefined {
  const alias = analysis.localAlias.get(nodeId);
  if (alias !== undefined) return resolveNodeLocal(alias, analysis);
  return analysis.nodeLocal.get(nodeId);
}

const NUMERIC_PARAM_USES = new Set([
  ir.IR_CHECK_SMI,
  ir.IR_CHECK_NUMBER,
  ir.IR_INT32_COMPARE,
  ir.IR_FLOAT64_COMPARE,
  ir.IR_GENERIC_COMPARE,
  ir.IR_INT32_ADD,
  ir.IR_INT32_SUB,
  ir.IR_INT32_MUL,
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_SUB,
  ir.IR_FLOAT64_MUL,
  ir.IR_FLOAT64_DIV,
  ir.IR_GENERIC_ADD,
  ir.IR_GENERIC_SUB,
  ir.IR_GENERIC_MUL,
  ir.IR_GENERIC_DIV,
  ir.IR_GENERIC_MOD,
  ir.IR_NEG,
]);

declare const WebAssembly: {
  Memory: new (descriptor: { initial: number; maximum?: number }) => WasmMemory;
  Module: new (bytes: Uint8Array) => object;
  Instance: new (
    module: object,
    imports: WasmImports,
  ) => { exports: Record<string, WasmExport> };
};

type AnyNode = ir.CFGInstruction;
type AnyBlock = ir.CFGBlock;
type AnyGraph = ir.CFGFunction;
type WasmLocalId = number;
type WasmType = number;
type WasmValueRep = string;
type SyntheticConstantNode = ir.CFGInstruction;
type MathIntrinsicInfo = {
  intrinsic: MathIntrinsic;
  argInputs: AnyNode[];
};
type GlobalCandidateEntry = {
  loads: AnyNode[];
  stores: AnyNode[];
};
type TieringPolicyLike = {
  maxDeoptCount?: number;
  recordDeopt?(compiledFn: RegisterCompiledFunction, reason: string): void;
};
type GlobalCellsLike = {
  read(name: string): TaggedValue | undefined;
  get(name: string): { read(): TaggedValue } | undefined;
  write(name: string, value: TaggedValue): void;
};
type WasmInterpreter = {
  tieringPolicy?: TieringPolicyLike;
  globalCells: GlobalCellsLike;
  resumeAt(frame: RegisterFrame): TaggedValue;
  _lookupBuiltinPrototype(proto: TaggedValue, propName: string): TaggedValue;
  toPrimitiveValue(value: TaggedValue, hint?: string): TaggedValue;
  callFunctionValue(
    callee: TaggedValue,
    args: TaggedValue[],
    receiver: TaggedValue,
  ): TaggedValue;
  constructFunctionValue(callee: TaggedValue, args: TaggedValue[]): TaggedValue;
  callBuiltin(name: string, args: TaggedValue[]): TaggedValue;
  consumePendingLazyDeopt?(
    compiledFn: RegisterCompiledFunction,
    bytecodeOffset: number,
    reason: string,
  ): void;
};
type WasmCompiledFunction = RegisterCompiledFunction & {
  deoptCount?: number;
  lastDeoptReason?: string;
  optimizedCode?: OptimizedCode | null;
  disableOptimization?: boolean;
  optimizedStubSummary?: RuntimeStubTable["stubs"];
};
type ObjectPointerInfo = {
  ptr: number;
  obj: HeapPayload;
  value: TaggedValue;
  serializedSlots?: number;
  capacity?: number;
  serializedCount?: number;
};
type WasmAnalysis = {
  paramTypes: WasmType[];
  paramValueReps: WasmValueRep[];
  paramFieldExtents: Array<number | null>;
  resultType: WasmType;
  additionalLocals: Array<{ count: number; type: WasmType }>;
  nodeWasmType: Map<number, WasmType>;
  nodeLocal: Map<number, WasmLocalId>;
  localAlias: Map<number, number>;
  nodeValueRep: Map<number, WasmValueRep>;
  needsMemory: boolean;
  needsDeoptImport: boolean;
  entryGuards: AnyNode[];
  isOsr: boolean;
  needsRuntimeStubImport: boolean;
  runtimeStubTable: RuntimeStubTable;
  resultValueRep: WasmValueRep | null;
  needsAllocObjImport: boolean;
  allocObjNodes: AnyNode[];
  phiNodes: AnyNode[];
  phiUpdateTempLocal: Map<number, WasmLocalId>;
  overflowTempLocal: number;
  toInt32ScratchLocal: number;
  hasOverflowChecks: boolean;
  _allocTempLocal: number;
  hasInlineAlloc: boolean;
  mutatesHeapObjects: boolean;
  _localSlotMap: Map<ir.IRMetadataValue, WasmLocalId>;
  _nonPrimitiveConstants: SyntheticConstantNode[];
  _syntheticConstants: SyntheticConstantNode[];
  globalCellOffsets: Map<string, number> | null;
  hasSelfRecursion: boolean;
  selfCallFuncIdx?: number;
  _compiledFn: RegisterCompiledFunction | null;
  orphanConstants: SyntheticConstantNode[];
  mathCallIntrinsics: Map<number, MathIntrinsicInfo>;
  mathCallDead: Set<number>;
};
type AnyAnalysis = WasmAnalysis;
type WasmRuntime = {
  objPtrs: Map<number, ObjectPointerInfo>;
  memory: WasmMemory | null;
  interpreter: WasmInterpreter;
  compiledFn: RegisterCompiledFunction;
  thisValue: TaggedValue;
  allocateTagged: (tagged: TaggedValue, skipSlotSerialization?: boolean, maxSlots?: number) => number;
  getTagged: (ptr: number) => TaggedValue;
  syncTagged?: (ptr: number) => void;
};
type WasmMemory = { buffer: ArrayBuffer; grow(delta: number): number };
type WasmExport = ((...args: number[]) => number) | WasmMemory | object;
type WasmImports = {
  env: {
    memory?: WasmMemory;
    deopt?: (reasonId: number, frameStateId: number) => number;
    runtimeStub?: (
      stubId: number,
      frameStateId: number,
      a0: number,
      a1: number,
      a2: number,
      a3: number,
      a4: number,
      a5: number,
      a6: number,
      a7: number,
    ) => number;
    allocObj?: (hcId: number) => number;
  };
};
type MathIntrinsic = {
  arity: number;
  importName?: string;
  opcode?: number;
};

function frameNode(value: FrameValue | null | undefined): AnyNode | null {
  return value instanceof ir.CFGInstruction ? value : null;
}

function isInt32ArithmeticOpcode(value: string | undefined): value is string {
  return value !== undefined && INT32_ARITH.has(value);
}

function isFloat64ArithmeticOpcode(value: string | undefined): value is string {
  return value !== undefined && FLOAT64_ARITH.has(value);
}

function requireWasmInterpreter(value: object): WasmInterpreter {
  if ("globalCells" in value && "resumeAt" in value) {
    return value as WasmInterpreter;
  }
  throw new Error("Wasm optimized code requires a register interpreter");
}

function compiledFunctionMetadata(value: ir.IRMetadataValue): RegisterCompiledFunction | null {
  return (
    value &&
    typeof value === "object" &&
    "instructions" in value &&
    "paramCount" in value &&
    Array.isArray(value.instructions) &&
    typeof value.paramCount === "number"
  )
    ? value as RegisterCompiledFunction
    : null;
}

function isWasmCallable(value: WasmExport): value is (...args: number[]) => number {
  return typeof value === "function";
}

function serializablePayload(value: TaggedValue): JSObject | JSArray | null {
  if (isObject(value)) return getPayload(value);
  if (isArray(value)) return getPayload(value);
  return null;
}

export function isInsideWasmExecution(): boolean {
  return wasmCallDepth > 0;
}

export class WasmCodegen {
  lastAnalysisFailure: string | null = null;
  lastCompileRejection: string | null = null;
  lastEmitFailure: string | null = null;
  _typeofConstants: Map<string, SyntheticConstantNode> | null = null;
  _nonPrimitiveConstants: SyntheticConstantNode[] | null = null;
  _globalCandidates: Map<string, GlobalCandidateEntry> | null = null;
  _globalCellOffsets: Map<string, number> | null = null;
  _selfRecursiveCandidates: AnyNode[] | null = null;

  failAnalysis(node: AnyNode, reason: string): null {
    const blockId = node.block ? node.block.id : -1;
    this.lastAnalysisFailure = `block ${blockId} instruction ${node.id} ${node.type}: ${reason}`;
    return null;
  }

  compileRejection(graph: AnyGraph): string | null {
    if (!graph || !Array.isArray(graph.blocks))
      return "graph is missing blocks";
    if (graph.blocks.length === 0) return "graph has no blocks";
    const observedFrameStateValues = frameStateValueIds(graph);
    const receiverShape = new Map<number, { mono: Set<ir.IRMetadataValue>; poly: Set<ir.IRMetadataValue> }>();
    const recordShape = (
      recv: AnyNode | undefined,
      kind: "mono" | "poly",
      maps: ir.IRMetadataValue[],
    ) => {
      if (!recv) return;
      let entry = receiverShape.get(recv.id);
      if (!entry) {
        entry = { mono: new Set(), poly: new Set() };
        receiverShape.set(recv.id, entry);
      }
      for (const m of maps) entry[kind].add(m);
    };
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (
          node.type === ir.IR_CHECK_MAP &&
          node.props &&
          node.props.expectedMapId != null
        ) {
          recordShape(node.inputs[0], "mono", [node.props.expectedMapId]);
        } else if (
          (node.type === ir.IR_POLYMORPHIC_LOAD ||
            node.type === ir.IR_POLYMORPHIC_STORE) &&
          node.props &&
          Array.isArray(node.props.maps)
        ) {
          recordShape(node.inputs[0], "poly", node.props.maps);
        }
      }
    }
    for (const entry of receiverShape.values()) {
      if (entry.mono.size === 0 || entry.poly.size === 0) continue;
      for (const m of entry.poly) {
        if (!entry.mono.has(m)) {
          return "inconsistent mono/poly shape speculation on receiver";
        }
      }
    }

    let hasReturn = false;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        const nodeRejection = compileRejectionForNode(node, block);
        if (nodeRejection) return nodeRejection;
        if (
          (node.type === ir.IR_CHECK_NUMBER || node.type === ir.IR_CHECK_SMI) &&
          node.inputs[0] &&
          node.inputs[0].type !== ir.IR_PARAMETER &&
          repForNode(node.inputs[0]) === REP_HANDLE
        ) {
          return "number guard on non-parameter handle value";
        }
        if (
          (node.type === ir.IR_GENERIC_GET_PROP ||
            node.type === ir.IR_GENERIC_SET_PROP ||
            node.type === ir.IR_LOAD_FIELD ||
            node.type === ir.IR_STORE_FIELD ||
            node.type === ir.IR_CHECK_MAP ||
            node.type === ir.IR_GENERIC_GET_INDEX ||
            node.type === ir.IR_GENERIC_SET_INDEX) &&
          node.inputs[0] &&
          node.inputs[0].type === ir.IR_CONSTANT &&
          node.inputs[0].props &&
          node.inputs[0].props.isThis
        ) {
          return "property access on this receiver";
        }
        if (node.type === ir.IR_RETURN) hasReturn = true;
        if (
          node.type === ir.IR_PHI &&
          (node.uses.length > 0 || observedFrameStateValues.has(node.id))
        ) {
          const paramRep = valueRepForRep(repForNode(node));
          for (const incoming of ir.blockParamIncoming(node)) {
            if (valueRepForRep(repForNode(incoming)) === paramRep) continue;
            return `block parameter is ${paramRep} but an incoming value is ${valueRepForRep(repForNode(incoming))}`;
          }
        }
      }
      const preds = block.predecessors || [];
      if (preds.length > 2) {
        for (const pred of preds) {
          const last = pred.nodes[pred.nodes.length - 1];
          if (last && last.type === ir.IR_BRANCH) {
            return "short-circuit edge into multi-way merge";
          }
        }
      }
    }
    if (!hasReturn) return "graph has no return";
    return null;
  }

  canCompile(graph: AnyGraph): boolean {
    this.lastCompileRejection = this.compileRejection(graph);
    return this.lastCompileRejection === null;
  }

  analyzeGraph(graph: AnyGraph, compiledFn: RegisterCompiledFunction): AnyAnalysis | null {
    const nodeWasmType = new Map<number, WasmType>();
    const nodeLocal = new Map<number, WasmLocalId>();
    const localAlias = new Map<number, number>();
    const nodeValueRep = new Map<number, WasmValueRep>();
    const runtimeStubTable = new RuntimeStubTable();

    const valueRepOf = (node: AnyNode): WasmValueRep =>
      nodeValueRep.get(node.id) || valueRepForRep(repForNode(node));

    let needsMemory = false;
    let needsDeoptImport = false;
    let needsRuntimeStubImport = false;
    let needsAllocObjImport = false;
    const allocObjNodes: AnyNode[] = [];
    const entryGuards: AnyNode[] = [];
    const phiNodes: AnyNode[] = [];

    const mathCallIntrinsics = new Map<number, MathIntrinsicInfo>();
    const mathCallDead = new Set<number>();
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== ir.IR_GENERIC_CALL || !node.props.isMethod) continue;
        const callee = node.inputs[0];
        if (!callee || callee.type !== ir.IR_GENERIC_GET_PROP) continue;
        const receiver = callee.inputs[0];
        if (!receiver || receiver.type !== ir.IR_LOAD_GLOBAL) continue;
        if (receiver.props.name !== "Math") continue;
        const methodName = "Math." + String(callee.props.propName);
        const intrinsic = MATH_INTRINSICS.get(methodName);
        if (!intrinsic) continue;
        const actualArgs = node.inputs.length - 2;
        if (actualArgs !== intrinsic.arity) continue;
        mathCallIntrinsics.set(node.id, {
          intrinsic,
          argInputs: node.inputs.slice(2),
        });
        mathCallDead.add(callee.id);
        mathCallDead.add(receiver.id);
      }
    }

    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (VALUE_PRODUCING.has(node.type)) {
          nodeValueRep.set(node.id, valueRepForRep(repForNode(node)));
        }
        if (
          node.type === ir.IR_NEW_OBJECT &&
          node.props.targetHiddenClassId != null
        ) {
          if (node.props.targetSlotCount != null) {
            needsMemory = true;
          } else {
            needsAllocObjImport = true;
          }
          needsMemory = true;
          nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
          nodeValueRep.set(node.id, REP_HANDLE);
          allocObjNodes.push(node);
          continue;
        }
        if (this.needsFieldRuntimeStub(node)) {
          runtimeStubTable.register(node);
          needsRuntimeStubImport = true;
          needsMemory = true;
          nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
          continue;
        }
        if (isNativeEligible(node)) {
          const rep = repForNode(node);
          if (node.type === ir.IR_TYPEOF) {
            let typeStr: string | null = null;
            if (rep === REP_INT32 || rep === REP_FLOAT64 || rep === REP_TAGGED_NUMBER) {
              typeStr = "number";
            } else if (rep === REP_BOOL) {
              typeStr = "boolean";
            }
            if (typeStr) {
              if (!this._typeofConstants) this._typeofConstants = new Map();
              if (!this._typeofConstants.has(typeStr)) {
                const syntheticId = -(this._typeofConstants.size + 1);
                const syntheticNode = ir.irConstant(typeStr);
                syntheticNode.id = syntheticId;
                this._typeofConstants.set(typeStr, syntheticNode);
                nodeWasmType.set(syntheticId, wasmFormat.TYPE_I32);
                nodeValueRep.set(syntheticId, REP_HANDLE);
                if (!this._nonPrimitiveConstants) this._nonPrimitiveConstants = [];
                this._nonPrimitiveConstants.push(syntheticNode);
              }
              const syntheticNode = this._typeofConstants.get(typeStr);
              if (syntheticNode) {
                nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
                nodeValueRep.set(node.id, REP_HANDLE);
                localAlias.set(node.id, syntheticNode.id);
                needsMemory = true;
                continue;
              }
            }
          } else if (node.type === ir.IR_NEG && (rep === REP_FLOAT64 || rep === REP_TAGGED_NUMBER)) {
            nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
          } else if (node.type === ir.IR_GENERIC_USHR) {
            nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
            nodeValueRep.set(node.id, REP_FLOAT64);
          } else if (node.type === ir.IR_NOT) {
            nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
            nodeValueRep.set(node.id, REP_BOOL);
          } else {
            nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
          }
          continue;
        }
        {
          const intrinsic = mathIntrinsicForNode(node);
          if (intrinsic) {
            nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
            nodeValueRep.set(node.id, REP_FLOAT64);
            continue;
          }
        }
        if (node.type === ir.IR_LOAD_GLOBAL || node.type === ir.IR_STORE_GLOBAL) {
          if (!this._globalCandidates) this._globalCandidates = new Map();
          const name = metadataString(node.props.name);
          if (name === null) continue;
          if (!this._globalCandidates.has(name)) {
            this._globalCandidates.set(name, { loads: [], stores: [] });
          }
          const entry = this._globalCandidates.get(name)!;
          if (node.type === ir.IR_LOAD_GLOBAL) entry.loads.push(node);
          else entry.stores.push(node);
        }
        if (
          node.type === ir.IR_FLOAT64_POW &&
          node.inputs[1]?.type === ir.IR_CONSTANT &&
          (typeof node.inputs[1].props.value === "number" ||
            typeof node.inputs[1].props.value === "boolean")
        ) {
          const exp = Number(node.inputs[1].props.value);
          if (exp === 0 || exp === 1 || exp === 2 || exp === 0.5 || exp === -1) {
            nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
            nodeValueRep.set(node.id, REP_FLOAT64);
            continue;
          }
        }
        if (
          node.type === ir.IR_CALL_KNOWN_FUNCTION &&
          compiledFn &&
          node.props.target === compiledFn
        ) {
          if (!this._selfRecursiveCandidates) this._selfRecursiveCandidates = [];
          this._selfRecursiveCandidates.push(node);
          nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
          continue;
        }
        if (node._deadForSelfRecursion) {
          nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
          continue;
        }
        if (mathCallDead.has(node.id)) {
          nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
          continue;
        }
        if (mathCallIntrinsics.has(node.id)) {
          nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
          nodeValueRep.set(node.id, REP_FLOAT64);
          continue;
        }
        if (
          (node.type === ir.IR_GENERIC_ADD ||
            node.type === ir.IR_GENERIC_SUB ||
            node.type === ir.IR_GENERIC_MUL) &&
          node.inputs.length === 2 &&
          node.inputs.every((inp) => {
            if (inp.type === ir.IR_CONSTANT && typeof inp.props.value !== "number")
              return false;
            if (repForNode(inp) === REP_HANDLE) return false;
            const t = nodeWasmType.get(inp.id);
            return t === wasmFormat.TYPE_I32 || t === wasmFormat.TYPE_F64;
          })
        ) {
          nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
          continue;
        }
        if (RUNTIME_STUB_NODES.has(node.type)) {
          runtimeStubTable.register(node);
          needsRuntimeStubImport = true;
          needsMemory = true;
          nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
          continue;
        }
        switch (node.type) {
          case ir.IR_INT32_ADD:
          case ir.IR_INT32_SUB:
          case ir.IR_INT32_MUL:
            if (!node.props?.noOverflow) {
              nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
            } else {
              nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            }
            break;
          case ir.IR_INT32_DIV:
          case ir.IR_INT32_MOD:
          case ir.IR_INT32_COMPARE:
          case ir.IR_INT32_SHL:
          case ir.IR_INT32_SHR:
          case ir.IR_INT32_USHR:
          case ir.IR_INT32_AND:
          case ir.IR_INT32_OR:
          case ir.IR_INT32_XOR:
          case ir.IR_INT32_NOT:
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            break;
          case ir.IR_FLOAT64_ADD:
          case ir.IR_FLOAT64_SUB:
          case ir.IR_FLOAT64_MUL:
          case ir.IR_FLOAT64_DIV:
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            break;
          case ir.IR_FLOAT64_COMPARE:
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            break;
          case ir.IR_LOAD_FIELD:
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            needsMemory = true;
            break;
          case ir.IR_POLYMORPHIC_LOAD:
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            needsMemory = true;
            needsDeoptImport = true;
            break;
          case ir.IR_LOAD_ARRAY_LENGTH:
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            needsMemory = true;
            break;
          case ir.IR_LOAD_ELEMENT:
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            needsMemory = true;
            break;
          case ir.IR_STORE_ELEMENT:
            needsMemory = true;
            break;
          case ir.IR_STORE_FIELD:
            needsMemory = true;
            break;
          case ir.IR_CHECK_MAP:
            needsMemory = true;
            needsDeoptImport = true;
            break;
          case ir.IR_CHECK_ARRAY:
          case ir.IR_CHECK_BOUNDS:
            needsMemory = true;
            needsDeoptImport = true;
            break;
          case ir.IR_CHECK_ELEMENTS_KIND:
            needsMemory = true;
            needsDeoptImport = true;
            break;
          case ir.IR_CHECK_SMI:
          case ir.IR_CHECK_NUMBER:
            needsDeoptImport = true;
            break;
          case ir.IR_POLYMORPHIC_STORE:
            needsMemory = true;
            needsDeoptImport = true;
            break;
          case ir.IR_DEOPTIMIZE:
            needsDeoptImport = true;
            break;
          case ir.IR_CONSTANT: {
            const v = node.props.value;
            if (typeof v === "boolean" || typeof v === "number") {
              nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            } else {
              nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
              nodeValueRep.set(node.id, REP_HANDLE);
              needsMemory = true;
              if (!this._nonPrimitiveConstants)
                this._nonPrimitiveConstants = [];
              this._nonPrimitiveConstants.push(node);
            }
            break;
          }
          case ir.IR_LOAD_LOCAL: {
            nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
            break;
          }
          case ir.IR_STORE_LOCAL: {
            break;
          }
          case ir.IR_LOAD_CONST: {
            nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
            nodeValueRep.set(node.id, REP_HANDLE);
            needsMemory = true;
            if (!this._nonPrimitiveConstants) this._nonPrimitiveConstants = [];
            this._nonPrimitiveConstants.push(node);
            break;
          }
          case ir.IR_BOX: {
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            break;
          }
          case ir.IR_UNBOX: {
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
            break;
          }
          case ir.IR_PHI: {
            phiNodes.push(node);
            break;
          }
        }
      }
    }

    if (this._globalCandidates) {
      let hasCalls = false;
      for (const block of graph.blocks) {
        for (const node of block.nodes) {
          if (
            node.type === ir.IR_GENERIC_CALL ||
            node.type === ir.IR_CALL_KNOWN_FUNCTION ||
            node.type === ir.IR_CALL_BUILTIN
          ) {
            hasCalls = true;
            break;
          }
        }
        if (hasCalls) break;
      }

      for (const [name, entry] of this._globalCandidates) {
        const hasNumericStore = entry.stores.some((s) => {
          const inputRep = s.inputs[0] ? repForNode(s.inputs[0]) : REP_HANDLE;
          return inputRep !== REP_HANDLE;
        });
        if (hasNumericStore && entry.stores.length > 0 && !hasCalls) {
          if (!this._globalCellOffsets) this._globalCellOffsets = new Map();
          this._globalCellOffsets.set(name, 32768 + this._globalCellOffsets.size * 8);
          needsMemory = true;
          for (const loadNode of entry.loads) {
            nodeWasmType.set(loadNode.id, wasmFormat.TYPE_F64);
            nodeValueRep.set(loadNode.id, REP_TAGGED_NUMBER);
          }
        } else {
          for (const loadNode of entry.loads) {
            if (loadNode._deadForSelfRecursion) continue;
            runtimeStubTable.register(loadNode);
            needsRuntimeStubImport = true;
            needsMemory = true;
            nodeWasmType.set(loadNode.id, wasmTypeForRep(repForNode(loadNode)));
          }
          for (const storeNode of entry.stores) {
            if (storeNode._deadForSelfRecursion) continue;
            runtimeStubTable.register(storeNode);
            needsRuntimeStubImport = true;
            needsMemory = true;
          }
        }
      }
    }

    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (needsOverflowCheck(node)) {
          needsDeoptImport = true;
        }
      }
    }

    for (const param of graph.parameters) {
      let type = null;
      for (const use of param.uses) {
        if (use.type === ir.IR_CHECK_SMI || use.type === ir.IR_CHECK_NUMBER)
          type = type || wasmTypeForRep(repForNode(use));
        else if (
          use.type === ir.IR_CHECK_MAP ||
          use.type === ir.IR_CHECK_ARRAY ||
          use.type === ir.IR_CHECK_ELEMENTS_KIND
        ) {
          type = wasmFormat.TYPE_I32;
          needsMemory = true;
        } else if (
          INT32_ARITH.has(use.type) ||
          use.type === ir.IR_INT32_COMPARE
        )
          type = type || wasmFormat.TYPE_I32;
        else if (
          FLOAT64_ARITH.has(use.type) ||
          use.type === ir.IR_FLOAT64_COMPARE
        )
          type = type || wasmFormat.TYPE_F64;
        else if (
          use.type === ir.IR_GENERIC_ADD ||
          use.type === ir.IR_GENERIC_SUB ||
          use.type === ir.IR_GENERIC_MUL ||
          use.type === ir.IR_GENERIC_DIV ||
          use.type === ir.IR_GENERIC_MOD ||
          use.type === ir.IR_GENERIC_COMPARE ||
          use.type === ir.IR_NEG
        ) {
          type = type || wasmFormat.TYPE_F64;
          needsMemory = true;
        } else if (mathCallIntrinsics.has(use.id)) {
          type = type || wasmFormat.TYPE_F64;
          nodeValueRep.set(param.id, REP_FLOAT64);
        } else if (RUNTIME_STUB_NODES.has(use.type)) {
          type = type || wasmTypeForRep(repForNode(param));
          needsMemory = true;
        }
      }
      if (type === null) type = wasmTypeForRep(repForNode(param));
      nodeWasmType.set(param.id, type);
      nodeValueRep.set(param.id, valueRepForRep(repForNode(param)));
      if (type === wasmFormat.TYPE_F64 && param.uses?.some((u) => mathCallIntrinsics.has(u.id))) {
        nodeValueRep.set(param.id, REP_FLOAT64);
      }
    }

    
    
    
    
    
    const paramFieldExtents: Array<number | null> = [];
      for (const param of graph.parameters) {
      const idx = metadataNumber(param.props.index);
      if (idx === null) continue;
      let maxOffset = -1;
      let eligible = true;
      for (const use of param.uses || []) {
        if (use.type === ir.IR_CHECK_MAP) {
          for (const u2 of use.uses || []) {
            if (u2.type === ir.IR_LOAD_FIELD) {
              const offset = metadataNumber(u2.props.offset);
              if (offset === null) {
                eligible = false;
                break;
              }
              maxOffset = Math.max(maxOffset, offset);
            } else {
              eligible = false;
              break;
            }
          }
        } else if (use.type === ir.IR_LOAD_FIELD) {
          const offset = metadataNumber(use.props.offset);
          if (offset === null) {
            eligible = false;
            break;
          }
          maxOffset = Math.max(maxOffset, offset);
        } else {
          eligible = false;
        }
        if (!eligible) break;
      }
      paramFieldExtents[idx] =
        eligible && maxOffset >= 0 ? maxOffset + 1 : null;
    }

    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (node.type === ir.IR_CHECK_SMI || node.type === ir.IR_CHECK_NUMBER) {
          const inputType = nodeWasmType.get(node.inputs[0]?.id);
          nodeWasmType.set(node.id, inputType || wasmFormat.TYPE_I32);
          if (node.inputs[0]) localAlias.set(node.id, node.inputs[0].id);
          entryGuards.push(node);
        } else if (
          node.type === ir.IR_CHECK_MAP ||
          node.type === ir.IR_CHECK_ARRAY ||
          node.type === ir.IR_CHECK_ELEMENTS_KIND
        ) {
          const inputType = nodeWasmType.get(node.inputs[0]?.id);
          nodeWasmType.set(node.id, inputType || wasmFormat.TYPE_I32);
          localAlias.set(node.id, node.inputs[0]?.id);
        } else if (node.type === ir.IR_CHECK_BOUNDS) {
          const inputType = nodeWasmType.get(node.inputs[0]?.id);
          nodeWasmType.set(node.id, inputType || wasmFormat.TYPE_I32);
          localAlias.set(node.id, node.inputs[0]?.id);
        }
      }
    }

    const orphanConstants = [];
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        for (const inp of node.inputs) {
          if (inp && !nodeWasmType.has(inp.id)) {
            if (inp.type === ir.IR_CONSTANT) {
              const v = inp.props?.value;
              if (typeof v === "boolean" || typeof v === "number") {
                nodeWasmType.set(inp.id, wasmTypeForRep(repForNode(inp)));
              } else {
                nodeWasmType.set(inp.id, wasmFormat.TYPE_I32);
              }
              orphanConstants.push(inp);
            }
          }
        }
      }
    }

    for (const phi of phiNodes) {
      let resolvedType = null;
      for (const inp of phi.inputs) {
        const t = nodeWasmType.get(inp.id);
        if (t !== undefined) {
          if (resolvedType === null) {
            resolvedType = t;
          } else if (resolvedType !== t) {
            resolvedType = wasmFormat.TYPE_F64;
          }
        }
      }
      nodeWasmType.set(phi.id, resolvedType || wasmFormat.TYPE_I32);
    }

    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (
          node.type === ir.IR_CHECK_SMI ||
          node.type === ir.IR_CHECK_NUMBER ||
          node.type === ir.IR_CHECK_MAP ||
          node.type === ir.IR_CHECK_ARRAY ||
          node.type === ir.IR_CHECK_ELEMENTS_KIND ||
          node.type === ir.IR_CHECK_BOUNDS
        ) {
          const inputType = nodeWasmType.get(node.inputs[0]?.id);
          if (inputType) nodeWasmType.set(node.id, inputType);
        }
      }
    }

    const speculativeNodes = new Set();
    const speculativeCandidates = [];
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (!node.frameState) continue;
        if (
          SPECULATIVE_ARITH_F64[node.type] !== undefined ||
          SPECULATIVE_COMPARE.has(node.type)
        ) {
          speculativeCandidates.push(node);
        }
      }
    }

    let speculativeChanged = true;
    while (speculativeChanged) {
      speculativeChanged = false;
      for (const node of speculativeCandidates) {
        if (speculativeNodes.has(node.id)) continue;
        const hasF64 = SPECULATIVE_ARITH_F64[node.type] !== undefined;
        const lt = nodeWasmType.get(node.inputs[0]?.id);
        const rt = nodeWasmType.get(node.inputs[1]?.id);
        if (lt === undefined || rt === undefined) continue;
        const bothNumeric =
          (lt === wasmFormat.TYPE_I32 || lt === wasmFormat.TYPE_F64) &&
          (rt === wasmFormat.TYPE_I32 || rt === wasmFormat.TYPE_F64);
        if (!bothNumeric) continue;
        if (node.inputs.some((input) => valueRepOf(input) === REP_HANDLE)) continue;
        if (hasF64) {
          speculativeNodes.add(node.id);
          node._speculativeType = SPECULATIVE_ARITH_F64[node.type];
          nodeWasmType.set(node.id, wasmFormat.TYPE_F64);
          runtimeStubTable.unregister(node.id);
          speculativeChanged = true;
        } else {
          speculativeNodes.add(node.id);
          const useF64 = lt === wasmFormat.TYPE_F64 || rt === wasmFormat.TYPE_F64;
          node._speculativeType = useF64 ? ir.IR_FLOAT64_COMPARE : ir.IR_INT32_COMPARE;
          nodeWasmType.set(node.id, wasmFormat.TYPE_I32);
          runtimeStubTable.unregister(node.id);
          speculativeChanged = true;
        }
      }
      if (speculativeChanged) {
        for (const phi of phiNodes) {
          let resolvedType = null;
          for (const inp of phi.inputs) {
            const t = nodeWasmType.get(inp.id);
            if (t !== undefined) {
              if (resolvedType === null) resolvedType = t;
              else if (resolvedType !== t) resolvedType = wasmFormat.TYPE_F64;
            }
          }
          if (resolvedType !== null) nodeWasmType.set(phi.id, resolvedType);
        }
      }
    }

    const paramTypes: WasmType[] = [];
    const paramValueReps: WasmValueRep[] = [];
    for (const param of graph.parameters) {
      const pType = nodeWasmType.get(param.id) || wasmFormat.TYPE_I32;
      const pValueRep = valueRepOf(param);
      paramTypes.push(pType);
      paramValueReps.push(pValueRep);
      if (pValueRep === REP_HANDLE) needsMemory = true;
      const paramIndex = metadataNumber(param.props.index);
      if (paramIndex !== null) nodeLocal.set(param.id, paramIndex);
    }

    let hasSelfRecursion = false;
    if (this._selfRecursiveCandidates && this._selfRecursiveCandidates.length > 0) {
      const canPassSelfRecursiveParams = graph.parameters.every((param, index) => {
        const rep = paramValueReps[index];
        if (rep !== REP_HANDLE) return true;
        const wasmType = paramTypes[index];
        const hasNumericUse = param.uses.some((use) => NUMERIC_PARAM_USES.has(use.type));
        return (
          hasNumericUse &&
          (wasmType === wasmFormat.TYPE_I32 || wasmType === wasmFormat.TYPE_F64)
        );
      });
      if (canPassSelfRecursiveParams) {
        hasSelfRecursion = true;
        for (const node of this._selfRecursiveCandidates) {
          const existingType = nodeWasmType.get(node.id);
          if (!existingType) {
            nodeWasmType.set(node.id, wasmTypeForRep(repForNode(node)));
          }
        }
      } else {
        this.lastAnalysisFailure =
          "self-recursive call requires handle parameter support";
        this._selfRecursiveCandidates = null;
        return null;
      }
    }
    this._selfRecursiveCandidates = null;

    const localNodesI32 = [];
    const localNodesF64 = [];

    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (!VALUE_PRODUCING.has(node.type)) continue;
        if (node.type === ir.IR_PARAMETER) continue;
        if (localAlias.has(node.id)) continue;

        const wType = nodeWasmType.get(node.id) || wasmFormat.TYPE_I32;
        if (wType === wasmFormat.TYPE_I32) localNodesI32.push(node.id);
        else localNodesF64.push(node.id);
      }
    }

    if (this._typeofConstants) {
      for (const [, synNode] of this._typeofConstants) {
        localNodesI32.push(synNode.id);
      }
    }

    for (const orphan of orphanConstants) {
      if (nodeLocal.has(orphan.id)) continue;
      const owt = nodeWasmType.get(orphan.id) || wasmFormat.TYPE_I32;
      if (owt === wasmFormat.TYPE_I32) localNodesI32.push(orphan.id);
      else localNodesF64.push(orphan.id);
    }

    let nextLocal = graph.parameterCount;
    for (const id of localNodesI32) {
      nodeLocal.set(id, nextLocal++);
    }
    for (const id of localNodesF64) {
      nodeLocal.set(id, nextLocal++);
    }

    const additionalLocalTypes = {
      [wasmFormat.TYPE_I32]: localNodesI32.length,
      [wasmFormat.TYPE_F64]: localNodesF64.length,
    };

    let overflowTempLocal = -1;
    let hasOverflowChecks = false;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (needsOverflowCheck(node)) {
          hasOverflowChecks = true;
          break;
        }
      }
      if (hasOverflowChecks) break;
    }

    if (hasOverflowChecks) {
      overflowTempLocal = nextLocal;
      nextLocal++;
    }

    const toInt32ScratchLocal = nextLocal;
    nextLocal++;

    let _allocTempLocal = -1;
    let hasInlineAlloc = false;
    for (const n of allocObjNodes) {
      if (n.props.targetSlotCount != null) {
        hasInlineAlloc = true;
        break;
      }
    }
    if (hasInlineAlloc) {
      _allocTempLocal = nextLocal;
      nextLocal++;
    }

    let mutatesHeapObjects = false;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (HEAP_MEMORY_STORE_NODES.has(node.type)) {
          mutatesHeapObjects = true;
          break;
        }
      }
      if (mutatesHeapObjects) break;
    }

    const phiUpdateTempLocal = new Map<number, WasmLocalId>();
    let phiUpdateTempI32Count = 0;
    let phiUpdateTempF64Count = 0;
    for (const phi of phiNodes) {
      const phiType = nodeWasmType.get(phi.id) || wasmFormat.TYPE_I32;
      if (phiType === wasmFormat.TYPE_I32) {
        phiUpdateTempLocal.set(phi.id, nextLocal++);
        phiUpdateTempI32Count++;
      }
    }
    for (const phi of phiNodes) {
      const phiType = nodeWasmType.get(phi.id) || wasmFormat.TYPE_I32;
      if (phiType === wasmFormat.TYPE_F64) {
        phiUpdateTempLocal.set(phi.id, nextLocal++);
        phiUpdateTempF64Count++;
      }
    }

    const additionalLocals = [];
    if (additionalLocalTypes[wasmFormat.TYPE_I32] > 0) {
      additionalLocals.push({
        count: additionalLocalTypes[wasmFormat.TYPE_I32],
        type: wasmFormat.TYPE_I32,
      });
    }
    if (additionalLocalTypes[wasmFormat.TYPE_F64] > 0) {
      additionalLocals.push({
        count: additionalLocalTypes[wasmFormat.TYPE_F64],
        type: wasmFormat.TYPE_F64,
      });
    }
    if (hasOverflowChecks) {
      additionalLocals.push({ count: 1, type: wasmFormat.TYPE_I64 });
    }
    additionalLocals.push({ count: 1, type: wasmFormat.TYPE_F64 });
    if (hasInlineAlloc) {
      additionalLocals.push({ count: 1, type: wasmFormat.TYPE_I32 });
    }
    if (phiUpdateTempI32Count > 0) {
      additionalLocals.push({
        count: phiUpdateTempI32Count,
        type: wasmFormat.TYPE_I32,
      });
    }
    if (phiUpdateTempF64Count > 0) {
      additionalLocals.push({
        count: phiUpdateTempF64Count,
        type: wasmFormat.TYPE_F64,
      });
    }

    let resultType: WasmType | null = null;
    let resultValueRep: WasmValueRep | null = null;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== ir.IR_RETURN || !node.inputs[0]) continue;
        const returned = node.inputs[0];
        const rep = valueRepOf(returned);
        if (resultValueRep !== null && resultValueRep !== rep) {
          this.lastAnalysisFailure = `returns disagree on value representation (${resultValueRep} vs ${rep})`;
          return null;
        }
        resultValueRep = rep;
        const rt = nodeWasmType.get(returned.id);
        if (rt) {
          resultType =
            resultType === wasmFormat.TYPE_F64 || rt === wasmFormat.TYPE_F64
              ? wasmFormat.TYPE_F64
              : rt;
        }
      }
    }
    if (resultType === null) resultType = wasmFormat.TYPE_I32;

    if (hasSelfRecursion) {
      const returnedRep = resultValueRep ?? REP_TAGGED_NUMBER;
      for (const block of graph.blocks) {
        for (const node of block.nodes) {
          if (
            node.type !== ir.IR_CALL_KNOWN_FUNCTION ||
            node.props.target !== compiledFn
          ) {
            continue;
          }
          const callRep = valueRepOf(node);
          if (callRep === returnedRep) continue;
          this.lastAnalysisFailure = `self-recursive call reads its result as ${callRep} but the function returns ${returnedRep}`;
          return null;
        }
      }
    }

    if (needsDeoptImport) {
      needsMemory = true;
    }
    if (needsRuntimeStubImport) {
      needsMemory = true;
    }

    const _localSlotMap = new Map<ir.IRMetadataValue, WasmLocalId>();
    let _localSlotNextLocal = nextLocal;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (node.type === ir.IR_LOAD_LOCAL || node.type === ir.IR_STORE_LOCAL) {
          const slot = node.props.slot;
          if (!_localSlotMap.has(slot)) {
            _localSlotMap.set(slot, _localSlotNextLocal++);
          }
        }
      }
    }
    if (_localSlotMap.size > 0) {
      additionalLocals.push({
        count: _localSlotMap.size,
        type: wasmFormat.TYPE_F64,
      });
    }

    const _nonPrimitiveConstants = this._nonPrimitiveConstants || [];
    const _syntheticConstants = this._typeofConstants
      ? [...this._typeofConstants.values()]
      : [];
    const globalCellOffsets = this._globalCellOffsets || null;
    this._nonPrimitiveConstants = null;
    this._typeofConstants = null;
    this._globalCellOffsets = null;
    this._globalCandidates = null;

    return {
      paramTypes,
      paramValueReps,
      paramFieldExtents,
      resultType,
      additionalLocals,
      nodeWasmType,
      nodeLocal,
      localAlias,
      nodeValueRep,
      needsMemory,
      needsDeoptImport,
      entryGuards,
      isOsr: !!graph.osrParamSlots,
      needsRuntimeStubImport,
      runtimeStubTable,
      resultValueRep,
      needsAllocObjImport,
      allocObjNodes,
      phiNodes,
      phiUpdateTempLocal,
      overflowTempLocal,
      toInt32ScratchLocal,
      hasOverflowChecks,
      _allocTempLocal,
      hasInlineAlloc,
      mutatesHeapObjects,
      _localSlotMap,
      _nonPrimitiveConstants,
      _syntheticConstants,
      globalCellOffsets,
      hasSelfRecursion,
      _compiledFn: hasSelfRecursion ? compiledFn : null,
      orphanConstants,
      mathCallIntrinsics,
      mathCallDead,
    };
  }

  resolveLocal(nodeId: number, analysis: AnyAnalysis): WasmLocalId {
    return resolveNodeLocal(nodeId, analysis) ?? 0;
  }

  generateBody(
    graph: AnyGraph,
    analysis: AnyAnalysis,
    deoptImportIdx: number,
    runtimeStubImportIdx: number,
    allocObjImportIdx: number,
  ): number[] {
    const bytes: number[] = [];
    this.lastEmitFailure = null;
    const failEmit = (reason: string) => {
      if (this.lastEmitFailure === null) this.lastEmitFailure = reason;
    };

    if (analysis._syntheticConstants) {
      for (const synNode of analysis._syntheticConstants) {
        const loc = analysis.nodeLocal.get(synNode.id);
        if (loc !== undefined && synNode._constPtrIndex !== undefined) {
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(synNode._constPtrIndex),
          );
          bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        }
      }
    }

    if (analysis.orphanConstants) {
      for (const orphan of analysis.orphanConstants) {
        const loc = analysis.nodeLocal.get(orphan.id);
        if (loc === undefined) continue;
        const v = orphan.props?.value;
        const wType = analysis.nodeWasmType.get(orphan.id);
        if (wType === wasmFormat.TYPE_F64) {
          bytes.push(
            wasmFormat.OP_F64_CONST,
            ...wasmFormat.encodeF64(typeof v === "number" ? v : 0),
          );
        } else {
          const intVal = typeof v === "boolean" ? (v ? 1 : 0) : (typeof v === "number" ? v | 0 : 0);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(intVal),
          );
        }
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      }
    }

    const order = computeBlockOrder(graph);
    const backEdges = findBackEdges(graph, order);
    const loopHeaders = findLoopHeaders(backEdges);

    if (order.length === 1) {
      const block = order[0];
      for (const node of block.nodes) {
        this.emitNode(
          node,
          analysis,
          bytes,
          deoptImportIdx,
          runtimeStubImportIdx,
          allocObjImportIdx,
        );
      }
      return bytes;
    }

    const blockMap = new Map<number, AnyBlock>();
    for (const block of graph.blocks) {
      blockMap.set(block.id, block);
    }

    const orderIndex = new Map<number, number>();
    for (let i = 0; i < order.length; i++) {
      orderIndex.set(order[i].id, i);
    }

    const loopInfoMap = new Map<number, { loopBlocks: Set<number>; exitBlockIds: number[] }>();
    for (const headerId of loopHeaders) {
      const header = blockMap.get(headerId);
      if (!header) continue;
      const loopBlocks = findLoopBlocks(header, backEdges, graph.blocks);
      const exitTargets = new Set<number>();
      for (const lbId of loopBlocks) {
        const lb = blockMap.get(lbId);
        if (!lb) continue;
        for (const succ of lb.successors) {
          if (!loopBlocks.has(succ.id)) exitTargets.add(succ.id);
        }
      }
      const exitBlockIds = [...exitTargets].sort(
        (a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0),
      );
      loopInfoMap.set(headerId, { loopBlocks, exitBlockIds });
    }

    const labelStack: Array<{ type: string; targetId: number | null }> = [];
    const emitted = new Set<number>();

    const emitPhiUpdates = (targetBlockId: number, predecessor: AnyBlock | null = null) => {
      const targetBlock = blockMap.get(targetBlockId);
      if (!targetBlock) return;
      const edgeArgs =
        predecessor
          ? predecessor.getEdgeArgs(targetBlock)
          : null;
      const pending: Array<{
        phiLocal: WasmLocalId;
        tempLocal: WasmLocalId;
        inputLocal: WasmLocalId;
        inputType: WasmType | undefined;
        phiType: WasmType | undefined;
      }> = [];
      for (const node of targetBlock.nodes) {
        if (node.type !== ir.IR_PHI) break;
        const phiLocal = analysis.nodeLocal.get(node.id);
        const tempLocal = analysis.phiUpdateTempLocal?.get(node.id);
        if (phiLocal === undefined) continue;
        if (tempLocal === undefined) continue;
        const phiIndex = metadataNumber(node.props.index) ?? 0;
        const input =
          edgeArgs && edgeArgs.length > phiIndex
            ? edgeArgs[phiIndex]
            : node.inputs.length > 1
              ? node.inputs[1]
              : node.inputs[0];
        if (!input) continue;
        const inputLocal = this.resolveLocal(input.id, analysis);
        if (inputLocal === undefined) continue;
        const inputType = analysis.nodeWasmType.get(input.id);
        const phiType = analysis.nodeWasmType.get(node.id);
        pending.push({ phiLocal, tempLocal, inputLocal, inputType, phiType });
      }
      for (const update of pending) {
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(update.inputLocal),
        );
        if (
          update.phiType === wasmFormat.TYPE_F64 &&
          update.inputType === wasmFormat.TYPE_I32
        ) {
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        } else if (
          update.phiType === wasmFormat.TYPE_I32 &&
          update.inputType === wasmFormat.TYPE_F64
        ) {
          this.emitToInt32FromF64(bytes, analysis);
        }
        bytes.push(
          wasmFormat.OP_LOCAL_SET,
          ...wasmFormat.encodeU32(update.tempLocal),
        );
      }
      for (const update of pending) {
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(update.tempLocal),
        );
        bytes.push(
          wasmFormat.OP_LOCAL_SET,
          ...wasmFormat.encodeU32(update.phiLocal),
        );
      }
    };

    const emitBlockNodes = (
      block: AnyBlock,
      options: { stopBeforeTargets?: Set<number> } = {},
    ) => {
      for (const node of block.nodes) {
        if (node.type === ir.IR_JUMP) {
          const targetId = metadataNumber(node.props.targetBlock);
          if (targetId === null) {
            failEmit("jump without a target block");
            return;
          }
          if (options.stopBeforeTargets?.has(targetId)) {
            emitPhiUpdates(targetId, block);
            return;
          }
          if (loopHeaders.has(targetId)) {
            const loopLabelIdx = this.findLabelDepth(
              labelStack,
              "loop",
              targetId,
            );
            if (loopLabelIdx >= 0) {
              emitPhiUpdates(targetId, block);
              bytes.push(
                wasmFormat.OP_BR,
                ...wasmFormat.encodeU32(loopLabelIdx),
              );
              return;
            }
          }
          const blockLabelIdx = this.findLabelDepth(
            labelStack,
            "block",
            targetId,
          );
          if (blockLabelIdx >= 0) {
            emitPhiUpdates(targetId, block);
            bytes.push(
              wasmFormat.OP_BR,
              ...wasmFormat.encodeU32(blockLabelIdx),
            );
            return;
          }
          if (!emitted.has(targetId) && blockMap.has(targetId)) {
            emitPhiUpdates(targetId, block);
            const nextBlock = blockMap.get(targetId);
            if (nextBlock) emitRegion(nextBlock);
          } else {
            failEmit(`jump to block ${targetId} has no reachable label`);
          }
          return;
        }

        if (node.type === ir.IR_BRANCH) {
          const condLocal = this.resolveLocal(node.inputs[0].id, analysis);
          const trueBlockId = metadataNumber(node.props.trueBlock);
          const falseBlockId = metadataNumber(node.props.falseBlock);
          if (trueBlockId === null || falseBlockId === null) {
            failEmit("branch without both target blocks");
            return;
          }

          const trueIsBackEdge =
            loopHeaders.has(trueBlockId) &&
            this.findLabelDepth(labelStack, "loop", trueBlockId) >= 0;
          const falseIsBackEdge =
            loopHeaders.has(falseBlockId) &&
            this.findLabelDepth(labelStack, "loop", falseBlockId) >= 0;

          if (trueIsBackEdge) {
            const loopDepth = this.findLabelDepth(
              labelStack,
              "loop",
              trueBlockId,
            );
            emitPhiUpdates(trueBlockId, block);
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            bytes.push(wasmFormat.OP_BR_IF, ...wasmFormat.encodeU32(loopDepth));
            if (!emitted.has(falseBlockId) && blockMap.has(falseBlockId)) {
              const nextBlock = blockMap.get(falseBlockId);
              if (nextBlock) emitRegion(nextBlock);
            } else {
              const exitDepth = this.findLabelDepth(
                labelStack,
                "block",
                falseBlockId,
              );
              if (exitDepth >= 0) {
                bytes.push(
                  wasmFormat.OP_BR,
                  ...wasmFormat.encodeU32(exitDepth),
                );
              } else {
                failEmit(`loop exit to block ${falseBlockId} has no reachable label`);
              }
            }
            return;
          }

          if (falseIsBackEdge) {
            const loopDepth = this.findLabelDepth(
              labelStack,
              "loop",
              falseBlockId,
            );
            emitPhiUpdates(falseBlockId, block);
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            bytes.push(wasmFormat.OP_I32_EQZ);
            bytes.push(wasmFormat.OP_BR_IF, ...wasmFormat.encodeU32(loopDepth));
            if (!emitted.has(trueBlockId) && blockMap.has(trueBlockId)) {
              const nextBlock = blockMap.get(trueBlockId);
              if (nextBlock) emitRegion(nextBlock);
            } else {
              const exitDepth = this.findLabelDepth(
                labelStack,
                "block",
                trueBlockId,
              );
              if (exitDepth >= 0) {
                bytes.push(
                  wasmFormat.OP_BR,
                  ...wasmFormat.encodeU32(exitDepth),
                );
              } else {
                failEmit(`loop exit to block ${trueBlockId} has no reachable label`);
              }
            }
            return;
          }

          const trueExitLabel = this.findLabelDepth(
            labelStack,
            "block",
            trueBlockId,
          );
          const falseExitLabel = this.findLabelDepth(
            labelStack,
            "block",
            falseBlockId,
          );

          if (trueExitLabel >= 0 && falseExitLabel >= 0) {
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            bytes.push(
              wasmFormat.OP_BR_IF,
              ...wasmFormat.encodeU32(trueExitLabel),
            );
            bytes.push(
              wasmFormat.OP_BR,
              ...wasmFormat.encodeU32(falseExitLabel),
            );
            return;
          }

          if (trueExitLabel >= 0 !== falseExitLabel >= 0) {
            const exitIsTrue = trueExitLabel >= 0;
            const exitBlockId = exitIsTrue ? trueBlockId : falseBlockId;
            const fallThroughId = exitIsTrue ? falseBlockId : trueBlockId;

            labelStack.push({ type: "block", targetId: null });
            bytes.push(wasmFormat.OP_BLOCK, wasmFormat.TYPE_VOID);
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            if (exitIsTrue) bytes.push(wasmFormat.OP_I32_EQZ);
            bytes.push(wasmFormat.OP_BR_IF, ...wasmFormat.encodeU32(0));
            emitPhiUpdates(exitBlockId, block);
            const exitDepth = this.findLabelDepth(
              labelStack,
              "block",
              exitBlockId,
            );
            if (exitDepth >= 0) {
              bytes.push(wasmFormat.OP_BR, ...wasmFormat.encodeU32(exitDepth));
            } else {
              failEmit(`branch exit to block ${exitBlockId} has no reachable label`);
            }
            bytes.push(wasmFormat.OP_END);
            labelStack.pop();

            emitSuccessor(fallThroughId, block);
            return;
          }

          const trueBlock = blockMap.get(trueBlockId);
          const falseBlock = blockMap.get(falseBlockId);
          const trueJoinId =
            trueBlock && trueBlock.successors.length === 1
              ? trueBlock.successors[0].id
              : null;
          const falseJoinId =
            falseBlock && falseBlock.successors.length === 1
              ? falseBlock.successors[0].id
              : null;
          const mergeBlockId =
            trueJoinId !== null && trueJoinId === falseJoinId
              ? trueJoinId
              : this.findMergeBlock(
                  trueBlockId,
                  falseBlockId,
                  blockMap,
                  orderIndex,
                );

          if (trueJoinId === falseBlockId) {
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
            labelStack.push({ type: "if", targetId: null });
            const trueRegion = blockMap.get(trueBlockId);
            if (trueRegion && !emitted.has(trueBlockId)) {
              emitRegion(trueRegion, {
                stopBeforeTargets: new Set([falseBlockId]),
              });
            }
            bytes.push(wasmFormat.OP_ELSE);
            emitPhiUpdates(falseBlockId, block);
            bytes.push(wasmFormat.OP_END);
            labelStack.pop();
            emitSuccessor(falseBlockId, block);
          } else if (falseJoinId === trueBlockId) {
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
            labelStack.push({ type: "if", targetId: null });
            emitPhiUpdates(trueBlockId, block);
            bytes.push(wasmFormat.OP_ELSE);
            const falseRegion = blockMap.get(falseBlockId);
            if (falseRegion && !emitted.has(falseBlockId)) {
              emitRegion(falseRegion, {
                stopBeforeTargets: new Set([trueBlockId]),
              });
            }
            bytes.push(wasmFormat.OP_END);
            labelStack.pop();
            emitSuccessor(trueBlockId, block);
          } else if (mergeBlockId !== null) {
            const mergeAlreadyOpen =
              this.findLabelDepth(labelStack, "block", mergeBlockId) >= 0;
            if (!mergeAlreadyOpen) {
              labelStack.push({ type: "block", targetId: mergeBlockId });
              bytes.push(wasmFormat.OP_BLOCK, wasmFormat.TYPE_VOID);
            }

            labelStack.push({ type: "block", targetId: falseBlockId });
            bytes.push(wasmFormat.OP_BLOCK, wasmFormat.TYPE_VOID);

            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            bytes.push(wasmFormat.OP_BR_IF, ...wasmFormat.encodeU32(0));

            emitSuccessor(falseBlockId, block);
            const mergeBrDepth = this.findLabelDepth(
              labelStack,
              "block",
              mergeBlockId,
            );
            if (mergeBrDepth >= 0) {
              bytes.push(
                wasmFormat.OP_BR,
                ...wasmFormat.encodeU32(mergeBrDepth),
              );
            } else {
              failEmit(`merge at block ${mergeBlockId} has no reachable label`);
            }

            bytes.push(wasmFormat.OP_END);
            labelStack.pop();

            emitSuccessor(trueBlockId, block);

            if (!mergeAlreadyOpen) {
              bytes.push(wasmFormat.OP_END);
              labelStack.pop();

              const mergeRegion = blockMap.get(mergeBlockId);
              if (mergeRegion && !emitted.has(mergeBlockId)) {
                emitRegion(mergeRegion);
              } else {
                failEmit(`merge block ${mergeBlockId} was emitted outside its label`);
              }
            }
          } else {
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(condLocal),
            );
            bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
            labelStack.push({ type: "if", targetId: null });
            emitSuccessor(trueBlockId, block);
            bytes.push(wasmFormat.OP_ELSE);
            emitSuccessor(falseBlockId, block);
            bytes.push(wasmFormat.OP_END);
            labelStack.pop();
          }
          return;
        }
        this.emitNode(
          node,
          analysis,
          bytes,
          deoptImportIdx,
          runtimeStubImportIdx,
          allocObjImportIdx,
        );
      }
    };

    const emitSuccessor = (targetId: number, from: AnyBlock) => {
      const region = blockMap.get(targetId);
      if (region && !emitted.has(targetId)) {
        emitRegion(region);
        return;
      }
      const labelIdx = this.findLabelDepth(labelStack, "block", targetId);
      if (labelIdx >= 0) {
        emitPhiUpdates(targetId, from);
        bytes.push(wasmFormat.OP_BR, ...wasmFormat.encodeU32(labelIdx));
        return;
      }
      failEmit(`block ${targetId} has no reachable label`);
    };

    const emitRegion = (
      block: AnyBlock,
      options: { stopBeforeTargets?: Set<number> } = {},
    ) => {
      if (emitted.has(block.id)) return;

      if (loopHeaders.has(block.id)) {
      const loopInfo = loopInfoMap.get(block.id);
      if (!loopInfo) {
        emitted.add(block.id);
        emitBlockNodes(block, options);
        return;
      }
      const { loopBlocks, exitBlockIds } = loopInfo;

        for (const node of block.nodes) {
          if (node.type !== ir.IR_PHI) break;
          const loc = analysis.nodeLocal.get(node.id);
          if (loc === undefined) continue;
          if (node.inputs.length > 0) {
            const firstInput = node.inputs[0];
            const inputLocal = this.resolveLocal(firstInput.id, analysis);
            if (inputLocal !== undefined) {
              const inputType = analysis.nodeWasmType.get(firstInput.id);
              const phiType = analysis.nodeWasmType.get(node.id);
              bytes.push(
                wasmFormat.OP_LOCAL_GET,
                ...wasmFormat.encodeU32(inputLocal),
              );
              if (
                phiType === wasmFormat.TYPE_F64 &&
                inputType === wasmFormat.TYPE_I32
              ) {
                bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
              } else if (
                phiType === wasmFormat.TYPE_I32 &&
                inputType === wasmFormat.TYPE_F64
              ) {
                this.emitToInt32FromF64(bytes, analysis);
              }
              bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
            }
          }
        }

        for (let k = exitBlockIds.length - 1; k >= 0; k--) {
          labelStack.push({ type: "block", targetId: exitBlockIds[k] });
          bytes.push(wasmFormat.OP_BLOCK, wasmFormat.TYPE_VOID);
        }

        labelStack.push({ type: "loop", targetId: block.id });
        bytes.push(wasmFormat.OP_LOOP, wasmFormat.TYPE_VOID);

        emitted.add(block.id);
        emitBlockNodes(block);

        for (const lb of order) {
          if (!loopBlocks.has(lb.id) || emitted.has(lb.id)) continue;
          emitted.add(lb.id);
          emitBlockNodes(lb);
        }

        bytes.push(wasmFormat.OP_END);
        labelStack.pop();

        for (const exitBlockId of exitBlockIds) {
          bytes.push(wasmFormat.OP_END);
          labelStack.pop();

          const exitRegion = blockMap.get(exitBlockId);
          if (exitRegion && !emitted.has(exitBlockId)) {
            emitRegion(exitRegion);
          }
        }
      } else {
        emitted.add(block.id);
        emitBlockNodes(block, options);
      }
    };

    for (const block of order) {
      if (!emitted.has(block.id)) {
        emitRegion(block);
      }
    }

    if (order.length > 1) {
      bytes.push(wasmFormat.OP_UNREACHABLE);
    }

    return bytes;
  }

  findLabelDepth(
    labelStack: Array<{ type: string; targetId: number | null }>,
    type: string,
    targetId: number | null,
  ): number {
    for (let i = labelStack.length - 1; i >= 0; i--) {
      if (labelStack[i].type === type && labelStack[i].targetId === targetId) {
        return labelStack.length - 1 - i;
      }
    }
    return -1;
  }

  findMergeBlock(
    trueBlockId: number,
    falseBlockId: number,
    blockMap: Map<number, AnyBlock>,
    orderIndex: Map<number, number>,
  ): number | null {
    const trueReachable = new Set<number>();
    const queue: number[] = [trueBlockId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      if (trueReachable.has(id)) continue;
      trueReachable.add(id);
      const block = blockMap.get(id);
      if (block) {
        for (const succ of block.successors) {
          queue.push(succ.id);
        }
      }
    }

    const falseQueue: number[] = [falseBlockId];
    const falseVisited = new Set<number>();
    const candidates: number[] = [];
    while (falseQueue.length > 0) {
      const id = falseQueue.shift();
      if (id === undefined) continue;
      if (falseVisited.has(id)) continue;
      falseVisited.add(id);
      if (trueReachable.has(id)) {
        candidates.push(id);
        continue;
      }
      const block = blockMap.get(id);
      if (block) {
        for (const succ of block.successors) {
          falseQueue.push(succ.id);
        }
      }
    }

    const minMergeIndex = Math.max(
      orderIndex.get(trueBlockId) ?? -1,
      orderIndex.get(falseBlockId) ?? -1,
    );
    const forwardCandidates = candidates.filter(
      (id) =>
        id !== trueBlockId &&
        id !== falseBlockId &&
        (orderIndex.get(id) ?? -1) > minMergeIndex,
    );
    if (forwardCandidates.length === 0) return null;

    forwardCandidates.sort(
      (a, b) => (orderIndex.get(a) || 0) - (orderIndex.get(b) || 0),
    );
    return forwardCandidates[0] ?? null;
  }

  emitDeoptSnapshot(fs: FrameState | null, analysis: AnyAnalysis, bytes: number[]): void {
    if (!fs || !analysis.needsMemory) return;

    let offset = 8;
    const writeValue = (val: FrameValue | null | undefined) => {
      const node = frameNode(val);
      if (node) {
        const loc = resolveNodeLocal(node.id, analysis);
        if (loc !== undefined) {
          const type = analysis.nodeWasmType.get(node.id);
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(offset));
          bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(loc));
          if (type === wasmFormat.TYPE_I32)
            bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
          bytes.push(
            wasmFormat.OP_F64_STORE,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(0),
          );
        }
      }
      offset += 8;
    };

    visitDeoptSnapshotValues(fs, writeValue);
  }

  emitConditionalDeopt(
    node: AnyNode,
    analysis: AnyAnalysis,
    bytes: number[],
    deoptImportIdx: number,
    reason: string,
  ): void {
    bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
    this.emitDeoptSnapshot(node.frameState, analysis, bytes);
    bytes.push(
      wasmFormat.OP_I32_CONST,
      ...wasmFormat.encodeS32(deoptReasonId(reason)),
    );
    bytes.push(
      wasmFormat.OP_I32_CONST,
      ...wasmFormat.encodeS32(node.frameState?.id ?? 0),
    );
    bytes.push(wasmFormat.OP_CALL, ...wasmFormat.encodeU32(deoptImportIdx));
    bytes.push(wasmFormat.OP_UNREACHABLE);
    bytes.push(wasmFormat.OP_END);
  }

  emitNumberGuard(
    node: AnyNode,
    analysis: AnyAnalysis,
    bytes: number[],
    deoptImportIdx: number,
    requireSmi: boolean,
  ): void {
    const inputLocal = this.resolveLocal(node.inputs[0].id, analysis);
    if (inputLocal === undefined) return;
    if (!requireSmi) return;
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(inputLocal));
    bytes.push(wasmFormat.OP_F64_TRUNC);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(inputLocal));
    bytes.push(wasmFormat.OP_F64_NE);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(inputLocal));
    bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(SMI_MIN));
    bytes.push(wasmFormat.OP_F64_LT);
    bytes.push(wasmFormat.OP_I32_OR);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(inputLocal));
    bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(SMI_MAX));
    bytes.push(wasmFormat.OP_F64_GT);
    bytes.push(wasmFormat.OP_I32_OR);
    this.emitConditionalDeopt(
      node,
      analysis,
      bytes,
      deoptImportIdx,
      deoptReasonForNode(node),
    );
  }

  emitRuntimeStubCall(node: AnyNode, analysis: AnyAnalysis, bytes: number[], runtimeStubImportIdx: number, deoptImportIdx: number): void {
    if (runtimeStubImportIdx < 0) {
      bytes.push(wasmFormat.OP_UNREACHABLE);
      return;
    }
    const stub = analysis.runtimeStubTable.getByNodeId(node.id);
    if (!stub) {
      bytes.push(wasmFormat.OP_UNREACHABLE);
      return;
    }
    const loc = analysis.nodeLocal.get(node.id);
    const fsId = node.frameState?.id ?? stub.frameStateId ?? 0;
    bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(stub.id));
    bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
    for (let i = 0; i < 8; i++) {
      const input = node.inputs[i];
      if (input) {
        const inputLocal = this.resolveLocal(input.id, analysis);
        const inputType = analysis.nodeWasmType.get(input.id);
        if (inputLocal !== undefined) {
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(inputLocal),
          );
          if (inputType === wasmFormat.TYPE_I32)
            bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        } else {
          bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(0));
        }
      } else {
        bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(0));
      }
    }
    bytes.push(
      wasmFormat.OP_CALL,
      ...wasmFormat.encodeU32(runtimeStubImportIdx),
    );
    if (loc !== undefined) {
      const outType = analysis.nodeWasmType.get(node.id);
      if (outType === wasmFormat.TYPE_I32) {
        if (deoptImportIdx >= 0) {
          this.emitCheckedInt64FromF64(
            bytes,
            analysis,
            node.frameState,
            node.frameState?.id ?? 0,
            deoptImportIdx,
          );
          bytes.push(wasmFormat.OP_I32_WRAP_I64);
        } else {
          this.emitToInt32FromF64(bytes, analysis);
        }
      }
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
    } else {
      bytes.push(wasmFormat.OP_DROP);
    }
  }

  emitSpeculativeArith(node: AnyNode, analysis: AnyAnalysis, bytes: number[], deoptImportIdx: number): void {
    const local = (nodeId: number) => this.resolveLocal(nodeId, analysis);
    const loc = analysis.nodeLocal.get(node.id);
    const specType = node._speculativeType;
    const fsId = node.frameState?.id ?? 0;

    if (specType === ir.IR_INT32_COMPARE || specType === ir.IR_FLOAT64_COMPARE) {
      if (loc === undefined) return;
      const useF64 = specType === ir.IR_FLOAT64_COMPARE;
      const op = metadataString(node.props.op);
      const opEntry = op ? COMPARE_OPS[op] : undefined;
      if (!opEntry) return;
      const opcode = useF64 ? opEntry.f64 : opEntry.i32;
      const lt = analysis.nodeWasmType.get(node.inputs[0].id);
      const rt = analysis.nodeWasmType.get(node.inputs[1].id);
      bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[0].id)));
      if (useF64 && lt === wasmFormat.TYPE_I32) bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
      bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[1].id)));
      if (useF64 && rt === wasmFormat.TYPE_I32) bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
      bytes.push(opcode);
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      return;
    }

    if (isInt32ArithmeticOpcode(specType)) {
      if (loc === undefined) return;
      const lt = analysis.nodeWasmType.get(node.inputs[0].id);
      const rt = analysis.nodeWasmType.get(node.inputs[1].id);
      if (INT32_OVERFLOW_CHECK.has(specType) && analysis.hasOverflowChecks && deoptImportIdx >= 0) {
        const tmpLocal = analysis.overflowTempLocal;
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[0].id)));
        if (lt === wasmFormat.TYPE_F64) {
          this.emitCheckedInt64FromF64(bytes, analysis, node.frameState, fsId, deoptImportIdx);
        } else {
          bytes.push(wasmFormat.OP_I64_EXTEND_I32_S);
        }
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[1].id)));
        if (rt === wasmFormat.TYPE_F64) {
          this.emitCheckedInt64FromF64(bytes, analysis, node.frameState, fsId, deoptImportIdx);
        } else {
          bytes.push(wasmFormat.OP_I64_EXTEND_I32_S);
        }
        const overflowOpcode = INT64_ARITH_OPCODES[specType];
        if (overflowOpcode === undefined) return;
        bytes.push(overflowOpcode);
        bytes.push(wasmFormat.OP_LOCAL_TEE, ...wasmFormat.encodeU32(tmpLocal));
        bytes.push(wasmFormat.OP_I64_CONST, ...wasmFormat.encodeS64(2147483647));
        bytes.push(wasmFormat.OP_I64_GT_S);
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(tmpLocal));
        bytes.push(wasmFormat.OP_I64_CONST, ...wasmFormat.encodeS64(-2147483648));
        bytes.push(wasmFormat.OP_I64_LT_S);
        bytes.push(wasmFormat.OP_I32_OR);
        bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
        if (node.frameState) this.emitDeoptSnapshot(node.frameState, analysis, bytes);
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(deoptReasonId(DEOPT_OVERFLOW)));
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
        bytes.push(wasmFormat.OP_CALL, ...wasmFormat.encodeU32(deoptImportIdx));
        bytes.push(wasmFormat.OP_UNREACHABLE);
        bytes.push(wasmFormat.OP_END);
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(tmpLocal));
        bytes.push(wasmFormat.OP_I32_WRAP_I64);
      } else {
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[0].id)));
        if (lt === wasmFormat.TYPE_F64) this.emitToInt32FromF64(bytes, analysis);
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[1].id)));
        if (rt === wasmFormat.TYPE_F64) this.emitToInt32FromF64(bytes, analysis);
        const opcode = INT32_ARITH_OPCODES[specType];
        if (opcode === undefined) return;
        bytes.push(opcode);
      }
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      return;
    }

    if (isFloat64ArithmeticOpcode(specType)) {
      if (loc === undefined) return;
      const lt = analysis.nodeWasmType.get(node.inputs[0].id);
      const rt = analysis.nodeWasmType.get(node.inputs[1].id);
      bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[0].id)));
      if (lt === wasmFormat.TYPE_I32) bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
      bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(local(node.inputs[1].id)));
      if (rt === wasmFormat.TYPE_I32) bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
      const opcode = FLOAT64_ARITH_OPCODES[specType];
      if (opcode === undefined) return;
      bytes.push(opcode);
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      return;
    }
  }

  emitSelfRecursiveCall(node: AnyNode, analysis: AnyAnalysis, bytes: number[]): void {
    const loc = analysis.nodeLocal.get(node.id);
    const { paramTypes } = analysis;
    for (let i = 0; i < node.inputs.length; i++) {
      const input = node.inputs[i];
      const inputLocal = this.resolveLocal(input.id, analysis);
      const inputType = analysis.nodeWasmType.get(input.id);
      const targetType = paramTypes[i];
      if (inputLocal !== undefined) {
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(inputLocal),
        );
        if (inputType !== targetType) {
          if (inputType === wasmFormat.TYPE_I32 && targetType === wasmFormat.TYPE_F64)
            bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
          else if (inputType === wasmFormat.TYPE_F64 && targetType === wasmFormat.TYPE_I32)
            this.emitToInt32FromF64(bytes, analysis);
        }
      } else {
        if (targetType === wasmFormat.TYPE_F64)
          bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(0));
        else
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(0));
      }
    }
    bytes.push(
      wasmFormat.OP_CALL,
      ...wasmFormat.encodeU32(analysis.selfCallFuncIdx ?? 0),
    );
    if (loc !== undefined) {
      const outType = analysis.nodeWasmType.get(node.id);
      if (outType !== analysis.resultType) {
        if (analysis.resultType === wasmFormat.TYPE_F64 && outType === wasmFormat.TYPE_I32)
          this.emitToInt32FromF64(bytes, analysis);
        else if (analysis.resultType === wasmFormat.TYPE_I32 && outType === wasmFormat.TYPE_F64)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
      }
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
    } else {
      bytes.push(wasmFormat.OP_DROP);
    }
  }

  emitGlobalCellAccess(node: AnyNode, offset: number, analysis: AnyAnalysis, bytes: number[]): void {
    const local = (nodeId: number) => this.resolveLocal(nodeId, analysis);

    if (node.type === ir.IR_LOAD_GLOBAL) {
      const loc = analysis.nodeLocal.get(node.id);
      if (loc === undefined) return;
      const outType = analysis.nodeWasmType.get(node.id);
      bytes.push(
        wasmFormat.OP_I32_CONST,
        ...wasmFormat.encodeS32(offset),
      );
      bytes.push(
        wasmFormat.OP_F64_LOAD,
        ...wasmFormat.encodeU32(3),
        ...wasmFormat.encodeU32(0),
      );
      if (outType === wasmFormat.TYPE_I32) {
        this.emitToInt32FromF64(bytes, analysis);
      }
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
    } else {
      const inputLocal = local(node.inputs[0].id);
      const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
      bytes.push(
        wasmFormat.OP_I32_CONST,
        ...wasmFormat.encodeS32(offset),
      );
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(inputLocal),
      );
      if (inputType === wasmFormat.TYPE_I32) {
        bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
      }
      bytes.push(
        wasmFormat.OP_F64_STORE,
        ...wasmFormat.encodeU32(3),
        ...wasmFormat.encodeU32(0),
      );
    }
  }

  emitToInt32FromF64(bytes: number[], analysis: AnyAnalysis): void {
    const scratch = analysis.toInt32ScratchLocal;
    bytes.push(wasmFormat.OP_LOCAL_TEE, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_DROP);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_F64_EQ);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_F64_ABS);
    bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(Infinity));
    bytes.push(wasmFormat.OP_F64_NE);
    bytes.push(wasmFormat.OP_I32_AND);
    bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_I32);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(
      wasmFormat.OP_MISC_PREFIX,
      wasmFormat.MISC_I64_TRUNC_SAT_F64_S,
    );
    bytes.push(wasmFormat.OP_I32_WRAP_I64);
    bytes.push(wasmFormat.OP_ELSE);
    bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(0));
    bytes.push(wasmFormat.OP_END);
  }

  emitCheckedInt64FromF64(
    bytes: number[],
    analysis: AnyAnalysis,
    frameState: AnyNode["frameState"],
    fsId: number,
    deoptImportIdx: number,
  ): void {
    const scratch = analysis.toInt32ScratchLocal;
    bytes.push(wasmFormat.OP_LOCAL_TEE, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_DROP);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_F64_TRUNC);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_F64_EQ);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(2147483647));
    bytes.push(wasmFormat.OP_F64_LE);
    bytes.push(wasmFormat.OP_I32_AND);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(-2147483648));
    bytes.push(wasmFormat.OP_F64_GE);
    bytes.push(wasmFormat.OP_I32_AND);
    bytes.push(wasmFormat.OP_I32_EQZ);
    bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
    this.emitDeoptSnapshot(frameState, analysis, bytes);
    bytes.push(
      wasmFormat.OP_I32_CONST,
      ...wasmFormat.encodeS32(deoptReasonId(DEOPT_OVERFLOW)),
    );
    bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
    bytes.push(wasmFormat.OP_CALL, ...wasmFormat.encodeU32(deoptImportIdx));
    bytes.push(wasmFormat.OP_UNREACHABLE);
    bytes.push(wasmFormat.OP_END);
    bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(scratch));
    bytes.push(
      wasmFormat.OP_MISC_PREFIX,
      wasmFormat.MISC_I64_TRUNC_SAT_F64_S,
    );
  }

  emitNativeNode(node: AnyNode, analysis: AnyAnalysis, bytes: number[]): void {
    const local = (nodeId: number) => this.resolveLocal(nodeId, analysis);
    const loc = analysis.nodeLocal.get(node.id);

    if (GENERIC_BITWISE_OPCODES[node.type] !== undefined) {
      if (loc === undefined) return;
      const leftType = analysis.nodeWasmType.get(node.inputs[0].id);
      const rightType = analysis.nodeWasmType.get(node.inputs[1].id);
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(local(node.inputs[0].id)),
      );
      if (leftType === wasmFormat.TYPE_F64)
        this.emitToInt32FromF64(bytes, analysis);
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(local(node.inputs[1].id)),
      );
      if (rightType === wasmFormat.TYPE_F64)
        this.emitToInt32FromF64(bytes, analysis);
      bytes.push(GENERIC_BITWISE_OPCODES[node.type]);
      if (node.type === ir.IR_GENERIC_USHR)
        bytes.push(wasmFormat.OP_F64_CONVERT_I32_U);
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      return;
    }

    if (node.type === ir.IR_GENERIC_BITNOT) {
      if (loc === undefined) return;
      const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(local(node.inputs[0].id)),
      );
      if (inputType === wasmFormat.TYPE_F64)
        this.emitToInt32FromF64(bytes, analysis);
      bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(-1));
      bytes.push(wasmFormat.OP_I32_XOR);
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      return;
    }

    if (node.type === ir.IR_NOT) {
      if (loc === undefined) return;
      const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(local(node.inputs[0].id)),
      );
      if (inputType === wasmFormat.TYPE_F64)
        this.emitToInt32FromF64(bytes, analysis);
      bytes.push(wasmFormat.OP_I32_EQZ);
      bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      return;
    }

    if (node.type === ir.IR_NEG) {
      if (loc === undefined) return;
      const rep = repForNode(node);
      const inputLocal = local(node.inputs[0].id);
      const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
      if (rep === REP_FLOAT64 || rep === REP_TAGGED_NUMBER) {
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(inputLocal),
        );
        if (inputType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        bytes.push(wasmFormat.OP_F64_NEG);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      } else {
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(0));
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(inputLocal),
        );
        if (inputType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        bytes.push(wasmFormat.OP_I32_SUB);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      }
      return;
    }

    if (node.type === ir.IR_TYPEOF) {
      return;
    }
  }

  emitMathIntrinsic(node: AnyNode, intrinsic: MathIntrinsicInfo["intrinsic"], analysis: AnyAnalysis, bytes: number[]): void {
    const local = (nodeId: number) => this.resolveLocal(nodeId, analysis);
    const loc = analysis.nodeLocal.get(node.id);
    if (loc === undefined) return;

    for (let i = 0; i < intrinsic.arity; i++) {
      const inputLocal = local(node.inputs[i].id);
      const inputType = analysis.nodeWasmType.get(node.inputs[i].id);
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(inputLocal),
      );
      if (inputType === wasmFormat.TYPE_I32)
        bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
    }
    if (intrinsic.opcode !== undefined) bytes.push(intrinsic.opcode);
    bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
  }

  emitPowSpecialCase(node: AnyNode, exp: number, analysis: AnyAnalysis, bytes: number[]): void {
    const local = (nodeId: number) => this.resolveLocal(nodeId, analysis);
    const loc = analysis.nodeLocal.get(node.id);
    if (loc === undefined) return;

    const baseLocal = local(node.inputs[0].id);
    const baseType = analysis.nodeWasmType.get(node.inputs[0].id);

    const pushBase = () => {
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(baseLocal),
      );
      if (baseType === wasmFormat.TYPE_I32)
        bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
    };

    if (exp === 0) {
      bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(1.0));
    } else if (exp === 1) {
      pushBase();
    } else if (exp === 2) {
      pushBase();
      pushBase();
      bytes.push(wasmFormat.OP_F64_MUL);
    } else if (exp === 0.5) {
      pushBase();
      bytes.push(wasmFormat.OP_F64_SQRT);
    } else if (exp === -1) {
      bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(1.0));
      pushBase();
      bytes.push(wasmFormat.OP_F64_DIV);
    }
    bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
  }

  emitNode(
    node: AnyNode,
    analysis: AnyAnalysis,
    bytes: number[],
    deoptImportIdx: number,
    runtimeStubImportIdx: number,
    allocObjImportIdx: number,
  ): void {
    const local = (nodeId: number) => this.resolveLocal(nodeId, analysis);

    if (
      node.type === ir.IR_NEW_OBJECT &&
      node.props.targetHiddenClassId != null &&
      node.props.targetSlotCount != null
    ) {
      const loc = analysis.nodeLocal.get(node.id);
      const hcId = metadataNumber(node.props.targetHiddenClassId);
      const slotCount = metadataNumber(node.props.targetSlotCount);
      if (hcId === null || slotCount === null) return;
      const objSize = 8 + slotCount * 8;

      bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(0));
      bytes.push(
        wasmFormat.OP_I32_LOAD,
        ...wasmFormat.encodeU32(2),
        ...wasmFormat.encodeU32(0),
      );

      if (loc !== undefined) {
        bytes.push(wasmFormat.OP_LOCAL_TEE, ...wasmFormat.encodeU32(loc));
      }

      bytes.push(
        wasmFormat.OP_LOCAL_TEE,
        ...wasmFormat.encodeU32(analysis._allocTempLocal),
      );

      bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(hcId));
      bytes.push(
        wasmFormat.OP_I32_STORE,
        ...wasmFormat.encodeU32(2),
        ...wasmFormat.encodeU32(0),
      );

      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(analysis._allocTempLocal),
      );
      bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(slotCount));
      bytes.push(
        wasmFormat.OP_I32_STORE,
        ...wasmFormat.encodeU32(2),
        ...wasmFormat.encodeU32(4),
      );

      for (let slot = 0; slot < slotCount; slot++) {
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(analysis._allocTempLocal),
        );
        bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(0));
        bytes.push(
          wasmFormat.OP_F64_STORE,
          ...wasmFormat.encodeU32(3),
          ...wasmFormat.encodeU32(8 + slot * 8),
        );
      }

      bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(0));
      bytes.push(
        wasmFormat.OP_LOCAL_GET,
        ...wasmFormat.encodeU32(analysis._allocTempLocal),
      );
      bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(objSize));
      bytes.push(wasmFormat.OP_I32_ADD);
      bytes.push(
        wasmFormat.OP_I32_STORE,
        ...wasmFormat.encodeU32(2),
        ...wasmFormat.encodeU32(0),
      );
      return;
    }

    if (
      node.type === ir.IR_NEW_OBJECT &&
      node.props.targetHiddenClassId != null &&
      allocObjImportIdx >= 0
    ) {
      const loc = analysis.nodeLocal.get(node.id);
      const hcId = metadataNumber(node.props.targetHiddenClassId);
      if (hcId === null) return;
      bytes.push(
        wasmFormat.OP_I32_CONST,
        ...wasmFormat.encodeS32(hcId),
      );
      bytes.push(
        wasmFormat.OP_CALL,
        ...wasmFormat.encodeU32(allocObjImportIdx),
      );
      if (loc !== undefined) {
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      } else {
        bytes.push(wasmFormat.OP_DROP);
      }
      return;
    }

    if (this.needsFieldRuntimeStub(node)) {
      this.emitRuntimeStubCall(node, analysis, bytes, runtimeStubImportIdx, deoptImportIdx);
      return;
    }

    if (isNativeEligible(node)) {
      this.emitNativeNode(node, analysis, bytes);
      return;
    }

    {
      const intrinsic = mathIntrinsicForNode(node);
      if (intrinsic) {
        this.emitMathIntrinsic(node, intrinsic, analysis, bytes);
        return;
      }
    }

    if (
      node.type === ir.IR_FLOAT64_POW &&
      node.inputs[1]?.type === ir.IR_CONSTANT &&
      (typeof node.inputs[1].props.value === "number" ||
        typeof node.inputs[1].props.value === "boolean")
    ) {
      const exp = Number(node.inputs[1].props.value);
      if (exp === 0 || exp === 1 || exp === 2 || exp === 0.5 || exp === -1) {
        this.emitPowSpecialCase(node, exp, analysis, bytes);
        return;
      }
    }

    if (
      analysis.globalCellOffsets &&
      (node.type === ir.IR_LOAD_GLOBAL || node.type === ir.IR_STORE_GLOBAL)
    ) {
      const name = metadataString(node.props.name);
      const offset = name === null ? undefined : analysis.globalCellOffsets.get(name);
      if (offset !== undefined) {
        this.emitGlobalCellAccess(node, offset, analysis, bytes);
        return;
      }
    }

    if (
      analysis.hasSelfRecursion &&
      node.type === ir.IR_CALL_KNOWN_FUNCTION &&
      node.props.target === analysis._compiledFn
    ) {
      this.emitSelfRecursiveCall(node, analysis, bytes);
      return;
    }

    if (node._speculativeType) {
      this.emitSpeculativeArith(node, analysis, bytes, deoptImportIdx);
      return;
    }

    if (node._deadForSelfRecursion) {
      return;
    }

    if (analysis.mathCallDead.has(node.id)) {
      return;
    }

    {
      const mathInfo = analysis.mathCallIntrinsics.get(node.id);
      if (mathInfo) {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc !== undefined) {
          for (const argInput of mathInfo.argInputs) {
            const argLocal = this.resolveLocal(argInput.id, analysis);
            const argType = analysis.nodeWasmType.get(argInput.id);
            if (argLocal === undefined) return;
            bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(argLocal));
            if (argType === wasmFormat.TYPE_I32) bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
          }
          if (mathInfo.intrinsic.opcode === undefined) return;
          bytes.push(mathInfo.intrinsic.opcode);
          bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        }
        return;
      }
    }

    if (
      (node.type === ir.IR_GENERIC_ADD ||
        node.type === ir.IR_GENERIC_SUB ||
        node.type === ir.IR_GENERIC_MUL) &&
      analysis.nodeWasmType.get(node.id) === wasmFormat.TYPE_F64 &&
      !analysis.runtimeStubTable.getByNodeId?.(node.id)
    ) {
      const loc = analysis.nodeLocal.get(node.id);
      if (loc !== undefined) {
        const GENERIC_F64_OP: Record<string, number> = {
          [ir.IR_GENERIC_ADD]: wasmFormat.OP_F64_ADD,
          [ir.IR_GENERIC_SUB]: wasmFormat.OP_F64_SUB,
          [ir.IR_GENERIC_MUL]: wasmFormat.OP_F64_MUL,
        };
        for (let i = 0; i < 2; i++) {
          const inp = node.inputs[i];
          if (!inp) return;
          const inpLocal = this.resolveLocal(inp.id, analysis);
          const inpType = analysis.nodeWasmType.get(inp.id);
          if (inpLocal === undefined) return;
          bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(inpLocal));
          if (inpType === wasmFormat.TYPE_I32) bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        }
          const opcode = GENERIC_F64_OP[node.type];
          if (opcode === undefined) return;
          bytes.push(opcode);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
      }
      return;
    }

    if (RUNTIME_STUB_NODES.has(node.type)) {
      this.emitRuntimeStubCall(node, analysis, bytes, runtimeStubImportIdx, deoptImportIdx);
      return;
    }

    switch (node.type) {
      case ir.IR_CONSTANT: {
        const v = node.props.value;
        const wType = analysis.nodeWasmType.get(node.id);
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;

        if (typeof v === "boolean" || typeof v === "number") {
          if (wType === wasmFormat.TYPE_F64) {
            bytes.push(
              wasmFormat.OP_F64_CONST,
              ...wasmFormat.encodeF64(typeof v === "number" ? v : 0),
            );
          } else {
            const intVal = typeof v === "boolean" ? (v ? 1 : 0) : v | 0;
            bytes.push(
              wasmFormat.OP_I32_CONST,
              ...wasmFormat.encodeS32(intVal),
            );
          }
        } else {
          const ptrIdx = node._constPtrIndex || 0;
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(ptrIdx));
        }
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_LOAD_LOCAL: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const slotLocal = analysis._localSlotMap
          ? analysis._localSlotMap.get(node.props.slot)
          : undefined;
        if (slotLocal !== undefined) {
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(slotLocal),
          );
          bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        } else {
          bytes.push(wasmFormat.OP_F64_CONST, ...wasmFormat.encodeF64(0));
          bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        }
        break;
      }

      case ir.IR_STORE_LOCAL: {
        const slotLocal = analysis._localSlotMap
          ? analysis._localSlotMap.get(node.props.slot)
          : undefined;
        if (slotLocal !== undefined && node.inputs[0]) {
          const inputLocal = local(node.inputs[0].id);
          if (inputLocal !== undefined) {
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(inputLocal),
            );
            const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
            if (inputType === wasmFormat.TYPE_I32)
              bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
            bytes.push(
              wasmFormat.OP_LOCAL_SET,
              ...wasmFormat.encodeU32(slotLocal),
            );
          }
        }
        break;
      }

      case ir.IR_LOAD_CONST: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const ptrIdx = node._constPtrIndex || 0;
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(ptrIdx));
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_CHECK_SMI:
      case ir.IR_CHECK_NUMBER: {
        const input = node.inputs[0];
        if (
          deoptImportIdx >= 0 &&
          input.type !== ir.IR_PARAMETER &&
          analysis.nodeWasmType.get(input.id) === wasmFormat.TYPE_F64
        ) {
          this.emitNumberGuard(
            node,
            analysis,
            bytes,
            deoptImportIdx,
            node.type === ir.IR_CHECK_SMI,
          );
        }
        break;
      }

      case ir.IR_CHECK_MAP:
      case ir.IR_CHECK_ARRAY: {
        const objLocal = local(node.inputs[0].id);
        const expectedMapId = metadataNumber(node.props.expectedMapId);
        const mapId = node.type === ir.IR_CHECK_ARRAY ? -1 : expectedMapId;
        if (mapId === null) break;
        const fsId = node.frameState?.id ?? 0;

        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(objLocal));
        bytes.push(
          wasmFormat.OP_I32_LOAD,
          ...wasmFormat.encodeU32(2),
          ...wasmFormat.encodeU32(0),
        );
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(mapId));
        bytes.push(wasmFormat.OP_I32_NE);
        bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
        if (deoptImportIdx >= 0) {
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(deoptReasonForNode(node))),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
        }
        bytes.push(wasmFormat.OP_UNREACHABLE);
        bytes.push(wasmFormat.OP_END);
        break;
      }

      case ir.IR_CHECK_ELEMENTS_KIND: {
        const arrayLocal = local(node.inputs[0].id);
        const kindName = elementsKindName(node.props.elementsKind);
        if (kindName === null) break;
        const expectedKind = elementsKindId(kindName);
        const fsId = node.frameState?.id ?? 0;

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(arrayLocal),
        );
        bytes.push(
          wasmFormat.OP_I32_LOAD,
          ...wasmFormat.encodeU32(2),
          ...wasmFormat.encodeU32(8),
        );
        bytes.push(
          wasmFormat.OP_I32_CONST,
          ...wasmFormat.encodeS32(expectedKind),
        );
        bytes.push(wasmFormat.OP_I32_NE);
        bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
        if (deoptImportIdx >= 0) {
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(deoptReasonForNode(node))),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
        }
        bytes.push(wasmFormat.OP_UNREACHABLE);
        bytes.push(wasmFormat.OP_END);
        break;
      }

      case ir.IR_CHECK_BOUNDS: {
        const indexLocal = local(node.inputs[0].id);
        const arrayLocal = local(node.inputs[1].id);
        const indexType = analysis.nodeWasmType.get(node.inputs[0].id);
        const fsId = node.frameState?.id ?? 0;

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(indexLocal),
        );
        if (indexType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(0));
        bytes.push(wasmFormat.OP_I32_LT_S);

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(indexLocal),
        );
        if (indexType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(arrayLocal),
        );
        bytes.push(
          wasmFormat.OP_I32_LOAD,
          ...wasmFormat.encodeU32(2),
          ...wasmFormat.encodeU32(4),
        );
        bytes.push(wasmFormat.OP_I32_GE_S);

        bytes.push(wasmFormat.OP_I32_OR);
        bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
        if (deoptImportIdx >= 0) {
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(deoptReasonForNode(node))),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
        }
        bytes.push(wasmFormat.OP_UNREACHABLE);
        bytes.push(wasmFormat.OP_END);
        break;
      }

      case ir.IR_LOAD_ARRAY_LENGTH: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const arrayLocal = local(node.inputs[0].id);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(arrayLocal),
        );
        bytes.push(
          wasmFormat.OP_I32_LOAD,
          ...wasmFormat.encodeU32(2),
          ...wasmFormat.encodeU32(4),
        );
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_INT32_ADD:
      case ir.IR_INT32_SUB:
      case ir.IR_INT32_MUL:
      case ir.IR_INT32_SHL:
      case ir.IR_INT32_SHR:
      case ir.IR_INT32_AND:
      case ir.IR_INT32_OR:
      case ir.IR_INT32_XOR:
      case ir.IR_INT32_USHR: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;

        const leftType = analysis.nodeWasmType.get(node.inputs[0].id);
        const rightType = analysis.nodeWasmType.get(node.inputs[1].id);
        const outType = analysis.nodeWasmType.get(node.id);

        if (
          INT32_OVERFLOW_CHECK.has(node.type) &&
          !node.props.noOverflow &&
          outType === wasmFormat.TYPE_F64
        ) {
          const F64_FOR_INT32: Record<string, number> = {
            [ir.IR_INT32_ADD]: wasmFormat.OP_F64_ADD,
            [ir.IR_INT32_SUB]: wasmFormat.OP_F64_SUB,
            [ir.IR_INT32_MUL]: wasmFormat.OP_F64_MUL,
          };
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(local(node.inputs[0].id)),
          );
          if (leftType === wasmFormat.TYPE_I32)
            bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(local(node.inputs[1].id)),
          );
          if (rightType === wasmFormat.TYPE_I32)
            bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
          const opcode = F64_FOR_INT32[node.type];
          if (opcode === undefined) break;
          bytes.push(opcode);
        } else if (
          INT32_OVERFLOW_CHECK.has(node.type) &&
          analysis.hasOverflowChecks &&
          deoptImportIdx >= 0 &&
          !node.props.noOverflow
        ) {
          const fsId = node.frameState?.id ?? 0;
          const tmpLocal = analysis.overflowTempLocal;

          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(local(node.inputs[0].id)),
          );
          if (leftType === wasmFormat.TYPE_F64) {
            this.emitCheckedInt64FromF64(bytes, analysis, node.frameState, fsId, deoptImportIdx);
          } else {
            bytes.push(wasmFormat.OP_I64_EXTEND_I32_S);
          }
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(local(node.inputs[1].id)),
          );
          if (rightType === wasmFormat.TYPE_F64) {
            this.emitCheckedInt64FromF64(bytes, analysis, node.frameState, fsId, deoptImportIdx);
          } else {
            bytes.push(wasmFormat.OP_I64_EXTEND_I32_S);
          }
          const opcode = INT64_ARITH_OPCODES[node.type];
          if (opcode === undefined) break;
          bytes.push(opcode);
          bytes.push(
            wasmFormat.OP_LOCAL_TEE,
            ...wasmFormat.encodeU32(tmpLocal),
          );

          bytes.push(
            wasmFormat.OP_I64_CONST,
            ...wasmFormat.encodeS64(2147483647),
          );
          bytes.push(wasmFormat.OP_I64_GT_S);

          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(tmpLocal),
          );
          bytes.push(
            wasmFormat.OP_I64_CONST,
            ...wasmFormat.encodeS64(-2147483648),
          );
          bytes.push(wasmFormat.OP_I64_LT_S);

          bytes.push(wasmFormat.OP_I32_OR);
          bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(DEOPT_OVERFLOW)),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
          bytes.push(wasmFormat.OP_UNREACHABLE);
          bytes.push(wasmFormat.OP_END);

          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(tmpLocal),
          );
          bytes.push(wasmFormat.OP_I32_WRAP_I64);
        } else {
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(local(node.inputs[0].id)),
          );
          if (leftType === wasmFormat.TYPE_F64)
            this.emitToInt32FromF64(bytes, analysis);
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(local(node.inputs[1].id)),
          );
          if (rightType === wasmFormat.TYPE_F64)
            this.emitToInt32FromF64(bytes, analysis);
          const opcode = INT32_ARITH_OPCODES[node.type];
          if (opcode === undefined) break;
          bytes.push(opcode);
        }
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_INT32_NOT: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(local(node.inputs[0].id)),
        );
        if (inputType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(-1));
        bytes.push(wasmFormat.OP_I32_XOR);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_INT32_DIV:
      case ir.IR_INT32_MOD: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const leftType = analysis.nodeWasmType.get(node.inputs[0].id);
        const rightType = analysis.nodeWasmType.get(node.inputs[1].id);
        const rightLocal = local(node.inputs[1].id);

        if (deoptImportIdx >= 0 && node.frameState) {
          const fsId = node.frameState.id ?? 0;
          bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(rightLocal));
          if (rightType === wasmFormat.TYPE_F64)
            this.emitToInt32FromF64(bytes, analysis);
          bytes.push(wasmFormat.OP_I32_EQZ);
          bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(DEOPT_DIVISION_BY_ZERO)),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
          bytes.push(wasmFormat.OP_UNREACHABLE);
          bytes.push(wasmFormat.OP_END);
        }

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(local(node.inputs[0].id)),
        );
        if (leftType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(rightLocal));
        if (rightType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        const opcode = INT32_ARITH_OPCODES[node.type];
        if (opcode === undefined) break;
        bytes.push(opcode);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_FLOAT64_ADD:
      case ir.IR_FLOAT64_SUB:
      case ir.IR_FLOAT64_MUL:
      case ir.IR_FLOAT64_DIV: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const leftLocal = local(node.inputs[0].id);
        const rightLocal = local(node.inputs[1].id);
        const leftType = analysis.nodeWasmType.get(node.inputs[0].id);
        const rightType = analysis.nodeWasmType.get(node.inputs[1].id);

        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(leftLocal));
        if (leftType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(rightLocal),
        );
        if (rightType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        const opcode = FLOAT64_ARITH_OPCODES[node.type];
        if (opcode === undefined) break;
        bytes.push(opcode);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_INT32_COMPARE: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const compareOp = metadataString(node.props.op);
        const op = compareOp ? COMPARE_OPS[compareOp] : undefined;
        if (!op) break;
        const cmpLeftType = analysis.nodeWasmType.get(node.inputs[0].id);
        const cmpRightType = analysis.nodeWasmType.get(node.inputs[1].id);
        const useF64Cmp = cmpLeftType === wasmFormat.TYPE_F64 || cmpRightType === wasmFormat.TYPE_F64;
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(local(node.inputs[0].id)),
        );
        if (useF64Cmp && cmpLeftType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(local(node.inputs[1].id)),
        );
        if (useF64Cmp && cmpRightType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        bytes.push(useF64Cmp ? op.f64 : op.i32);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_FLOAT64_COMPARE: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const compareOp = metadataString(node.props.op);
        const op = compareOp ? COMPARE_OPS[compareOp] : undefined;
        if (!op) break;
        const leftLocal = local(node.inputs[0].id);
        const rightLocal = local(node.inputs[1].id);
        const leftType = analysis.nodeWasmType.get(node.inputs[0].id);
        const rightType = analysis.nodeWasmType.get(node.inputs[1].id);

        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(leftLocal));
        if (leftType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(rightLocal),
        );
        if (rightType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        bytes.push(op.f64);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_LOAD_FIELD: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const objLocal = local(node.inputs[0].id);
        const offset = metadataNumber(node.props.offset);
        if (offset === null) break;
        const memOffset = 8 + offset * 8;
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(objLocal));
        if (analysis.nodeWasmType.get(node.id) === wasmFormat.TYPE_I32) {
          bytes.push(
            wasmFormat.OP_F64_LOAD,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(memOffset),
          );
          this.emitToInt32FromF64(bytes, analysis);
        } else {
          bytes.push(
            wasmFormat.OP_F64_LOAD,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(memOffset),
          );
        }
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_STORE_FIELD: {
        const objLocal = local(node.inputs[0].id);
        const valLocal = local(node.inputs[1].id);
        const offset = metadataNumber(node.props.offset);
        if (offset === null) break;
        const memOffset = 8 + offset * 8;
        const valType = analysis.nodeWasmType.get(node.inputs[1].id);

        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(objLocal));
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(valLocal));
        if (valType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        bytes.push(
          wasmFormat.OP_F64_STORE,
          ...wasmFormat.encodeU32(3),
          ...wasmFormat.encodeU32(memOffset),
        );
        break;
      }

      case ir.IR_POLYMORPHIC_LOAD: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const objLocal = local(node.inputs[0].id);
        const maps = metadataNumberArray(node.props.maps);
        const offsets = metadataNumberArray(node.props.offsets);
        if (!maps || !offsets || maps.length !== offsets.length) break;
        const fsId = node.frameState?.id ?? 0;
        const resultType = analysis.nodeWasmType.get(node.id);

        bytes.push(
          wasmFormat.OP_BLOCK,
          resultType === wasmFormat.TYPE_I32
            ? wasmFormat.TYPE_I32
            : wasmFormat.TYPE_F64,
        );
        for (let i = 0; i < maps.length; i++) {
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(objLocal),
          );
          bytes.push(
            wasmFormat.OP_I32_LOAD,
            ...wasmFormat.encodeU32(2),
            ...wasmFormat.encodeU32(0),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(maps[i]));
          bytes.push(wasmFormat.OP_I32_EQ);
          bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(objLocal),
          );
          bytes.push(
            wasmFormat.OP_F64_LOAD,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(8 + offsets[i] * 8),
          );
          if (resultType === wasmFormat.TYPE_I32)
            this.emitToInt32FromF64(bytes, analysis);
          bytes.push(wasmFormat.OP_BR, ...wasmFormat.encodeU32(1));
          bytes.push(wasmFormat.OP_END);
        }
        if (deoptImportIdx >= 0) {
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(deoptReasonForNode(node))),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
        }
        bytes.push(wasmFormat.OP_UNREACHABLE);
        bytes.push(wasmFormat.OP_END);
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_POLYMORPHIC_STORE: {
        const objLocal = local(node.inputs[0].id);
        const valLocal = local(node.inputs[1].id);
        const valType = analysis.nodeWasmType.get(node.inputs[1].id);
        const maps = metadataNumberArray(node.props.maps);
        const offsets = metadataNumberArray(node.props.offsets);
        if (!maps || !offsets || maps.length !== offsets.length) break;
        const fsId = node.frameState?.id ?? 0;

        bytes.push(wasmFormat.OP_BLOCK, wasmFormat.TYPE_VOID);
        for (let i = 0; i < maps.length; i++) {
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(objLocal),
          );
          bytes.push(
            wasmFormat.OP_I32_LOAD,
            ...wasmFormat.encodeU32(2),
            ...wasmFormat.encodeU32(0),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(maps[i]));
          bytes.push(wasmFormat.OP_I32_EQ);
          bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(objLocal),
          );
          bytes.push(
            wasmFormat.OP_LOCAL_GET,
            ...wasmFormat.encodeU32(valLocal),
          );
          if (valType === wasmFormat.TYPE_I32)
            bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
          bytes.push(
            wasmFormat.OP_F64_STORE,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(8 + offsets[i] * 8),
          );
          bytes.push(wasmFormat.OP_BR, ...wasmFormat.encodeU32(1));
          bytes.push(wasmFormat.OP_END);
        }
        if (deoptImportIdx >= 0) {
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(deoptReasonForNode(node))),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
        }
        bytes.push(wasmFormat.OP_UNREACHABLE);
        bytes.push(wasmFormat.OP_END);
        break;
      }

      

      case ir.IR_LOAD_ELEMENT: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const arrayLocal = local(node.inputs[0].id);
        const indexLocal = local(node.inputs[1].id);
        const indexType = analysis.nodeWasmType.get(node.inputs[1].id);
        const elementType = analysis.nodeWasmType.get(node.id);

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(arrayLocal),
        );
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(16));
        bytes.push(wasmFormat.OP_I32_ADD);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(indexLocal),
        );
        if (indexType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(8));
        bytes.push(wasmFormat.OP_I32_MUL);
        bytes.push(wasmFormat.OP_I32_ADD);
        if (elementType === wasmFormat.TYPE_I32) {
          bytes.push(
            wasmFormat.OP_F64_LOAD,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(0),
          );
          this.emitToInt32FromF64(bytes, analysis);
        } else {
          bytes.push(
            wasmFormat.OP_F64_LOAD,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(0),
          );
        }
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_STORE_ELEMENT: {
        const arrayLocal = local(node.inputs[0].id);
        const indexLocal = local(node.inputs[1].id);
        const indexType = analysis.nodeWasmType.get(node.inputs[1].id);
        const valLocal = local(node.inputs[2].id);
        const valType = analysis.nodeWasmType.get(node.inputs[2].id);

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(arrayLocal),
        );
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(16));
        bytes.push(wasmFormat.OP_I32_ADD);
        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(indexLocal),
        );
        if (indexType === wasmFormat.TYPE_F64)
          this.emitToInt32FromF64(bytes, analysis);
        bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(8));
        bytes.push(wasmFormat.OP_I32_MUL);
        bytes.push(wasmFormat.OP_I32_ADD);

        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(valLocal));
        if (valType === wasmFormat.TYPE_I32)
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);

        bytes.push(
          wasmFormat.OP_F64_STORE,
          ...wasmFormat.encodeU32(3),
          ...wasmFormat.encodeU32(0),
        );
        break;
      }

      case ir.IR_PHI: {
        break;
      }

      case ir.IR_RETURN: {
        if (node.inputs[0]) {
          const inputLocal = local(node.inputs[0].id);
          const inputType = analysis.nodeWasmType.get(node.inputs[0].id);

          if (inputType !== analysis.resultType) {
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(inputLocal),
            );
            if (
              analysis.resultType === wasmFormat.TYPE_F64 &&
              inputType === wasmFormat.TYPE_I32
            ) {
              bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
            } else if (
              analysis.resultType === wasmFormat.TYPE_I32 &&
              inputType === wasmFormat.TYPE_F64
            ) {
              this.emitToInt32FromF64(bytes, analysis);
            }
            bytes.push(wasmFormat.OP_RETURN);
          } else {
            bytes.push(
              wasmFormat.OP_LOCAL_GET,
              ...wasmFormat.encodeU32(inputLocal),
            );
            bytes.push(wasmFormat.OP_RETURN);
          }
        }
        break;
      }

      case ir.IR_DEOPTIMIZE: {
        if (deoptImportIdx >= 0) {
          const fsId = node.frameState?.id ?? 0;
          this.emitDeoptSnapshot(node.frameState, analysis, bytes);
          bytes.push(
            wasmFormat.OP_I32_CONST,
            ...wasmFormat.encodeS32(deoptReasonId(deoptReasonForNode(node))),
          );
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(fsId));
          bytes.push(
            wasmFormat.OP_CALL,
            ...wasmFormat.encodeU32(deoptImportIdx),
          );
        }
        bytes.push(wasmFormat.OP_UNREACHABLE);
        break;
      }

      case ir.IR_BOX: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const inputLocal = local(node.inputs[0].id);
        const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
        const outType = analysis.nodeWasmType.get(node.id);

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(inputLocal),
        );

        if (
          inputType === wasmFormat.TYPE_I32 &&
          outType === wasmFormat.TYPE_F64
        ) {
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        } else if (
          inputType === wasmFormat.TYPE_F64 &&
          outType === wasmFormat.TYPE_I32
        ) {
          this.emitToInt32FromF64(bytes, analysis);
        }
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_UNBOX: {
        const loc = analysis.nodeLocal.get(node.id);
        if (loc === undefined) break;
        const inputLocal = local(node.inputs[0].id);
        const inputType = analysis.nodeWasmType.get(node.inputs[0].id);
        const outType = analysis.nodeWasmType.get(node.id);

        bytes.push(
          wasmFormat.OP_LOCAL_GET,
          ...wasmFormat.encodeU32(inputLocal),
        );
        if (
          inputType === wasmFormat.TYPE_I32 &&
          outType === wasmFormat.TYPE_F64
        ) {
          bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
        } else if (
          inputType === wasmFormat.TYPE_F64 &&
          outType === wasmFormat.TYPE_I32
        ) {
          this.emitToInt32FromF64(bytes, analysis);
        }
        bytes.push(wasmFormat.OP_LOCAL_SET, ...wasmFormat.encodeU32(loc));
        break;
      }

      case ir.IR_JUMP:
      case ir.IR_BRANCH:
      case ir.IR_PARAMETER:
        break;
    }
  }

  needsFieldRuntimeStub(node: AnyNode): boolean {
    if (
      node.type === ir.IR_LOAD_FIELD ||
      node.type === ir.IR_POLYMORPHIC_LOAD
    ) {
      return repForNode(node) === REP_HANDLE;
    }
    if (
      node.type === ir.IR_STORE_FIELD ||
      node.type === ir.IR_POLYMORPHIC_STORE
    ) {
      return true;
    }
    return false;
  }

  compile(
    optimizerResult: SpeculativeCompileResult,
    compiledFn: RegisterCompiledFunction,
  ): OptimizedCode | null {
    const { graph, frameStates } = optimizerResult;

    if (graph.bailout) {
      this.lastAnalysisFailure = graph.bailout;
      return null;
    }

    try {
      validateOptimizedGraph(graph, frameStates || []);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        `Wasm: graph validation failed: ${message}`,
      );
      return null;
    }

    if (!this.canCompile(graph)) {
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        `Wasm: graph not compilable: ${this.lastCompileRejection}`,
      );
      return null;
    }

    const analysis = this.analyzeGraph(graph, compiledFn);
    if (!analysis) {
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        `Wasm: analysis failed: ${this.lastAnalysisFailure || "unknown"}`,
      );
      return null;
    }

    let constPtrBase = 49152;
    for (const constNode of analysis._nonPrimitiveConstants) {
      constNode._constPtrIndex = constPtrBase;
      constPtrBase += 64;
    }

    const builder = new wasmFormat.WasmModuleBuilder();

    let deoptImportIdx = -1;
    let runtimeStubImportIdx = -1;
    let importFuncCount = 0;

    if (analysis.needsDeoptImport) {
      const deoptTypeIdx = builder.addType(
        [wasmFormat.TYPE_I32, wasmFormat.TYPE_I32],
        [],
      );
      deoptImportIdx = builder.addFuncImport("env", "deopt", deoptTypeIdx);
      importFuncCount++;
    }

    if (analysis.needsRuntimeStubImport) {
      const runtimeStubTypeIdx = builder.addType(
        [
          wasmFormat.TYPE_I32,
          wasmFormat.TYPE_I32,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
        ],
        [wasmFormat.TYPE_F64],
      );
      runtimeStubImportIdx = builder.addFuncImport(
        "env",
        "runtimeStub",
        runtimeStubTypeIdx,
      );
      importFuncCount++;
    }

    let allocObjImportIdx = -1;
    if (analysis.needsAllocObjImport) {
      const allocObjTypeIdx = builder.addType(
        [wasmFormat.TYPE_I32],
        [wasmFormat.TYPE_I32],
      );
      allocObjImportIdx = builder.addFuncImport(
        "env",
        "allocObj",
        allocObjTypeIdx,
      );
      importFuncCount++;
    }

    if (analysis.needsMemory) {
      builder.addMemoryImport("env", "memory");
    }

    const funcTypeIdx = builder.addType(analysis.paramTypes, [
      analysis.resultType,
    ]);
    builder.addFunction(funcTypeIdx);

    builder.addExport("opt", importFuncCount);

    if (analysis.hasSelfRecursion) {
      analysis.selfCallFuncIdx = importFuncCount;
    }

    const bodyBytes = this.generateBody(
      graph,
      analysis,
      deoptImportIdx,
      runtimeStubImportIdx,
      allocObjImportIdx,
    );
    builder.setCode(0, analysis.additionalLocals, bodyBytes);

    if (this.lastEmitFailure !== null) {
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        `Wasm: control flow not emittable: ${this.lastEmitFailure}`,
      );
      return null;
    }

    const wasmBytes = builder.toBytes();

    let wasmModule;
    try {
      wasmModule = new WebAssembly.Module(wasmBytes);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        `Wasm validation failed: ${message}`,
      );
      return null;
    }

    const imports: WasmImports = { env: {} };
    let memory: WasmMemory | null = null;

    if (analysis.needsMemory) {
      memory = new WebAssembly.Memory({ initial: 1, maximum: 256 }); 
      imports.env.memory = memory;
    }

    if (analysis.needsDeoptImport) {
      imports.env.deopt = (reasonId: number, frameStateId: number) => {
        const reason = deoptReasonFromId(reasonId);
        const fs = frameStates ? frameStates[frameStateId] : null;
        const bcOffset = fs ? fs.bytecodeOffset : 0;
        const runtimeValues = new Map<number, TaggedValue>();

        if (fs && memory) {
          const buffer = new Float64Array(memory.buffer);
          let offsetIndex = 1;

          const readValue = (val: FrameValue | null | undefined) => {
            const node = frameNode(val);
            if (node) {
              const loc = resolveNodeLocal(node.id, analysis);
              if (loc !== undefined) {
                const type = analysis.nodeWasmType.get(node.id);
                const rawF64 = buffer[offsetIndex];
                const rawInt = Math.trunc(rawF64);
                const objInfo =
                  analysis.nodeValueRep.get(node.id) === REP_HANDLE &&
                  threadLocal.currentObjPtrs
                    ? threadLocal.currentObjPtrs.get(rawInt)
                    : null;
                if (objInfo) {
                  runtimeValues.set(node.id, objInfo.value);
                  offsetIndex++;
                  return;
                }
                if (type === wasmFormat.TYPE_I32) {
                  runtimeValues.set(node.id, mkSmi(rawInt));
                } else if (type === wasmFormat.TYPE_F64) {
                  runtimeValues.set(node.id, mkDouble(rawF64));
                }
              }
            }
            offsetIndex++;
          };

          visitDeoptSnapshotValues(fs, readValue);
        }

        throw new DeoptSignal(
          reason,
          bcOffset,
          [],
          [],
          frameStateId,
          runtimeValues,
        );
      };
    }

    const nodeMap = new Map<number, AnyNode>();
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        nodeMap.set(node.id, node);
      }
    }

    if (analysis.needsRuntimeStubImport) {
      imports.env.runtimeStub = (
        stubId: number,
        frameStateId: number,
        a0: number,
        a1: number,
        a2: number,
        a3: number,
        a4: number,
        a5: number,
        a6: number,
        a7: number,
      ) => {
        const runtime = threadLocal.currentRuntime;
        if (!runtime) throw new Error("runtimeStub: missing runtime");
        const stub = analysis.runtimeStubTable.getById(stubId);
        if (!stub) throw new Error("runtimeStub: invalid stub " + stubId);
        const node = nodeMap.get(stub.nodeId);
        if (!node) throw new Error("runtimeStub: missing node " + stub.nodeId);
        const rawArgs = [a0, a1, a2, a3, a4, a5, a6, a7];
        try {
          return executeRuntimeStub(
            stub,
            node,
            rawArgs,
            analysis,
            runtime,
            compiledFn,
            frameStates,
            frameStateId,
          );
        } catch (e) {
          if (e instanceof DeoptSignal) throw e;
          const fs = frameStates ? frameStates[frameStateId] : null;
          const bcOffset = fs ? fs.bytecodeOffset : stub.bytecodeOffset;
          throw new DeoptSignal(
            DEOPT_RUNTIME_STUB_FAILURE,
            bcOffset,
            [],
            [],
            frameStateId,
            new Map(),
          );
        }
      };
    }

    if (analysis.needsAllocObjImport) {
      const hcCache = new Map<number, { hc: ReturnType<typeof getHiddenClassById>; propCount: number }>();
      imports.env.allocObj = (hcId: number) => {
        const runtime = threadLocal.currentRuntime;
        if (!runtime) throw new Error("allocObj: missing runtime");
        let cached = hcCache.get(hcId);
        if (!cached) {
          const hc = getHiddenClassById(hcId);
          cached = { hc, propCount: hc ? hc.propertyCount || 0 : 0 };
          hcCache.set(hcId, cached);
        }
        const obj = createJSObject(cached.hc || undefined);
        const pc = cached.propCount;
        for (let _i = 0; _i < pc; _i++) obj.slots[_i] = mkUndefined();
        const tagged = mkObject(obj);
        return runtime.allocateTagged(tagged, true);
      };
    }

    let instance;
    try {
      instance = new WebAssembly.Instance(wasmModule, imports);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        `Wasm instantiation failed: ${message}`,
      );
      return null;
    }

    const wasmFn = instance.exports.opt;
    if (!isWasmCallable(wasmFn)) {
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        "Wasm export opt is not callable",
      );
      return null;
    }
    const wasmSize = wasmBytes.length;

    tracer.jitCompile(
      compiledFn.name ?? "<anonymous>",
      `Wasm module compiled: ${wasmSize} bytes, ${graph.blocks.length} blocks`,
    );
    if (
      analysis.runtimeStubTable &&
      analysis.runtimeStubTable.stubs.length > 0
    ) {
      (compiledFn as WasmCompiledFunction).optimizedStubSummary = analysis.runtimeStubTable.stubs;
      tracer.jitCompile(
        compiledFn.name ?? "<anonymous>",
        `Runtime stubs lowered: ${analysis.runtimeStubTable.stubs.length}`,
      );
    } else {
      (compiledFn as WasmCompiledFunction).optimizedStubSummary = [];
    }

    return this.createWrapper(
      wasmFn,
      analysis,
      compiledFn,
      frameStates,
      memory,
    );
  }

  createWrapper(
    wasmFn: (...args: number[]) => number,
    analysis: AnyAnalysis,
    compiledFn: WasmCompiledFunction,
    frameStates: FrameState[],
    memory: WasmMemory | null,
  ): OptimizedCode {
    const { paramTypes, resultType, entryGuards, needsMemory, resultValueRep } =
      analysis;

    const hasStubs = !!(
      analysis.runtimeStubTable &&
      analysis.runtimeStubTable.stubs &&
      analysis.runtimeStubTable.stubs.length > 0
    );
    const needsRuntimeObj = hasStubs || analysis.needsAllocObjImport;

    const failingEntryGuard = (args: TaggedValue[]): AnyNode | null => {
      for (const guard of entryGuards) {
        const input = guard.inputs[0];
        if (!input || input.type !== ir.IR_PARAMETER) continue;
        const paramIdx = metadataNumber(input.props.index);
        if (paramIdx === null) continue;
        const arg = paramIdx < args.length ? args[paramIdx] : mkUndefined();
        if (guard.type === ir.IR_CHECK_SMI && !isSmi(arg)) return guard;
        if (guard.type === ir.IR_CHECK_NUMBER && !isNumber(arg)) return guard;
      }
      return null;
    };

    const optimizedCode = function optimizedCode(
      args: TaggedValue[],
      thisValue: TaggedValue,
      rawInterpreter: object,
    ) {
      const interpreter = requireWasmInterpreter(rawInterpreter);
      const recordWasmDeopt = (reason: string, bytecodeOffset: number) => {
        compiledFn.deoptCount = (compiledFn.deoptCount || 0) + 1;
        compiledFn.lastDeoptReason = reason;
        dependencyRegistry.unregister(compiledFn);
        compiledFn.optimizedCode = null;
        tracer.jitDeopt(compiledFn.name ?? "<anonymous>", reason, bytecodeOffset);

        const policy = interpreter && interpreter.tieringPolicy;
        if (policy && typeof policy.recordDeopt === "function") {
          policy.recordDeopt(compiledFn, reason);
        }

        const maxDeoptCount = policy?.maxDeoptCount ?? 3;
        if (compiledFn.deoptCount >= maxDeoptCount) {
          compiledFn.disableOptimization = true;
        }
      };

      if (analysis.globalCellOffsets) {
        for (const name of analysis.globalCellOffsets.keys()) {
          const cell = interpreter.globalCells.get(name);
          const cellValue = cell ? cell.read() : mkUndefined();
          if (isNumber(cellValue)) continue;
          recordWasmDeopt(DEOPT_NUMBER_CHECK_FAILED, 0);
          return interpreter.resumeAt(
            new RegisterFrame(compiledFn, args, thisValue),
          );
        }
      }

      const failedGuard = failingEntryGuard(args);
      if (failedGuard) {
        const reason = deoptReasonForNode(failedGuard);
        recordWasmDeopt(reason, 0);

        const frameState = failedGuard.frameState;
        if (!frameState) {
          const frame = new RegisterFrame(compiledFn, args, thisValue);
          return interpreter.resumeAt(frame);
        }
        if (frameState.isInlinedFrame) {
          return resumeFrameStateChain(
            args,
            thisValue,
            frameState,
            new Map(),
            interpreter,
          );
        }
        if (frameState.bytecodeOffset !== 0) {
          const frame = new RegisterFrame(compiledFn, args, thisValue);
          return interpreter.resumeAt(frame);
        }
        const frame = materializeFrameFromState(
          frameState.compiledFunction || compiledFn,
          args,
          thisValue,
          frameState,
          new Map(),
          interpreter,
        );
        return interpreter.resumeAt(frame);
      }

      const objPtrs: Map<number, ObjectPointerInfo> = new Map();
      const ptrByIdentity: Map<HeapPayload, number> = new Map();
      let nextObjPtr = 1024;

      const takeObjPtr = () => {
        if (analysis.hasInlineAlloc && memory) {
          const inlinePtr = new DataView(memory.buffer).getInt32(0, true);
          if (inlinePtr > nextObjPtr) nextObjPtr = inlinePtr;
        }
        return nextObjPtr;
      };

      const releaseObjPtr = (end: number) => {
        nextObjPtr = end;
        if (analysis.hasInlineAlloc && memory) {
          new DataView(memory.buffer).setInt32(0, end, true);
        }
      };

      releaseObjPtr(nextObjPtr);

      const ensureMemory = (needed: number) => {
        if (!memory) return;
        const currentSize = memory.buffer.byteLength;
        if (needed > currentSize) {
          const pagesToGrow = Math.ceil((needed - currentSize) / 65536);
          try {
            memory.grow(pagesToGrow);
          } catch (e) {
          }
        }
      };

      const allocateTagged = (tagged: TaggedValue, skipSlotSerialization = false, maxSlots = -1) => {
        const array = isArray(tagged);
        const object = isObject(tagged);
        if (!skipSlotSerialization && (array || object) && memory) {
          const raw = getPayload(tagged) as JSObject | JSArray;
          const cachedPtr = ptrByIdentity.get(raw);
          if (cachedPtr !== undefined) {
            const cached = objPtrs.get(cachedPtr);
            const slots = array
              ? (raw as JSArray).elements.length
              : (raw as JSObject).slots.length;
            if (cached && slots <= (cached.capacity ?? 0)) {
              const from = array ? (cached.serializedCount ?? 0) : 0;
              serializeObject(raw, memory, cachedPtr, allocateTagged, maxSlots, from);
              cached.serializedCount = array ? slots : undefined;
              cached.serializedSlots =
                object && maxSlots >= 0 ? Math.min(slots, maxSlots) : -1;
              return cachedPtr;
            }
            objPtrs.delete(cachedPtr);
            ptrByIdentity.delete(raw);
          }
        }

        const ptr = takeObjPtr();
        if (array) {
          const raw = getPayload(tagged);
          const slots = raw.elements.length;
          const capacity = skipSlotSerialization ? slots : Math.max(slots * 2, 4);
          const newEnd = ptr + Math.max(16 + capacity * 8, 8);
          ensureMemory(newEnd);
          releaseObjPtr(newEnd);
          objPtrs.set(ptr, {
            ptr, obj: raw, value: tagged, serializedSlots: -1, capacity,
            serializedCount: skipSlotSerialization ? 0 : slots,
          });
          if (!skipSlotSerialization) ptrByIdentity.set(raw, ptr);
          if (skipSlotSerialization && memory) {
            const view = new DataView(memory.buffer);
            view.setInt32(ptr, -1, true);
            view.setInt32(ptr + 4, slots, true);
          } else if (memory) {
            serializeObject(raw, memory, ptr, allocateTagged, maxSlots);
          }
          return ptr;
        }
        if (object) {
          const raw = getPayload(tagged);
          const slots = raw.slots.length;
          const newEnd = ptr + Math.max(8 + slots * 8, 8);
          ensureMemory(newEnd);
          releaseObjPtr(newEnd);
          const serializedSlots = maxSlots >= 0 ? Math.min(slots, maxSlots) : -1;
          objPtrs.set(ptr, { ptr, obj: raw, value: tagged, serializedSlots, capacity: slots });
          if (!skipSlotSerialization) ptrByIdentity.set(raw, ptr);
          if (skipSlotSerialization && memory) {
            const view = new DataView(memory.buffer);
            view.setInt32(ptr, raw.hiddenClass ? raw.hiddenClass.id : 0, true);
            view.setInt32(ptr + 4, slots, true);
          } else if (memory) {
            serializeObject(raw, memory, ptr, allocateTagged, maxSlots);
          }
          return ptr;
        }
        const raw = getPayload(tagged);
        const newEnd = ptr + 8;
        ensureMemory(newEnd);
        releaseObjPtr(newEnd);
        objPtrs.set(ptr, { ptr, obj: raw, value: tagged });
        return ptr;
      };

      if (analysis._nonPrimitiveConstants) {
        for (const constNode of analysis._nonPrimitiveConstants) {
          const ptr = constNode._constPtrIndex;
          if (ptr !== undefined) {
            const v =
              constNode.props.value !== undefined
                ? constNode.props.value
                : constNode.props.index;
            let tagged: TaggedValue;
            if (v === null) tagged = mkNull();
            else if (typeof v === "string") tagged = mkString(v);
            else if (typeof v === "function")
              tagged = mkFunction({
                call: (callArgs: TaggedValue[], callThis?: TaggedValue) => {
                  const result = v(callArgs, callThis ?? mkUndefined());
                  return typeof result === "number" && isTaggedValue(result)
                    ? result
                    : mkUndefined();
                },
              });
            else {
              const compiledConst = compiledFunctionMetadata(v);
              if (compiledConst) tagged = mkFunction(new JSFunction(compiledConst, compiledConst.name ?? undefined));
              else if (typeof v === "number" && isTaggedValue(v))
              tagged = v;
              else if (constNode.props.isThis) tagged = thisValue;
              else tagged = mkUndefined();
            }
            objPtrs.set(ptr, { ptr, obj: getPayload(tagged), value: tagged });
          }
        }
      }

      const rawArgs: number[] = [];
      for (let i = 0; i < paramTypes.length; i++) {
        const arg = i < args.length ? args[i] : mkUndefined();
        const paramValueRep = analysis.paramValueReps?.[i] || null;
        const passAsTaggedHandle = needsMemory && paramValueRep === REP_HANDLE;
        const fieldExtent = analysis.paramFieldExtents
          ? analysis.paramFieldExtents[i] ?? -1
          : -1;
        if (paramTypes[i] === wasmFormat.TYPE_I32) {
          if (passAsTaggedHandle) {
            rawArgs.push(allocateTagged(arg, false, fieldExtent));
          } else if (isSmi(arg)) {
            rawArgs.push(getPayload(arg));
          } else if (isDouble(arg)) {
            rawArgs.push(getPayload(arg) | 0);
          } else if (isBool(arg)) {
            rawArgs.push(getPayload(arg) ? 1 : 0);
          } else {
            rawArgs.push(0);
          }
        } else {
          if (passAsTaggedHandle) {
            rawArgs.push(allocateTagged(arg, false, fieldExtent));
          } else {
            rawArgs.push(isSmi(arg) || isDouble(arg) ? getPayload(arg) : 0);
          }
        }
      }

      const commitTrackedObject = (info: ObjectPointerInfo) => {
        const payload = serializablePayload(info.value);
        if (!payload || !memory) return;
        deserializeObject(payload, memory, info.ptr, info.serializedSlots ?? -1);
      };

      const commitTrackedObjects = () => {
        if (!needsMemory || !memory) return;
        for (const info of objPtrs.values()) commitTrackedObject(info);
      };

      let rawResult = 0;
      const prevObjPtrs = threadLocal.currentObjPtrs;
      const prevRuntime = threadLocal.currentRuntime;
      threadLocal.currentObjPtrs = objPtrs;
      threadLocal.currentRuntime = !needsRuntimeObj ? prevRuntime : {
        objPtrs,
        memory,
        interpreter,
        compiledFn,
        thisValue: (thisValue === undefined ? mkUndefined() : thisValue),
        allocateTagged,
        getTagged(ptr: number) {
          const p = Math.trunc(ptr);
          const info = objPtrs.get(p);
          if (info) {
            if (analysis.mutatesHeapObjects) commitTrackedObject(info);
            return info.value;
          }
          if (analysis.hasInlineAlloc && !memory) return mkNumber(ptr);
          if (analysis.hasInlineAlloc && p >= 1024 && p < takeObjPtr()) {
            if (!memory) return mkNumber(ptr);
            const dv = new DataView(memory.buffer);
            const hcId = dv.getInt32(p, true);
            const slotCnt = dv.getInt32(p + 4, true);
            const hc = getHiddenClassById(hcId);
            const obj = createJSObject(hc || undefined);
            for (let si = 0; si < slotCnt; si++) {
              const sv = dv.getFloat64(p + 8 + si * 8, true);
              obj.slots[si] =
                Number.isInteger(sv) && sv >= -2147483648 && sv <= 2147483647
                  ? mkSmi(sv)
                  : mkNumber(sv);
            }
            const tagged = mkObject(obj);
            objPtrs.set(p, { ptr: p, obj, value: tagged });
            return tagged;
          }
          return mkNumber(ptr);
        },
        syncTagged(ptr: number) {
          const p = Math.trunc(ptr);
          let info = objPtrs.get(p);
          if (!info && analysis.hasInlineAlloc && p >= 1024) {
            this.getTagged?.(ptr);
            info = objPtrs.get(p);
          }
          const payload = info ? serializablePayload(info.value) : null;
          if (info && memory && payload) {
            if (isArray(info.value)) {
              const len = (getPayload(info.value) as JSArray).elements.length;
              const from = len >= (info.serializedCount ?? 0) ? info.serializedCount ?? 0 : 0;
              serializeObject(payload, memory, info.ptr, allocateTagged, -1, from);
              info.serializedCount = len;
            } else {
              serializeObject(payload, memory, info.ptr);
            }
          }
        },
      };

      releaseObjPtr(nextObjPtr);


      compiledFn.invocationCount = (compiledFn.invocationCount || 0) + 1;
      compiledFn.lastExecutionTime = Date.now();

      
      if (++wasmCallDepth > MAX_WASM_CALL_DEPTH) {
        wasmCallDepth--;
        threadLocal.currentObjPtrs = prevObjPtrs;
        threadLocal.currentRuntime = prevRuntime;
        throw new RangeError("Maximum call stack size exceeded");
      }

      if (analysis.globalCellOffsets && memory) {
        const gcEnd = 32768 + analysis.globalCellOffsets.size * 8;
        ensureMemory(gcEnd);
        const dv = new DataView(memory.buffer);
        for (const [name, offset] of analysis.globalCellOffsets) {
          const cell = interpreter.globalCells.get(name);
          const val = cell ? cell.read() : mkUndefined();
          const raw = isNumber(val) ? toNumber(val) : 0;
          dv.setFloat64(offset, raw, true);
        }
      }

      try {
        rawResult = wasmFn(...rawArgs);
      } catch (e) {
        wasmCallDepth--;
        threadLocal.currentObjPtrs = prevObjPtrs;
        threadLocal.currentRuntime = prevRuntime;
        if (e instanceof DeoptSignal) {
          commitTrackedObjects();

          if (analysis.globalCellOffsets && memory) {
            const dv = new DataView(memory.buffer);
            for (const [name, offset] of analysis.globalCellOffsets) {
              const raw = dv.getFloat64(offset, true);
              interpreter.globalCells.write(name, mkNumber(raw));
            }
          }

          recordWasmDeopt(e.reason, e.bytecodeOffset);

          
          if (e.runtimeValues && e.runtimeValues.size > 0) {
            for (const [nodeId, val] of e.runtimeValues) {
              if (
                typeof val === "number" &&
                analysis.nodeValueRep.get(nodeId) === REP_HANDLE
              ) {
                const ptrInfo = objPtrs.get(val);
                if (ptrInfo && ptrInfo.value) {
                  e.runtimeValues.set(nodeId, ptrInfo.value);
                }
              }
            }
          }

          const frameState = frameStates ? frameStates[e.frameStateId] : null;
          if (frameState?.isInlinedFrame) {
            return resumeFrameStateChain(
              args,
              thisValue,
              frameState,
              e.runtimeValues || new Map<number, TaggedValue>(),
              interpreter,
            );
          }
          const frame = materializeFrameFromState(
            frameState?.compiledFunction || compiledFn,
            args,
            thisValue,
            frameState,
            e.runtimeValues || new Map<number, TaggedValue>(),
            interpreter,
          );
          return interpreter.resumeAt(frame);
        }
        throw e;
      }

      wasmCallDepth--;
      threadLocal.currentObjPtrs = prevObjPtrs;
      threadLocal.currentRuntime = prevRuntime;

      if (analysis.globalCellOffsets && memory) {
        const dv = new DataView(memory.buffer);
        for (const [name, offset] of analysis.globalCellOffsets) {
          const raw = dv.getFloat64(offset, true);
          interpreter.globalCells.write(name, mkNumber(raw));
        }
      }

      takeObjPtr();

      const returnedHandle =
        resultValueRep === REP_HANDLE
          ? objPtrs.get(Math.trunc(rawResult))
          : undefined;

      if (analysis.mutatesHeapObjects) {
        commitTrackedObjects();
      } else if (needsMemory && memory && returnedHandle) {
        commitTrackedObject(returnedHandle);
      }

      if (returnedHandle) {
        return returnedHandle.value;
      }

      if (resultValueRep === REP_HANDLE) {
        const ptr = Math.trunc(rawResult);
        if (ptr >= 1024 && ptr < nextObjPtr) {
          if (!memory) return mkNumber(rawResult);
          const dv = new DataView(memory.buffer);
          const hcId = dv.getInt32(ptr, true);
          const slotCnt = dv.getInt32(ptr + 4, true);
          const hc = getHiddenClassById(hcId);
          const obj = createJSObject(hc || undefined);
          for (let si = 0; si < slotCnt; si++) {
            obj.slots[si] = mkNumber(dv.getFloat64(ptr + 8 + si * 8, true));
          }
          return mkObject(obj);
        }
        return mkNumber(rawResult);
      }

      if (resultValueRep === REP_BOOL) {
        return mkBool(rawResult !== 0);
      }

      if (resultType === wasmFormat.TYPE_I32) {
        return mkSmi(rawResult);
      } else {
        return mkNumber(rawResult);
      }
    };

    
    optimizedCode._dispose = () => {
      memory = null;
    };

    if (analysis.isOsr) {
      optimizedCode._declinesEntry = (args: TaggedValue[]) =>
        failingEntryGuard(args) !== null;
    }

    return optimizedCode;
  }
}
