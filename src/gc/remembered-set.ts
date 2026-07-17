export class RememberedSet<T = RuntimeValue> {
  private _holders: Set<T>;

  constructor() {
    this._holders = new Set();
  }

  record(holder: T): void {
    this._holders.add(holder);
  }

  remove(holder: T): void {
    this._holders.delete(holder);
  }

  has(holder: T): boolean {
    return this._holders.has(holder);
  }

  clear(): void {
    this._holders.clear();
  }

  iterateHolders(callback: (holder: T) => void): void {
    for (const holder of this._holders) {
      callback(holder);
    }
  }

  filterDead(predicate: (holder: T) => boolean): void {
    for (const holder of this._holders) {
      if (!predicate(holder)) this._holders.delete(holder);
    }
  }

  get size(): number {
    return this._holders.size;
  }
}
