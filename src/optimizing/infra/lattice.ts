export interface Lattice<T> {
  readonly bottom: T;
  join(left: T, right: T): T;
  equals(left: T, right: T): boolean;
}

export function productLattice<A, B>(
  left: Lattice<A>,
  right: Lattice<B>,
): Lattice<readonly [A, B]> {
  return {
    bottom: [left.bottom, right.bottom],
    join: (a, b) => [left.join(a[0], b[0]), right.join(a[1], b[1])],
    equals: (a, b) => left.equals(a[0], b[0]) && right.equals(a[1], b[1]),
  };
}

export function mapLattice<K, V>(values: Lattice<V>): Lattice<ReadonlyMap<K, V>> {
  return {
    bottom: new Map<K, V>(),
    join(left, right) {
      const result = new Map<K, V>(left);
      for (const [key, value] of right) {
        const existing = result.get(key);
        result.set(key, existing === undefined ? value : values.join(existing, value));
      }
      return result;
    },
    equals(left, right) {
      const keys = new Set<K>();
      for (const key of left.keys()) keys.add(key);
      for (const key of right.keys()) keys.add(key);
      for (const key of keys) {
        const a = left.get(key) ?? values.bottom;
        const b = right.get(key) ?? values.bottom;
        if (!values.equals(a, b)) return false;
      }
      return true;
    },
  };
}

export function setLattice<T>(): Lattice<ReadonlySet<T>> {
  return {
    bottom: new Set<T>(),
    join(left, right) {
      const result = new Set<T>(left);
      for (const item of right) result.add(item);
      return result;
    },
    equals(left, right) {
      if (left.size !== right.size) return false;
      for (const item of left) if (!right.has(item)) return false;
      return true;
    },
  };
}

export type FlatValue<T> =
  | { readonly kind: "bottom" }
  | { readonly kind: "constant"; readonly value: T }
  | { readonly kind: "top" };

export function flatLattice<T>(
  equals: (a: T, b: T) => boolean = Object.is,
): Lattice<FlatValue<T>> {
  const bottom: FlatValue<T> = { kind: "bottom" };
  const top: FlatValue<T> = { kind: "top" };
  return {
    bottom,
    join(left, right) {
      if (left.kind === "bottom") return right;
      if (right.kind === "bottom") return left;
      if (left.kind === "top" || right.kind === "top") return top;
      return equals(left.value, right.value) ? left : top;
    },
    equals(left, right) {
      if (left.kind !== right.kind) return false;
      if (left.kind === "constant" && right.kind === "constant") {
        return equals(left.value, right.value);
      }
      return true;
    },
  };
}
