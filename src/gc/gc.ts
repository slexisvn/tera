import { HeapRegion } from "./heap-region.js";
import { OldGeneration } from "./old-generation.js";
import { RememberedSet } from "./remembered-set.js";
import { enumerateRoots, collectLiveHeapIds } from "./roots.js";
import { sweepHeapPayloads, freeHeapObjectSlot } from "../core/value/index.js";
import type { HeapPayload } from "../core/value/index.js";
import { tracer } from "../core/tracing/index.js";
import type { OldGenerationObject } from "./old-generation.js";
import {
  IncrementalMarker,
  COLOR_WHITE,
  type MarkColor,
} from "./incremental-marker.js";
import type { MicrotaskQueue } from "../runtime/microtasks/microtask.js";
import type { GlobalCellMap } from "../runtime/intrinsics/global-cells.js";
import type { RegisterFrame } from "../bytecode/register/interpreter/frame.js";

const TENURE_THRESHOLD = 2;
const MAJOR_GC_RATIO = 0.75;
const MAJOR_GC_GROWTH_FACTOR = 1.5;
const DEFAULT_ALLOCATION_BUDGET = 4096;
const PRETENURE_SIZE_THRESHOLD = 512;
const MIN_ALLOCATION_BUDGET = 1024;
const MAX_ALLOCATION_BUDGET = 65536;
const DEFAULT_TARGET_PAUSE_MS = 2;

type Generation = "young" | "old";

interface GCHeader {
  age: number;
  marked: boolean;
  forwarding: ManagedObject | null;
  generation: Generation;
  youngIndex: number;
  oldGenIndex: number;
  color: MarkColor;
}

type ManagedObject = Extract<HeapPayload, object> & {
  gcHeader?: GCHeader;
  visitReferences?: (visitor: (ref: ManagedObject | null | undefined) => void) => void;
};

interface GCOptions {
  youngGenSize?: number;
  oldGenCapacity?: number;
  allocationBudget?: number;
  targetPauseMs?: number;
}

interface GCRoots {
  activeFrames?: RegisterFrame[];
}

function hasGCHeader(
  obj: ManagedObject | null | undefined,
): obj is ManagedObject & OldGenerationObject & { gcHeader: GCHeader } {
  return !!obj?.gcHeader;
}

export interface GCStats {
  minorGCCount: number;
  majorGCCount: number;
  totalPromoted: number;
  totalCollected: number;
  totalAllocated: number;
}

export class GenerationalGC {
  fromSpace: HeapRegion<ManagedObject>;
  toSpace: HeapRegion<ManagedObject>;
  oldGen: OldGeneration;
  rememberedSet: RememberedSet<ManagedObject>;
  interpreter: GCRoots | null;
  globalCells: GlobalCellMap | null;
  microtaskQueue: MicrotaskQueue | null;
  stats: GCStats;
  incrementalMarker: IncrementalMarker;
  _allocationBudget: number;
  _allocationsSinceGC: number;
  _majorGCThreshold: number;
  _targetPauseMs: number;
  _incrementalMajorGCActive: boolean;

  constructor(options: GCOptions = {}) {
    this.fromSpace = new HeapRegion<ManagedObject>(options.youngGenSize);
    this.toSpace = new HeapRegion<ManagedObject>(options.youngGenSize);
    this.oldGen = new OldGeneration(options.oldGenCapacity);
    this.rememberedSet = new RememberedSet<ManagedObject>();

    this.interpreter = null;
    this.globalCells = null;
    this.microtaskQueue = null;

    this._allocationBudget = options.allocationBudget || DEFAULT_ALLOCATION_BUDGET;
    this._allocationsSinceGC = 0;
    this._majorGCThreshold = 0;
    this._targetPauseMs = options.targetPauseMs || DEFAULT_TARGET_PAUSE_MS;

    this.stats = {
      minorGCCount: 0,
      majorGCCount: 0,
      totalPromoted: 0,
      totalCollected: 0,
      totalAllocated: 0,
    };

    this.incrementalMarker = new IncrementalMarker();
    this._incrementalMajorGCActive = false;
  }

  _roots(): ManagedObject[] {
    return enumerateRoots(
      this.interpreter,
      this.globalCells,
      this.microtaskQueue,
    ) as ManagedObject[];
  }

  bindRoots(
    interpreter: GCRoots | null,
    globalCells: GlobalCellMap | null,
    microtaskQueue: MicrotaskQueue | null,
  ): void {
    this.interpreter = interpreter;
    this.globalCells = globalCells;
    this.microtaskQueue = microtaskQueue;
  }

  allocate<T extends ManagedObject>(obj: T, pretenure = false): T {
    if (!obj.gcHeader) {
      obj.gcHeader = {
        age: 0,
        marked: false,
        forwarding: null,
        generation: "young",
        youngIndex: -1,
        oldGenIndex: -1,
        color: COLOR_WHITE,
      };
    }

    if (pretenure) {
      this._allocateOld(obj);
      this.stats.totalAllocated++;
      return obj;
    }

    const index = this.fromSpace.allocate(obj);
    if (index === null) {
      this.minorGC();
      const retryIndex = this.fromSpace.allocate(obj);
      if (retryIndex === null) {
        this._allocateOld(obj);
        return obj;
      }
      obj.gcHeader.youngIndex = retryIndex;
    } else {
      obj.gcHeader.youngIndex = index;
    }

    obj.gcHeader.generation = "young";
    this.stats.totalAllocated++;
    this._allocationsSinceGC++;
    return obj;
  }

  needsCollection(): boolean {
    return this._allocationsSinceGC >= this._allocationBudget || this.fromSpace.isFull();
  }

  checkSafepoint(): void {
    if (this._incrementalMajorGCActive) {
      this.incrementalMarkingStep();
    }
    if (this.needsCollection()) {
      this.minorGC();
    }
  }

  minorGC(): void {
    tracer.log(
      "GC",
      `Scavenge start — young gen: ${this.fromSpace.usedSlots()} objects`,
    );
    const startTime = performance.now();

    const temp = this.fromSpace;
    this.fromSpace = this.toSpace;
    this.toSpace = temp;
    this.fromSpace.reset();

    const roots = this._roots();
    let promoted = 0;
    let copied = 0;
    const visited = new Set<ManagedObject>();

    const processRef = (obj: ManagedObject | null | undefined): void => {
      if (!obj || !obj.gcHeader || visited.has(obj)) return;
      if (obj.gcHeader.generation !== "young") return;
      visited.add(obj);

      obj.gcHeader.age++;

      if (obj.gcHeader.age >= TENURE_THRESHOLD) {
        this._promote(obj);
        promoted++;
      } else {
        const newIndex = this.fromSpace.allocate(obj);
        if (newIndex === null) {
          this._promote(obj);
          promoted++;
        } else {
          obj.gcHeader.youngIndex = newIndex;
          copied++;
        }
      }

      if (obj.visitReferences) {
        obj.visitReferences(processRef);
      }
    };

    for (const root of roots) {
      processRef(root);
    }

    const processedHolders = new Set();
    this.rememberedSet.iterateHolders((holder) => {
      if (!hasGCHeader(holder) || processedHolders.has(holder)) return;
      if (holder.gcHeader.generation !== "old") return;
      processedHolders.add(holder);
      if (holder.visitReferences) {
        holder.visitReferences(processRef);
      }
    });

    this.toSpace.forEach((obj) => {
      if (obj && !visited.has(obj)) {
        freeHeapObjectSlot(obj);
      }
    });

    this.toSpace.reset();

    this.rememberedSet.clear();

    this.stats.minorGCCount++;
    this.stats.totalPromoted += promoted;
    this._allocationsSinceGC = 0;

    const elapsedMs = performance.now() - startTime;
    const elapsed = elapsedMs.toFixed(2);
    tracer.log(
      "GC",
      `Scavenge end — copied: ${copied}, promoted: ${promoted}, time: ${elapsed}ms`,
    );

    if (elapsedMs > this._targetPauseMs) {
      this._allocationBudget = Math.max(
        MIN_ALLOCATION_BUDGET,
        this._allocationBudget >>> 1,
      );
    } else if (elapsedMs < this._targetPauseMs / 2) {
      this._allocationBudget = Math.min(
        MAX_ALLOCATION_BUDGET,
        (this._allocationBudget * 3) >>> 1,
      );
    }

    this._checkMajorGCTrigger();
  }

  majorGC(): void {
    tracer.log(
      "GC",
      `Mark-Compact start — old gen: ${this.oldGen.liveCount} objects`,
    );
    const startTime = performance.now();

    const markSet = new Set<OldGenerationObject>();
    const worklist: ManagedObject[] = [];

    const roots = this._roots();
    for (const root of roots) {
      if (hasGCHeader(root)) {
        markSet.add(root);
        worklist.push(root);
      }
    }

    this.fromSpace.forEach((obj) => {
      if (hasGCHeader(obj)) {
        markSet.add(obj);
        worklist.push(obj);
      }
    });

    while (worklist.length > 0) {
      const obj = worklist.pop()!;
      if (!obj.visitReferences) continue;
      obj.visitReferences((ref: ManagedObject | null | undefined) => {
        if (hasGCHeader(ref) && !markSet.has(ref)) {
          markSet.add(ref);
          worklist.push(ref);
        }
      });
    }

    const { swept, evacuated } = this.oldGen.markCompact(markSet);
    this.stats.majorGCCount++;
    this.stats.totalCollected += swept;

    this.rememberedSet.clear();
    this._rebuildRememberedSetFromOldGen();

    const liveIds = collectLiveHeapIds(this.interpreter, this.globalCells);
    const heapFreed = sweepHeapPayloads(liveIds);

    this._majorGCThreshold = Math.max(
      this.oldGen.liveCount * MAJOR_GC_GROWTH_FACTOR,
      this.oldGen.capacity * MAJOR_GC_RATIO,
    );

    const elapsed = (performance.now() - startTime).toFixed(2);
    tracer.log(
      "GC",
      `Mark-Compact end — swept: ${swept}, evacuated: ${evacuated}, heapFreed: ${heapFreed}, time: ${elapsed}ms`,
    );
  }

  collectGarbage(type: "minor" | "major" | "full" = "minor"): void {
    if (type === "major" || type === "full") {
      this.minorGC();
      this.majorGC();
    } else {
      this.minorGC();
    }
  }

  startIncrementalMajorGC(): void {
    if (this._incrementalMajorGCActive) return;
    tracer.log(
      "GC",
      `Incremental Mark-Compact start — old gen: ${this.oldGen.liveCount} objects`,
    );
    this._incrementalMajorGCActive = true;

    this.oldGen.forEach((oldObj) => {
      const obj = oldObj as ManagedObject;
      if (hasGCHeader(obj)) obj.gcHeader.color = COLOR_WHITE;
    });
    this.fromSpace.forEach((obj) => {
      if (hasGCHeader(obj)) obj.gcHeader.color = COLOR_WHITE;
    });

    const roots = this._roots();
    this.fromSpace.forEach((obj) => {
      if (hasGCHeader(obj)) roots.push(obj);
    });

    this.incrementalMarker.startMarking(roots);
  }

  incrementalMarkingStep(budget?: number): boolean {
    if (!this._incrementalMajorGCActive) return false;
    const moreWork = this.incrementalMarker.step(budget);
    if (!moreWork) {
      this.finishIncrementalMajorGC();
      return false;
    }
    return true;
  }

  finishIncrementalMajorGC(): void {
    if (!this._incrementalMajorGCActive) return;

    this.incrementalMarker.finishMarking();

    const markSet = new Set<OldGenerationObject>();
    this.oldGen.forEach((oldObj) => {
      const obj = oldObj as ManagedObject;
      if (hasGCHeader(obj) && obj.gcHeader.color !== COLOR_WHITE) {
        markSet.add(obj);
      }
    });
    this.fromSpace.forEach((obj) => {
      if (hasGCHeader(obj) && obj.gcHeader.color !== COLOR_WHITE) {
        markSet.add(obj);
      }
    });

    const { swept, evacuated } = this.oldGen.markCompact(markSet);
    this.stats.majorGCCount++;
    this.stats.totalCollected += swept;

    this.rememberedSet.clear();
    this._rebuildRememberedSetFromOldGen();

    const liveIds = collectLiveHeapIds(this.interpreter, this.globalCells);
    const heapFreed = sweepHeapPayloads(liveIds);

    this._majorGCThreshold = Math.max(
      this.oldGen.liveCount * MAJOR_GC_GROWTH_FACTOR,
      this.oldGen.capacity * MAJOR_GC_RATIO,
    );

    tracer.log(
      "GC",
      `Incremental Mark-Compact end — marked: ${this.incrementalMarker.totalMarked}, steps: ${this.incrementalMarker.stepsRun}, swept: ${swept}, evacuated: ${evacuated}, heapFreed: ${heapFreed}`,
    );

    this.incrementalMarker.reset();
    this._incrementalMajorGCActive = false;
  }

  incrementalWriteBarrier(
    holder: ManagedObject | null | undefined,
    newRef?: ManagedObject | null,
    oldRef?: ManagedObject | null,
  ): void {
    this.incrementalMarker.writeBarrier(holder, newRef, oldRef);
  }

  isIncrementalMarkingActive(): boolean {
    return this._incrementalMajorGCActive;
  }

  isInYoungGen(obj: ManagedObject | null | undefined): boolean {
    return !!(obj && obj.gcHeader && obj.gcHeader.generation === "young");
  }

  isInOldGen(obj: ManagedObject | null | undefined): boolean {
    return !!(obj && obj.gcHeader && obj.gcHeader.generation === "old");
  }

  getStats(): GCStats & {
    youngGenUsed: number;
    oldGenLive: number;
    oldGenCapacity: number;
    rememberedSetSize: number;
    allocationBudget: number;
    allocationsSinceGC: number;
  } {
    return {
      ...this.stats,
      youngGenUsed: this.fromSpace.usedSlots(),
      oldGenLive: this.oldGen.liveCount,
      oldGenCapacity: this.oldGen.capacity,
      rememberedSetSize: this.rememberedSet.size,
      allocationBudget: this._allocationBudget,
      allocationsSinceGC: this._allocationsSinceGC,
    };
  }

  _promote(obj: ManagedObject): void {
    if (!hasGCHeader(obj)) return;
    obj.gcHeader.generation = "old";
    this.oldGen.allocate(obj);
  }

  _allocateOld(obj: ManagedObject): void {
    if (!hasGCHeader(obj)) return;
    obj.gcHeader.generation = "old";
    obj.gcHeader.age = TENURE_THRESHOLD;
    this.oldGen.allocate(obj);
  }

  _checkMajorGCTrigger(): void {
    const threshold = this._majorGCThreshold > 0
      ? this._majorGCThreshold
      : this.oldGen.capacity * MAJOR_GC_RATIO;

    if (this.oldGen.liveCount > threshold) {
      if (!this._incrementalMajorGCActive) {
        this.startIncrementalMajorGC();
      }
    }
  }

  _rebuildRememberedSetFromOldGen(): void {
    this.oldGen.forEach((oldObj) => {
      const obj = oldObj as ManagedObject;
      if (!obj.visitReferences) return;
      let hasYoungRef = false;
      obj.visitReferences((ref: ManagedObject | null | undefined) => {
        if (ref && ref.gcHeader && ref.gcHeader.generation === "young") {
          hasYoungRef = true;
        }
      });
      if (hasYoungRef) {
        this.rememberedSet.record(obj);
      }
    });
  }
}
