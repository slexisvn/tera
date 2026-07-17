import { tracer } from "../core/tracing/index.js";
import type {
  OptimizedCode,
  RegisterCompiledFunction,
} from "../bytecode/register/ops/bytecode.js";

export const DEP_MAP = "map";
export const DEP_ELEMENTS_KIND = "elements-kind";
export const DEP_CALL_TARGET = "call-target";
export const DEP_PROTO_VALIDITY = "proto-validity";

export type DependencyKind =
  | typeof DEP_MAP
  | typeof DEP_ELEMENTS_KIND
  | typeof DEP_CALL_TARGET
  | typeof DEP_PROTO_VALIDITY
  | string;

export type Dependency = {
  kind: DependencyKind;
  id: string | number;
  version?: string | number | null;
};

type DependencyOwner = RegisterCompiledFunction & {
  optimizedCode?: OptimizedCode | null;
  optimizedDependencies?: Dependency[];
  pendingDependencyDeopt?: {
    reason: string;
    kind: DependencyKind;
    id: string | number;
    version: string | number | null;
    markedAt: number;
  };
};

type LazyMarker = {
  markForDeopt(
    fn: DependencyOwner,
    reason: string,
    metadata: { kind: DependencyKind; id: string | number; version: string | number | null },
  ): void;
};

export function dependencyKey(
  kind: DependencyKind,
  id: string | number,
  version: string | number | null = null,
): string {
  return version === null || version === undefined
    ? `${kind}:${id}`
    : `${kind}:${id}:${version}`;
}

export class DependencyRegistry {
  byKey: Map<string, Set<DependencyOwner>>;
  byFunction: Map<DependencyOwner, Dependency[]>;
  lazyMarker: LazyMarker | null;

  constructor() {
    this.byKey = new Map();
    this.byFunction = new Map();
    this.lazyMarker = null;
  }

  bindLazyMarker(marker: LazyMarker | null): void {
    this.lazyMarker = marker;
  }

  clear(): void {
    this.byKey.clear();
    this.byFunction.clear();
  }

  register(compiledFn: DependencyOwner, dependencies: Iterable<Dependency> | Dependency[] | null | undefined): void {
    this.unregister(compiledFn);
    const deps = normalizeDependencies(dependencies);
    compiledFn.optimizedDependencies = deps;
    this.byFunction.set(compiledFn, deps);
    for (const dep of deps) {
      const key = dependencyKey(dep.kind, dep.id, dep.version);
      if (!this.byKey.has(key)) this.byKey.set(key, new Set());
      this.byKey.get(key)!.add(compiledFn);
      tracer.log(
        "deopt",
        `Dependency registered: ${compiledFn.name || "<anonymous>"} -> ${key}`,
      );
    }
  }

  unregister(compiledFn: DependencyOwner): void {
    const deps =
      this.byFunction.get(compiledFn) || compiledFn.optimizedDependencies || [];
    for (const dep of deps) {
      const key = dependencyKey(dep.kind, dep.id, dep.version);
      const fns = this.byKey.get(key);
      if (!fns) continue;
      fns.delete(compiledFn);
      if (fns.size === 0) this.byKey.delete(key);
    }
    this.byFunction.delete(compiledFn);
    compiledFn.optimizedDependencies = [];
  }

  invalidate(
    kind: DependencyKind,
    id: string | number,
    version: string | number | null = null,
    reason = "dependency-invalidated",
  ): number {
    const keys: string[] = [];
    if (version !== null && version !== undefined)
      keys.push(dependencyKey(kind, id, version));
    keys.push(dependencyKey(kind, id));
    const affected = new Set<DependencyOwner>();
    for (const key of keys) {
      const fns = this.byKey.get(key);
      if (!fns) continue;
      for (const fn of fns) affected.add(fn);
    }
    for (const fn of affected) {
      if (!fn.optimizedCode) continue;
      if (this.lazyMarker) {
        this.lazyMarker.markForDeopt(fn, reason, { kind, id, version });
      } else {
        fn.pendingDependencyDeopt = {
          reason,
          kind,
          id,
          version,
          markedAt: Date.now(),
        };
      }
      tracer.log(
        "deopt",
        `Dependency invalidated: ${fn.name || "<anonymous>"} (${reason})`,
      );
    }
    return affected.size;
  }

  getSummary(compiledFn: DependencyOwner): Dependency[] {
    return normalizeDependencies(
      this.byFunction.get(compiledFn) || compiledFn.optimizedDependencies || [],
    );
  }
}

function normalizeDependencies(
  dependencies: Iterable<Dependency> | Dependency[] | null | undefined,
): Dependency[] {
  if (!dependencies) return [];
  const result: Dependency[] = [];
  const seen = new Set<string>();
  const source = Array.isArray(dependencies) ? dependencies : [...dependencies];
  for (const dep of source) {
    if (!dep || !dep.kind) continue;
    const key = dependencyKey(dep.kind, dep.id, dep.version);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: dep.kind, id: dep.id, version: dep.version ?? null });
  }
  return result;
}

export const dependencyRegistry = new DependencyRegistry();
