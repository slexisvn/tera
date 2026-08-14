export class Worklist<T> {
  private readonly items: T[] = [];
  private head = 0;
  private readonly queued = new Set<T>();

  constructor(initial: Iterable<T> = []) {
    this.addAll(initial);
  }

  add(item: T): void {
    if (this.queued.has(item)) return;
    this.queued.add(item);
    this.items.push(item);
  }

  addAll(items: Iterable<T>): void {
    for (const item of items) this.add(item);
  }

  take(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head]!;
    this.head++;
    this.queued.delete(item);
    if (this.head >= 64 && this.head * 2 >= this.items.length) {
      this.items.splice(0, this.head);
      this.head = 0;
    }
    return item;
  }

  get size(): number {
    return this.items.length - this.head;
  }

  get isEmpty(): boolean {
    return this.head >= this.items.length;
  }
}
