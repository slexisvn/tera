import { getPayload, getHeapId } from "../core/value/index.js";
import type { HeapPayload, TaggedValue } from "../core/value/index.js";
import type { GCObject } from "./incremental-marker.js";
import type { RegisterValue } from "../bytecode/register/interpreter/frame.js";
import type { RegisterConstant } from "../bytecode/register/ops/bytecode.js";
import type { GlobalCell, GlobalCellMap } from "../runtime/intrinsics/global-cells.js";
import type { Microtask, MicrotaskQueue } from "../runtime/microtasks/microtask.js";

type UpvalueLike = { get(): RegisterValue | null };
type RootSlotValue = RegisterValue | TaggedValue | GCObject | string | boolean | symbol | null | undefined;
type FrameLike = {
  registers?: RootSlotValue[];
  locals?: RootSlotValue[];
  stack?: RootSlotValue[];
  acc?: TaggedValue;
  closureEnv?: { cells?: UpvalueLike[] } | null;
  openUpvalues?: Map<number, UpvalueLike> | null;
  compiledFn?: { constants?: RegisterConstant[] };
};
type InterpreterLike = { activeFrames?: FrameLike[] };
type CellLike = Pick<GlobalCell, "value" | "read">;
type CellCollection = Map<string, CellLike> | Iterable<[string, CellLike]>;
type GlobalCellsLike = Pick<GlobalCellMap, "cells"> | CellCollection;
type MicrotaskRootRecord = Microtask | {
    value?: TaggedValue;
    result?: TaggedValue;
    argument?: TaggedValue;
    promise?: PayloadLike | TaggedValue;
};
type MicrotaskQueueLike = {
  queue: Array<MicrotaskRootRecord | null | undefined>;
};
type PayloadLike = GCObject & {
  __heapId?: number;
  slots?: TaggedValue[];
  elements?: TaggedValue[];
  overflowProperties?: Map<string, TaggedValue>;
  symbolProperties?: Map<HeapPayload, TaggedValue>;
  _primitiveValue?: TaggedValue;
  _mapData?: { iterateEntries(): Iterable<[TaggedValue, TaggedValue]> };
  _setData?: { iterateValues(): Iterable<TaggedValue> };
  closure?: { cells?: UpvalueLike[] };
  properties?: Record<string, TaggedValue>;
  compiled?: { constants?: RegisterConstant[] };
  prototype?: PayloadLike;
  prototypeObj?: PayloadLike;
  frame?: FrameLike;
};

function isIterableCellCollection(value: CellCollection | null | undefined): value is Iterable<[string, CellLike]> {
  return !!value && typeof value[Symbol.iterator] === "function";
}

function getCellsCollection(globalCells: GlobalCellsLike): CellCollection {
  return "cells" in globalCells ? globalCells.cells : globalCells;
}







export function markReachableHeapIds(
  interpreter?: InterpreterLike | null,
  globalCells?: GlobalCellsLike | null,
  microtaskQueue?: MicrotaskQueueLike | null,
): Set<number> {
  const live = new Set<number>();
  const seenPayloads = new Set<object>();
  const work: PayloadLike[] = [];

  const seedTagged = (v: RootSlotValue): void => {
    if (v === undefined || typeof v !== "number") return;
    const id = getHeapId(v);
    if (id > 0) live.add(id);
    const p = getPayload(v as TaggedValue) as PayloadLike | null | undefined;
    if (p && typeof p === "object" && !seenPayloads.has(p)) {
      seenPayloads.add(p);
      work.push(p);
    }
  };
  const seedMaybeRegister = (v: RegisterValue | null | undefined): void => {
    if (v !== null) seedTagged(v);
  };
  const seedRaw = (p: PayloadLike | object | null | undefined): void => {
    if (p && typeof p === "object" && !seenPayloads.has(p)) {
      const payload = p as PayloadLike;
      seenPayloads.add(payload);
      work.push(payload);
      if (typeof payload.__heapId === "number" && payload.__heapId > 0) live.add(payload.__heapId);
    }
  };

  if (interpreter && interpreter.activeFrames) {
    for (const frame of interpreter.activeFrames) {
      const regs = frame.registers || frame.locals;
      if (regs) for (let i = 0; i < regs.length; i++) seedTagged(regs[i]);
      if (frame.acc !== undefined) seedTagged(frame.acc);
      const env = frame.closureEnv;
      if (env && env.cells) {
        for (const cell of env.cells) {
          if (cell && typeof cell.get === "function") seedMaybeRegister(cell.get());
        }
      }
      if (frame.openUpvalues) {
        for (const cell of frame.openUpvalues.values()) {
          if (cell && typeof cell.get === "function") seedMaybeRegister(cell.get());
        }
      }
    }
  }

  if (globalCells) {
    const cellsMap = getCellsCollection(globalCells);
    if (cellsMap instanceof Map || isIterableCellCollection(cellsMap)) {
      for (const [, cell] of cellsMap) {
        if (cell && typeof cell.read === "function") seedTagged(cell.read());
        else if (cell && cell.value !== undefined) seedTagged(cell.value);
      }
    }
  }

  if (microtaskQueue && microtaskQueue.queue) {
    for (const task of microtaskQueue.queue) {
      if (!task) continue;
      if ("value" in task && task.value !== undefined) seedTagged(task.value);
      if ("result" in task && task.result !== undefined) seedTagged(task.result);
      if ("argument" in task && task.argument !== undefined) seedTagged(task.argument);
      if ("promise" in task) {
        if (typeof task.promise === "number") seedTagged(task.promise);
        else if (task.promise) seedRaw(task.promise);
      }
    }
  }

  while (work.length > 0) {
    const p = work.pop()!;
    if (Array.isArray(p.slots)) {
      for (const s of p.slots) if (s !== undefined) seedTagged(s);
    }
    if (Array.isArray(p.elements)) {
      for (const el of p.elements) if (el !== undefined) seedTagged(el);
    }
    if (p.overflowProperties instanceof Map) {
      for (const val of p.overflowProperties.values()) seedTagged(val);
    }
    if (p.symbolProperties instanceof Map) {
      for (const val of p.symbolProperties.values()) seedTagged(val);
    }
    if (p._primitiveValue !== undefined) seedTagged(p._primitiveValue);
    if (p._mapData && typeof p._mapData.iterateEntries === "function") {
      for (const [k, val] of p._mapData.iterateEntries()) { seedTagged(k); seedTagged(val); }
    }
    if (p._setData && typeof p._setData.iterateValues === "function") {
      for (const k of p._setData.iterateValues()) seedTagged(k);
    }
    
    
    if (p.closure && Array.isArray(p.closure.cells)) {
      for (const cell of p.closure.cells) {
        if (cell && typeof cell.get === "function") seedMaybeRegister(cell.get());
      }
    }
    if (p.properties && typeof p.properties === "object") {
      for (const key in p.properties) seedTagged(p.properties[key]);
    }
    if (p.compiled && Array.isArray(p.compiled.constants)) {
      for (const c of p.compiled.constants) {
        if (typeof c === "number") seedTagged(c);
        else if (c && typeof c === "object") seedRaw(c);
      }
    }
    if (p.prototype) seedRaw(p.prototype);
    if (p.prototypeObj) seedRaw(p.prototypeObj);
    
    const susp = p.frame;
    if (susp && (Array.isArray(susp.registers) || Array.isArray(susp.locals))) {
      const regs = susp.registers || susp.locals || [];
      for (let i = 0; i < regs.length; i++) seedTagged(regs[i]);
      if (susp.acc !== undefined) seedTagged(susp.acc);
      const env = susp.closureEnv;
      if (env && Array.isArray(env.cells)) {
        for (const cell of env.cells) {
          if (cell && typeof cell.get === "function") seedMaybeRegister(cell.get());
        }
      }
    }
  }

  return live;
}

export function enumerateRoots(
  interpreter?: InterpreterLike | null,
  globalCells?: GlobalCellsLike | null,
  microtaskQueue?: MicrotaskQueueLike | null,
): GCObject[] {
  const roots: GCObject[] = [];

  if (interpreter && interpreter.activeFrames) {
    for (const frame of interpreter.activeFrames) {
      if (frame.locals) {
        for (const local of frame.locals) {
          const obj = extractHeapObject(local);
          if (obj) roots.push(obj);
        }
      }
      if (frame.stack) {
        for (const val of frame.stack) {
          const obj = extractHeapObject(val);
          if (obj) roots.push(obj);
        }
      }
    }
  }

  if (globalCells) {
    const cellsMap = getCellsCollection(globalCells);
    if (
      cellsMap instanceof Map ||
      isIterableCellCollection(cellsMap)
    ) {
      for (const [, cell] of cellsMap) {
        const val = cell && typeof cell.read === "function" ? cell.read() : cell.value;
        const obj = extractHeapObject(val);
        if (obj) roots.push(obj);
      }
    }
  }

  if (microtaskQueue && microtaskQueue.queue) {
    for (const task of microtaskQueue.queue) {
      if (task && "promise" in task && task.promise && typeof task.promise === "object" && task.promise.gcHeader) {
        roots.push(task.promise);
      }
    }
  }

  return roots;
}

export function collectLiveHeapIds(
  interpreter?: InterpreterLike | null,
  globalCells?: GlobalCellsLike | null,
): Set<number> {
  const liveIds = new Set<number>();

  const trackValue = (v: TaggedValue): void => {
    const id = getHeapId(v);
    if (id > 0) liveIds.add(id);
  };

  if (interpreter && interpreter.activeFrames) {
    for (const frame of interpreter.activeFrames) {
      if (frame.locals) {
        for (const local of frame.locals) {
          if (typeof local === "number") trackValue(local);
        }
      }
      if (frame.stack) {
        for (const val of frame.stack) {
          if (typeof val === "number") trackValue(val);
        }
      }
      if (frame.compiledFn && frame.compiledFn.constants) {
        for (const c of frame.compiledFn.constants) {
          if (typeof c === "number") trackValue(c);
        }
      }
    }
  }

  if (globalCells) {
    const cellsMap = getCellsCollection(globalCells);
    if (
      cellsMap instanceof Map ||
      isIterableCellCollection(cellsMap)
    ) {
      for (const [, cell] of cellsMap) {
        const val = cell && typeof cell.read === "function" ? cell.read() : cell.value;
        if (val !== undefined) trackValue(val);
      }
    }
  }

  return liveIds;
}

function extractHeapObject(tagged: RootSlotValue): GCObject | null {
  if (tagged && typeof tagged === "object" && (tagged as GCObject).gcHeader)
    return tagged as GCObject;
  if (typeof tagged !== "number") return null;
  const payload = getPayload(tagged);
  if (payload && typeof payload === "object" && (payload as GCObject).gcHeader)
    return payload as GCObject;
  return null;
}

export { extractHeapObject };
