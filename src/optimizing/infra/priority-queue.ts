export type Ordering<T> = (left: T, right: T) => number;

export class PriorityQueue<T> {
  private readonly items: T[] = [];

  constructor(
    private readonly before: Ordering<T>,
    initial: Iterable<T> = [],
  ) {
    for (const item of initial) this.push(item);
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  peek(): T | undefined {
    return this.items[0];
  }

  take(): T | undefined {
    const first = this.items[0];
    if (first === undefined) return undefined;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return first;
  }

  private siftUp(from: number): void {
    let at = from;
    const item = this.items[at]!;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.before(item, this.items[parent]!) >= 0) break;
      this.items[at] = this.items[parent]!;
      at = parent;
    }
    this.items[at] = item;
  }

  private siftDown(from: number): void {
    let at = from;
    const item = this.items[at]!;
    const half = this.items.length >> 1;
    while (at < half) {
      let child = at * 2 + 1;
      const right = child + 1;
      if (right < this.items.length && this.before(this.items[right]!, this.items[child]!) < 0) {
        child = right;
      }
      if (this.before(this.items[child]!, item) >= 0) break;
      this.items[at] = this.items[child]!;
      at = child;
    }
    this.items[at] = item;
  }
}
