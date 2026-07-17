const OLD_GEN_INITIAL_CAPACITY = 1 << 14;
const PAGE_SIZE = 1024;
const EVACUATION_THRESHOLD = 0.5;

export class FreeList {
  slots: number[];

  constructor() {
    this.slots = [];
  }

  add(slot: number): void {
    this.slots.push(slot);
  }

  take(): number | null {
    return this.slots.length > 0 ? this.slots.pop()! : null;
  }

  clear(): void {
    this.slots.length = 0;
  }

  get totalFree(): number {
    return this.slots.length;
  }
}

export class OldGeneration {
  capacity: number;
  storage: Array<OldGenerationObject | undefined>;
  allocPointer: number;
  freeList: FreeList;
  liveCount: number;
  _prevLiveCount: number;

  constructor(capacity = OLD_GEN_INITIAL_CAPACITY) {
    this.capacity = capacity;
    this.storage = new Array<OldGenerationObject | undefined>(capacity);
    this.allocPointer = 0;
    this.freeList = new FreeList();
    this.liveCount = 0;
    this._prevLiveCount = 0;
  }

  allocate(obj: OldGenerationObject): number {
    const freeSlot = this.freeList.take();
    if (freeSlot !== null) {
      this.storage[freeSlot] = obj;
      obj.gcHeader.oldGenIndex = freeSlot;
      this.liveCount++;
      return freeSlot;
    }

    if (this.allocPointer >= this.capacity) {
      this._grow();
    }

    const index = this.allocPointer++;
    this.storage[index] = obj;
    obj.gcHeader.oldGenIndex = index;
    this.liveCount++;
    return index;
  }

  markCompact(markSet: Set<OldGenerationObject>): { swept: number; evacuated: number } {
    let swept = 0;
    const pageCount = Math.ceil(this.allocPointer / PAGE_SIZE);

    const pageLive = new Uint32Array(pageCount);
    const pageTotal = new Uint32Array(pageCount);

    for (let i = 0; i < this.allocPointer; i++) {
      const obj = this.storage[i];
      if (obj === undefined) continue;
      const page = (i / PAGE_SIZE) | 0;
      pageTotal[page]++;
      if (markSet.has(obj)) {
        pageLive[page]++;
      }
    }

    const evacuationCandidates = new Set<number>();
    for (let p = 0; p < pageCount; p++) {
      if (pageTotal[p] > 0 && pageLive[p] / pageTotal[p] < EVACUATION_THRESHOLD) {
        evacuationCandidates.add(p);
      }
    }

    const evacuees: OldGenerationObject[] = [];
    for (let i = 0; i < this.allocPointer; i++) {
      const obj = this.storage[i];
      if (obj === undefined) continue;

      if (!markSet.has(obj)) {
        this.storage[i] = undefined;
        this.liveCount--;
        swept++;
        continue;
      }

      obj.gcHeader.marked = false;

      const page = (i / PAGE_SIZE) | 0;
      if (evacuationCandidates.has(page)) {
        evacuees.push(obj);
        this.storage[i] = undefined;
      }
    }

    this._rebuildFreeList();

    let moved = 0;
    for (const obj of evacuees) {
      const slot = this.freeList.take();
      if (slot !== null) {
        this.storage[slot] = obj;
        obj.gcHeader.oldGenIndex = slot;
      } else {
        if (this.allocPointer >= this.capacity) this._grow();
        const index = this.allocPointer++;
        this.storage[index] = obj;
        obj.gcHeader.oldGenIndex = index;
      }
      moved++;
    }

    if (moved > 0) {
      this._rebuildFreeList();
    }

    this._prevLiveCount = this.liveCount;
    return { swept, evacuated: moved };
  }

  markSweep(markSet: Set<OldGenerationObject>): number {
    const { swept } = this.markCompact(markSet);
    return swept;
  }

  compact(): number {
    const fragmentation =
      this.freeList.totalFree / Math.max(this.allocPointer, 1);
    if (fragmentation < 0.3) return 0;

    const live: OldGenerationObject[] = [];
    for (let i = 0; i < this.allocPointer; i++) {
      const value = this.storage[i];
      if (value !== undefined) {
        live.push(value);
      }
    }
    this.storage.fill(undefined, 0, this.allocPointer);
    this.freeList.clear();
    this.allocPointer = 0;
    for (const obj of live) {
      const index = this.allocPointer++;
      this.storage[index] = obj;
      obj.gcHeader.oldGenIndex = index;
    }
    return live.length;
  }

  growthRate(): number {
    if (this._prevLiveCount === 0) return 0;
    return (this.liveCount - this._prevLiveCount) / this._prevLiveCount;
  }

  forEach(callback: (obj: OldGenerationObject, index: number) => void): void {
    for (let i = 0; i < this.allocPointer; i++) {
      if (this.storage[i] !== undefined) {
        callback(this.storage[i]!, i);
      }
    }
  }

  _rebuildFreeList(): void {
    this.freeList.clear();
    for (let i = 0; i < this.allocPointer; i++) {
      if (this.storage[i] === undefined) {
        this.freeList.add(i);
      }
    }
  }

  _grow(): void {
    const newCapacity = this.capacity * 2;
    const newStorage = new Array<OldGenerationObject | undefined>(newCapacity);
    for (let i = 0; i < this.capacity; i++) {
      newStorage[i] = this.storage[i];
    }
    this.storage = newStorage;
    this.capacity = newCapacity;
  }
}

export type OldGenerationObject = {
  gcHeader: {
    oldGenIndex?: number;
    marked?: boolean;
  };
};

export { OLD_GEN_INITIAL_CAPACITY };
