const YOUNG_GEN_SEMI_SPACE_SIZE = 1 << 19;

export class HeapRegion<T = RuntimeValue> {
  size: number;
  storage: Array<T | undefined>;
  allocPointer: number;
  highWater: number;

  constructor(size = YOUNG_GEN_SEMI_SPACE_SIZE) {
    this.size = size;
    this.storage = new Array<T | undefined>(size);
    this.allocPointer = 0;
    this.highWater = 0;
  }

  allocate(obj: T): number | null {
    if (this.allocPointer >= this.size) {
      return null;
    }
    const index = this.allocPointer++;
    this.storage[index] = obj;
    if (this.allocPointer > this.highWater) this.highWater = this.allocPointer;
    return index;
  }

  get(index: number): T | undefined {
    return this.storage[index];
  }

  set(index: number, obj: T): void {
    this.storage[index] = obj;
    if (index + 1 > this.highWater) this.highWater = index + 1;
  }

  reset(): void {
    this.storage.fill(undefined, 0, this.highWater);
    this.allocPointer = 0;
    this.highWater = 0;
  }

  isFull(): boolean {
    return this.allocPointer >= this.size;
  }

  usedSlots(): number {
    return this.allocPointer;
  }

  forEach(callback: (obj: T, index: number) => void): void {
    for (let i = 0; i < this.allocPointer; i++) {
      const value = this.storage[i];
      if (value !== undefined) {
        callback(value, i);
      }
    }
  }
}

export { YOUNG_GEN_SEMI_SPACE_SIZE };
