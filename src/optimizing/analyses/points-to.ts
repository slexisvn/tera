import * as ir from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import type { Partition } from "./heap-model.js";
import { metadataNumber } from "../ir/metadata.js";

type Value = ir.CFGInstruction;

const UNKNOWN_SITE = -1;
const ARRAY_MAP_ID = -1;

const CALLS = new Set([
  ir.IR_GENERIC_CALL,
  ir.IR_MAKE_CLOSURE,
  ir.IR_CALL_BUILTIN,
  ir.IR_CALL_INTRINSIC,
  ir.IR_CALL_KNOWN_FUNCTION,
]);
const NON_POINTER_VALUES = new Set([
  ir.IR_CONSTANT,
  ...ir.TYPED_ARITHMETIC_OPS,
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
  ir.IR_GENERIC_DELETE_PROP,
  ...ir.GENERIC_VALUE_OPS,
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

const INPUT_ESCAPE_EFFECTS = new Set([...CALLS, ir.IR_GENERIC_DELETE_PROP]);

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

interface Flow {
  readonly targets: Set<number>;
  readonly shapes: Set<number>;
}

function collectValues(graph: ir.CFGFunction): Value[] {
  const values: Value[] = [...graph.parameters];
  for (const block of graph.blocks) {
    values.push(...block.phis);
    values.push(...block.nodes);
  }
  return values;
}

function copiedFrom(value: Value): readonly Value[] {
  if (value.type === ir.IR_PHI) return value.inputs;
  if (ir.forwardsPointerIdentity(value.type) && value.inputs[0]) return [value.inputs[0]];
  return [];
}

function shapeStampOf(value: Value): number | null {
  if (value.type === ir.IR_CHECK_ARRAY) return ARRAY_MAP_ID;
  if (value.type !== ir.IR_CHECK_MAP) return null;
  return metadataNumber(value.props.expectedMapId);
}

function seed(values: readonly Value[]): Map<Value, Flow> {
  const flow = new Map<Value, Flow>();
  for (const value of values) {
    const targets = new Set<number>();
    const shapes = new Set<number>();
    const stamped = shapeStampOf(value);
    if (stamped !== null) shapes.add(stamped);
    const holdsNothing = NON_POINTER_VALUES.has(value.type);
    if (ir.isAllocationSite(value.type)) targets.add(value.id);
    else if (!holdsNothing && copiedFrom(value).length === 0) targets.add(UNKNOWN_SITE);
    flow.set(value, { targets, shapes });
  }
  return flow;
}

function propagate(values: readonly Value[], flow: Map<Value, Flow>): void {
  const readers = new Map<Value, Value[]>();
  for (const value of values) {
    for (const source of copiedFrom(value)) {
      const bucket = readers.get(source);
      if (bucket === undefined) readers.set(source, [value]);
      else bucket.push(value);
    }
  }

  const pending: Value[] = [...values];
  const queued = new Set<Value>(values);
  while (pending.length > 0) {
    const value = pending.pop()!;
    queued.delete(value);
    const held = flow.get(value)!;
    for (const reader of readers.get(value) ?? []) {
      const into = flow.get(reader)!;
      let widened = false;
      for (const site of held.targets) {
        if (into.targets.has(site)) continue;
        into.targets.add(site);
        widened = true;
      }
      for (const shape of held.shapes) {
        if (into.shapes.has(shape)) continue;
        into.shapes.add(shape);
        widened = true;
      }
      if (!widened || queued.has(reader)) continue;
      queued.add(reader);
      pending.push(reader);
    }
  }
}

function sitesOf(flow: ReadonlyMap<Value, Flow>, value: Value): ReadonlySet<number> {
  return flow.get(value)?.targets ?? new Set([UNKNOWN_SITE]);
}

function escapedSitesOf(
  values: readonly Value[],
  flow: ReadonlyMap<Value, Flow>,
): Set<number> {
  const escaped = new Set<number>();
  const pending: number[] = [];
  const containment = new Map<number, Value[]>();

  const mark = (value: Value): void => {
    for (const site of sitesOf(flow, value)) {
      if (site === UNKNOWN_SITE || escaped.has(site)) continue;
      escaped.add(site);
      pending.push(site);
    }
  };
  const contains = (container: Value, stored: Value): void => {
    for (const site of sitesOf(flow, container)) {
      if (site === UNKNOWN_SITE) continue;
      const bucket = containment.get(site);
      if (bucket === undefined) containment.set(site, [stored]);
      else bucket.push(stored);
    }
  };

  for (const value of values) {
    if (value.type === ir.IR_NEW_ARRAY) {
      for (const input of value.inputs) contains(value, input);
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
    if (base === undefined) {
      mark(stored);
      continue;
    }
    contains(base, stored);
    if (base !== stored) mark(stored);
  }

  for (const value of values) {
    const held = sitesOf(flow, value);
    if (held.size === 1 && !held.has(UNKNOWN_SITE)) continue;
    mark(value);
  }

  for (let cursor = 0; cursor < pending.length; cursor++) {
    for (const stored of containment.get(pending[cursor]!) ?? []) mark(stored);
  }
  return escaped;
}

function analyzePointsTo(graph: ir.CFGFunction): PointsToResult {
  const values = collectValues(graph);
  const flow = seed(values);
  propagate(values, flow);
  const escaped = escapedSitesOf(values, flow);
  const allocations = new Set(
    values.filter((value) => ir.isAllocationSite(value.type)).map((value) => value.id),
  );

  const keptApart = (value: Value, reached: ReadonlySet<number>): boolean => {
    const site = onlySite(value);
    return site !== null && !escaped.has(site) && !reached.has(site);
  };

  const onlySite = (value: Value): number | null => {
    const sites = sitesOf(flow, value);
    if (sites.size !== 1) return null;
    const site = [...sites][0]!;
    return site === UNKNOWN_SITE || !allocations.has(site) ? null : site;
  };

  const partitionOf = (value: Value): Partition => {
    const site = onlySite(value);
    if (site !== null) return { kind: "alloc", site };
    const shapes = flow.get(value)?.shapes ?? new Set<number>();
    if (shapes.size === 1) return { kind: "shape", mapId: [...shapes][0]! };
    if (value.type === ir.IR_LOAD_GLOBAL && typeof value.props.name === "string") {
      return { kind: "global", name: value.props.name };
    }
    return { kind: "any" };
  };

  return {
    partitionOf,
    mayAlias: (left, right) => {
      if (left === right) return true;
      const held = sitesOf(flow, left);
      const other = sitesOf(flow, right);
      if (!held.has(UNKNOWN_SITE) && !other.has(UNKNOWN_SITE)) {
        for (const site of held) {
          if (other.has(site)) return true;
        }
        return false;
      }
      if (keptApart(left, other) || keptApart(right, held)) return false;
      if (shapedApart(flow, left, right)) return false;
      return globalsMayAlias(left, right);
    },
    escapes: (value) => {
      for (const site of sitesOf(flow, value)) {
        if (site !== UNKNOWN_SITE && escaped.has(site)) return true;
        if (site === UNKNOWN_SITE) return true;
      }
      return false;
    },
    allocClassOf: (value) => onlySite(value),
    virtualAllocations: () => [...allocations].filter((site) => !escaped.has(site)),
  };
}

function shapedApart(flow: ReadonlyMap<Value, Flow>, left: Value, right: Value): boolean {
  const held = flow.get(left)?.shapes;
  const other = flow.get(right)?.shapes;
  if (held === undefined || other === undefined) return false;
  if (held.size !== 1 || other.size !== 1) return false;
  return [...held][0] !== [...other][0];
}

function globalsMayAlias(left: Value, right: Value): boolean {
  if (left.type !== ir.IR_LOAD_GLOBAL || right.type !== ir.IR_LOAD_GLOBAL) return true;
  const held = left.props.name;
  const other = right.props.name;
  if (typeof held !== "string" || typeof other !== "string") return true;
  return held === other;
}
