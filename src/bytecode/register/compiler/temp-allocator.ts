type TempAllocatingFunction = {
  registerCount: number;
  allocTemp(): number;
};

export class TempAllocator {
  func: TempAllocatingFunction;
  freeTemps: number[];

  constructor(func: TempAllocatingFunction) {
    this.func = func;
    this.freeTemps = [];
  }

  alloc(): number {
    if (this.freeTemps.length > 0) {
      return this.freeTemps.pop()!;
    }
    return this.func.allocTemp();
  }

  allocContiguous(count: number): number {
    const base = this.func.registerCount;
    this.func.registerCount += count;
    return base;
  }

  free(reg: number): void {
    this.freeTemps.push(reg);
  }
}
