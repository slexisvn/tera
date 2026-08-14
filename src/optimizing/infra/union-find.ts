export class UnionFind<T> {
  private readonly parents = new Map<T, T>();
  private readonly ranks = new Map<T, number>();

  makeSet(x: T): void {
    if (this.parents.has(x)) return;
    this.parents.set(x, x);
    this.ranks.set(x, 0);
  }

  find(x: T): T {
    if (!this.parents.has(x)) this.makeSet(x);
    const parent = this.parents.get(x)!;
    if (parent === x) return x;
    const root = this.find(parent);
    this.parents.set(x, root);
    return root;
  }

  union(a: T, b: T): T {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return rootA;
    const rankA = this.ranks.get(rootA) ?? 0;
    const rankB = this.ranks.get(rootB) ?? 0;
    if (rankA < rankB) {
      this.parents.set(rootA, rootB);
      return rootB;
    }
    if (rankA > rankB) {
      this.parents.set(rootB, rootA);
      return rootA;
    }
    this.parents.set(rootB, rootA);
    this.ranks.set(rootA, rankA + 1);
    return rootA;
  }

  sameSet(a: T, b: T): boolean {
    return this.find(a) === this.find(b);
  }
}
