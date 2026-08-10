import * as ir from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import { UnionFind } from "../infra/union-find.js";
import type { Partition } from "./heap-model.js";
import { metadataNumber } from "../ir/metadata.js";

type Value = ir.CFGInstruction;

type ClassInfo = {
  readonly root: Value;
  readonly members: Value[];
  readonly allocSites: Set<number>;
  readonly mapIds: Set<number>;
  readonly globalNames: Set<string>;
  readonly partition: Partition;
  readonly escaped: boolean;
};

const ALLOCATIONS = new Set([
  ir.IR_NEW_OBJECT,
  ir.IR_NEW_ARRAY,
  ir.IR_NEW_REGEX,
  ir.IR_MAKE_CLOSURE,
]);
const CALLS = new Set([
  ir.IR_GENERIC_CALL,
  ir.IR_MAKE_CLOSURE,
  ir.IR_CALL_BUILTIN,
  ir.IR_CALL_INTRINSIC,
  ir.IR_CALL_KNOWN_FUNCTION,
]);
const EXTERNAL_VALUES = new Set([
  ir.IR_PARAMETER,
  ir.IR_LOAD_FIELD,
  ir.IR_LOAD_ELEMENT,
  ir.IR_LOAD_ARRAY_LENGTH,
  ir.IR_GENERIC_GET_PROP,
  ir.IR_GENERIC_GET_INDEX,
  ir.IR_LOAD_GLOBAL,
  ir.IR_LOAD_CONTEXT_SLOT,
  ir.IR_POLYMORPHIC_LOAD,
  ir.IR_MEGAMORPHIC_LOAD,
  ir.IR_DISPATCH_MAP,
  ir.IR_GENERIC_CALL,
  ir.IR_CALL_BUILTIN,
  ir.IR_CALL_INTRINSIC,
  ir.IR_CALL_KNOWN_FUNCTION,
]);
const NON_POINTER_VALUES = new Set([
  ir.IR_CONSTANT,
  ir.IR_INT32_ADD,
  ir.IR_INT32_SUB,
  ir.IR_INT32_MUL,
  ir.IR_INT32_DIV,
  ir.IR_INT32_MOD,
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_SUB,
  ir.IR_FLOAT64_MUL,
  ir.IR_FLOAT64_DIV,
  ir.IR_INT32_COMPARE,
  ir.IR_FLOAT64_COMPARE,
  ir.IR_TYPEOF,
  ir.IR_NOT,
  ir.IR_NEG,
  ir.IR_INT32_SHL,
  ir.IR_INT32_SHR,
  ir.IR_INT32_USHR,
  ir.IR_INT32_AND,
  ir.IR_INT32_OR,
  ir.IR_INT32_XOR,
  ir.IR_INT32_NOT,
  ir.IR_FLOAT64_POW,
  ir.IR_GENERIC_ADD,
  ir.IR_GENERIC_SUB,
  ir.IR_GENERIC_MUL,
  ir.IR_GENERIC_DIV,
  ir.IR_GENERIC_MOD,
  ir.IR_GENERIC_COMPARE,
  ir.IR_GENERIC_DELETE_PROP,
  ir.IR_GENERIC_BITAND,
  ir.IR_GENERIC_BITOR,
  ir.IR_GENERIC_BITXOR,
  ir.IR_GENERIC_SHL,
  ir.IR_GENERIC_SHR,
  ir.IR_GENERIC_USHR,
  ir.IR_GENERIC_POW,
  ir.IR_GENERIC_BITNOT,
  ir.IR_GENERIC_INSTANCEOF,
  ir.IR_GENERIC_IN,
]);
const STORE_VALUE_INDEX = new Map<string, number>([
  [ir.IR_STORE_FIELD, 1],
  [ir.IR_STORE_ELEMENT, 2],
  [ir.IR_GENERIC_SET_PROP, 1],
  [ir.IR_GENERIC_SET_INDEX, 2],
  [ir.IR_STORE_GLOBAL, 0],
  [ir.IR_STORE_CONTEXT_SLOT, 0],
]);
const STORE_BASE_INDEX = new Map<string, number>([
  [ir.IR_STORE_FIELD, 0],
  [ir.IR_STORE_ELEMENT, 0],
  [ir.IR_GENERIC_SET_PROP, 0],
  [ir.IR_GENERIC_SET_INDEX, 0],
]);

const INPUT_ESCAPE_EFFECTS = new Set([
  ...CALLS,
  ir.IR_GENERIC_DELETE_PROP,
]);

export interface PointsToResult {
  partitionOf(value: Value): Partition;
  mayAlias(a: Value, b: Value): boolean;
  escapes(value: Value): boolean;
  allocClassOf(value: Value): number | null;
  virtualAllocations(): number[];
}

export const pointsToAnalysisId = analysisId<PointsToResult>("points-to");

export const pointsToAnalysis: AnalysisPass<ir.CFGFunction, PointsToResult> = {
  id: pointsToAnalysisId,
  run(graph) {
    return analyzePointsTo(graph);
  },
};

function analyzePointsTo(graph: ir.CFGFunction): PointsToResult {
  const values = collectValues(graph);
  const uf = new UnionFind<Value>();
  for (const value of values) uf.makeSet(value);

  for (const value of values) {
    if (value.type === ir.IR_PHI) {
      for (const input of value.inputs) uf.union(value, input);
      continue;
    }
    if (ir.forwardsPointerIdentity(value.type) && value.inputs[0]) {
      uf.union(value, value.inputs[0]);
    }
  }

  const membersByRoot = new Map<Value, Value[]>();
  for (const value of values) {
    const root = uf.find(value);
    let members = membersByRoot.get(root);
    if (!members) {
      members = [];
      membersByRoot.set(root, members);
    }
    members.push(value);
  }

  const infoByRoot = new Map<Value, ClassInfo>();
  for (const [root, members] of membersByRoot) {
    const allocSites = new Set<number>();
    const mapIds = new Set<number>();
    const globalNames = new Set<string>();
    for (const member of members) {
      if (ALLOCATIONS.has(member.type)) allocSites.add(member.id);
      if (member.type === ir.IR_CHECK_MAP) {
        const mapId = metadataNumber(member.props.expectedMapId);
        if (mapId !== null) mapIds.add(mapId);
      } else if (member.type === ir.IR_CHECK_ARRAY) {
        mapIds.add(-1);
      }
      if (member.type === ir.IR_LOAD_GLOBAL && typeof member.props.name === "string") {
        globalNames.add(member.props.name);
      }
    }
    const partition = classifyPartition(members, allocSites, mapIds, globalNames);
    infoByRoot.set(root, {
      root,
      members,
      allocSites,
      mapIds,
      globalNames,
      partition,
      escaped: false,
    });
  }

  const escapedRoots = collectEscapedRoots(values, uf, infoByRoot);

  for (const [root, info] of [...infoByRoot]) {
    infoByRoot.set(root, {
      ...info,
      escaped: escapedRoots.has(root),
    });
  }

  const infoOf = (value: Value): ClassInfo | null => infoByRoot.get(uf.find(value)) ?? null;

  return {
    partitionOf: (value) => infoOf(value)?.partition ?? { kind: "any" },
    mayAlias: (left, right) => mayAlias(infoOf(left), infoOf(right), uf, left, right),
    escapes: (value) => infoOf(value)?.escaped ?? false,
    allocClassOf: (value) => {
      const info = infoOf(value);
      if (!info) return null;
      return info.allocSites.size === 1 ? [...info.allocSites][0]! : null;
    },
    virtualAllocations: () => {
      const out: number[] = [];
      for (const info of infoByRoot.values()) {
        if (info.partition.kind !== "alloc" || info.escaped) continue;
        out.push(info.partition.site);
      }
      return out;
    },
  };
}

function collectValues(graph: ir.CFGFunction): Value[] {
  const values: Value[] = [...graph.parameters];
  for (const block of graph.blocks) values.push(...block.nodes);
  return values;
}

function classifyPartition(
  members: readonly Value[],
  allocSites: ReadonlySet<number>,
  mapIds: ReadonlySet<number>,
  globalNames: ReadonlySet<string>,
): Partition {
  const hasExternal = members.some((member) => EXTERNAL_VALUES.has(member.type));
  const hasNonPointer = members.some((member) => NON_POINTER_VALUES.has(member.type));
  if (allocSites.size === 1 && !hasExternal && !hasNonPointer) {
    return { kind: "alloc", site: [...allocSites][0]! };
  }
  if (mapIds.size === 1) return { kind: "shape", mapId: [...mapIds][0]! };
  if (
    globalNames.size === 1 &&
    members.every((member) => member.type === ir.IR_LOAD_GLOBAL)
  ) {
    return { kind: "global", name: [...globalNames][0]! };
  }
  return { kind: "any" };
}

function collectEscapedRoots(
  values: readonly Value[],
  uf: UnionFind<Value>,
  infoByRoot: ReadonlyMap<Value, ClassInfo>,
): Set<Value> {
  const escaped = new Set<Value>();
  const worklist: Value[] = [];
  const containment = new Map<Value, Value[]>();
  const mark = (value: Value): void => {
    const root = uf.find(value);
    const info = infoByRoot.get(root);
    if (!info || info.allocSites.size === 0 || escaped.has(root)) return;
    escaped.add(root);
    worklist.push(root);
  };
  const addEdge = (container: Value, stored: Value): void => {
    const root = uf.find(container);
    let targets = containment.get(root);
    if (!targets) {
      targets = [];
      containment.set(root, targets);
    }
    targets.push(stored);
  };

  for (const value of values) {
    if (value.type === ir.IR_NEW_ARRAY) {
      for (const input of value.inputs) addEdge(value, input);
    }
    if (value.type === ir.IR_RETURN) {
      for (const input of value.inputs) mark(input);
      continue;
    }
    if (INPUT_ESCAPE_EFFECTS.has(value.type) && !ir.isEffectFree(value) && !ir.isReadOnly(value)) {
      for (const input of value.inputs) mark(input);
      continue;
    }
    const storedIndex = STORE_VALUE_INDEX.get(value.type);
    if (storedIndex === undefined) continue;
    const stored = value.inputs[storedIndex];
    if (!stored) continue;
    const baseIndex = STORE_BASE_INDEX.get(value.type);
    const base = baseIndex === undefined ? undefined : value.inputs[baseIndex];
    if (base) addEdge(base, stored);
    if (base && uf.sameSet(base, stored)) continue;
    mark(stored);
  }
  for (const [root, info] of infoByRoot) {
    if (info.allocSites.size > 0 && info.partition.kind !== "alloc" && !escaped.has(root)) {
      escaped.add(root);
      worklist.push(root);
    }
  }
  for (let cursor = 0; cursor < worklist.length; cursor++) {
    const root = worklist[cursor]!;
    for (const stored of containment.get(root) ?? []) mark(stored);
  }
  return escaped;
}

function mayAlias(
  leftInfo: ClassInfo | null,
  rightInfo: ClassInfo | null,
  uf: UnionFind<Value>,
  left: Value,
  right: Value,
): boolean {
  if (uf.sameSet(left, right)) return true;
  if (!leftInfo || !rightInfo) return true;
  const leftPartition = leftInfo.partition;
  const rightPartition = rightInfo.partition;
  if (
    leftPartition.kind === "alloc" &&
    rightPartition.kind === "alloc" &&
    leftPartition.site !== rightPartition.site
  ) {
    return false;
  }
  if (
    leftPartition.kind === "shape" &&
    rightPartition.kind === "shape" &&
    leftPartition.mapId !== rightPartition.mapId
  ) {
    return false;
  }
  if (leftPartition.kind === "alloc" && !leftInfo.escaped) return false;
  if (rightPartition.kind === "alloc" && !rightInfo.escaped) return false;
  if (
    leftPartition.kind === "global" &&
    rightPartition.kind === "global" &&
    leftPartition.name !== rightPartition.name
  ) {
    return false;
  }
  return true;
}
