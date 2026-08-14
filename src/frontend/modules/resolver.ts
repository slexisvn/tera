import type { ModuleFileSystem } from "./file-system.js";

export const ENTRY_SPEC = "__main__";
export const MODULE_EXTENSION = ".tera";
export const PACKAGE_INDEX = `__init__${MODULE_EXTENSION}`;
export const NATIVE_PREFIX = "native:";
export const PROJECT_MANIFEST = "tera.json";

export type ModuleKind = "file" | "package" | "namespace" | "native";

export type ResolvedModule = {
  readonly spec: string;
  readonly path: string | null;
  readonly kind: ModuleKind;
};

export type ModuleRequest = {
  readonly level: number;
  readonly path: readonly string[];
};

export type ResolverOptions = {
  readonly fileSystem: ModuleFileSystem;
  readonly root: string;
  readonly searchPaths?: readonly string[];
  readonly nativeModules?: Iterable<string>;
};

export class ModuleResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleResolutionError";
  }
}

export function projectRootFor(fileSystem: ModuleFileSystem, entryPath: string): string {
  let directory = fileSystem.dirname(fileSystem.resolve(entryPath));
  for (;;) {
    if (fileSystem.isFile(fileSystem.join(directory, PROJECT_MANIFEST))) return directory;
    const parent = fileSystem.dirname(directory);
    if (parent === directory) return fileSystem.dirname(fileSystem.resolve(entryPath));
    directory = parent;
  }
}

export function isNativeSpec(spec: string): boolean {
  return spec.startsWith(NATIVE_PREFIX);
}

export function nativeName(spec: string): string {
  return spec.slice(NATIVE_PREFIX.length);
}

function moduleAt(
  fileSystem: ModuleFileSystem,
  target: string,
): { path: string; kind: ModuleKind } | null {
  const file = `${target}${MODULE_EXTENSION}`;
  if (fileSystem.isFile(file)) return { path: fileSystem.canonical(file), kind: "file" };
  const index = fileSystem.join(target, PACKAGE_INDEX);
  if (fileSystem.isFile(index)) return { path: fileSystem.canonical(index), kind: "package" };
  if (fileSystem.isDirectory(target)) {
    return { path: fileSystem.canonical(target), kind: "namespace" };
  }
  return null;
}

function dottedSpec(separator: string, relative: string): string {
  let normalized = relative.split(separator).join("/");
  if (normalized === PACKAGE_INDEX) normalized = "";
  else if (normalized.endsWith(`/${PACKAGE_INDEX}`)) {
    normalized = normalized.slice(0, -(PACKAGE_INDEX.length + 1));
  } else if (normalized.endsWith(MODULE_EXTENSION)) {
    normalized = normalized.slice(0, -MODULE_EXTENSION.length);
  }
  return normalized
    .split("/")
    .filter((part) => part.length > 0)
    .join(".");
}

export function moduleSpecFor(
  fileSystem: ModuleFileSystem,
  base: string,
  target: string,
): string | null {
  return specWithin(fileSystem, fileSystem.resolve(base), fileSystem.resolve(target));
}

function specWithin(
  fileSystem: ModuleFileSystem,
  base: string,
  target: string,
): string | null {
  const relative = fileSystem.relative(base, target);
  if (relative.length === 0) return "";
  if (relative.startsWith("..") || fileSystem.isAbsolute(relative)) return null;
  return dottedSpec(fileSystem.separator, relative);
}

export class ModuleResolver {
  readonly bases: readonly string[];
  private readonly fileSystem: ModuleFileSystem;
  private readonly natives: ReadonlySet<string>;

  constructor(options: ResolverOptions) {
    this.fileSystem = options.fileSystem;
    const bases = [options.root, ...(options.searchPaths ?? [])].map((base) =>
      this.fileSystem.resolve(base),
    );
    this.bases = [...new Set(bases)];
    this.natives = new Set(options.nativeModules ?? []);
  }

  hasNative(name: string): boolean {
    return this.natives.has(name);
  }

  specOf(target: string): string | null {
    let fallback: string | null = null;
    let best: string | null = null;
    let bestBase = 0;
    for (const base of this.bases) {
      const spec = specWithin(this.fileSystem, base, this.fileSystem.resolve(target));
      if (spec === null) continue;
      if (spec.length === 0) {
        fallback = spec;
        continue;
      }
      if (best !== null && base.length <= bestBase) continue;
      best = spec;
      bestBase = base.length;
    }
    return best ?? fallback;
  }

  resolveEntry(entryPath: string): ResolvedModule {
    const resolved = this.fileSystem.resolve(entryPath);
    if (!this.fileSystem.isFile(resolved)) {
      throw new ModuleResolutionError(`entry file not found: ${entryPath}`);
    }
    return { spec: ENTRY_SPEC, path: this.fileSystem.canonical(resolved), kind: "file" };
  }

  resolve(request: ModuleRequest, from: ResolvedModule): ResolvedModule {
    return request.level > 0 ? this.resolveRelative(request, from) : this.resolveAbsolute(request);
  }

  tryResolve(request: ModuleRequest, from: ResolvedModule): ResolvedModule | null {
    try {
      return this.resolve(request, from);
    } catch (error) {
      if (error instanceof ModuleResolutionError) return null;
      throw error;
    }
  }

  private resolveAbsolute(request: ModuleRequest): ResolvedModule {
    const name = request.path.join(".");
    if (name.length === 0) throw new ModuleResolutionError("Expected a module name");
    if (this.natives.has(name)) {
      for (const base of this.bases) {
        if (this.moduleUnder(base, request.path) === null) continue;
        throw new ModuleResolutionError(`Cannot shadow native module '${name}'`);
      }
      return { spec: `${NATIVE_PREFIX}${name}`, path: null, kind: "native" };
    }
    for (const base of this.bases) {
      const candidate = this.moduleUnder(base, request.path);
      if (candidate === null) continue;
      const spec = specWithin(this.fileSystem, base, candidate.path);
      if (spec === null) continue;
      return { spec, path: candidate.path, kind: candidate.kind };
    }
    throw new ModuleResolutionError(`Cannot resolve module '${name}'`);
  }

  private moduleUnder(
    base: string,
    segments: readonly string[],
  ): { path: string; kind: ModuleKind } | null {
    return moduleAt(this.fileSystem, this.fileSystem.join(base, ...segments));
  }

  private resolveRelative(request: ModuleRequest, from: ResolvedModule): ResolvedModule {
    const origin = from.path;
    if (origin === null) {
      throw new ModuleResolutionError(
        `Cannot use a relative import from native module '${from.spec}'`,
      );
    }
    let directory = from.kind === "namespace" ? origin : this.fileSystem.dirname(origin);
    for (let level = 1; level < request.level; level++) {
      directory = this.fileSystem.dirname(directory);
    }

    const candidate = this.moduleUnder(directory, request.path);
    const display = `${".".repeat(request.level)}${request.path.join(".")}`;
    if (candidate === null) throw new ModuleResolutionError(`Cannot resolve module '${display}'`);

    const withinBases = this.specOf(candidate.path);
    if (withinBases === null) {
      throw new ModuleResolutionError(`Relative import '${display}' escapes the project root`);
    }
    const owner = this.owningPackage(from, request.level);
    const spec = owner === null ? withinBases : [owner, ...request.path].join(".");
    return { spec, path: candidate.path, kind: candidate.kind };
  }

  private owningPackage(from: ResolvedModule, level: number): string | null {
    if (from.spec === ENTRY_SPEC || from.spec.length === 0) return null;
    const segments = from.spec.split(".");
    const owner = from.kind === "file" ? segments.slice(0, -1) : segments;
    const kept = owner.slice(0, owner.length - (level - 1));
    return kept.length === 0 ? null : kept.join(".");
  }
}
