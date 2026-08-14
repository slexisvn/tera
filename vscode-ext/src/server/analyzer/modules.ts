import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import {
  ENTRY_SPEC,
  MODULE_EXTENSION,
  ModuleResolver,
  PACKAGES_DIRECTORY,
  PACKAGE_INDEX,
  PROJECT_MANIFEST,
  buildModuleGraph,
  checkModuleGraph,
  isNativeSpec,
  moduleSpecFor,
  nativeName,
  parse,
  searchPathsUnder,
  type ASTNode,
  type ExternalBuiltinSignature,
  type ModuleBinding,
  type ModuleBindingKind,
  type ModuleFileSystem,
  type ModuleGraph,
  type ModuleInterface,
  type ModuleKind,
  type ModuleRecord,
  type ParserOptions,
  type ResolvedImport,
  type ResolvedModule,
} from "tera/frontend";
import { nodeModuleFileSystem } from "tera/frontend/modules/node-file-system";
import { importsIn } from "./import-syntax.ts";
import { canonicalPath, pathKey, pathOfUri, samePath, uriOfPath } from "./paths.ts";
import { splitLines } from "./position.ts";
import type { AnalyzedError } from "./types.ts";

export type ModuleDocument = {
  readonly path: string;
  readonly source: string;
};

export type ModuleAnalysis = {
  readonly graph: ModuleGraph;
  readonly diagnostics: ReadonlyMap<string, AnalyzedError[]>;
  readonly documents: ReadonlyMap<string, ModuleDocument>;
  readonly interfaces: ReadonlyMap<string, ModuleInterface>;
};

export type ImportedName = {
  readonly local: string;
  readonly imported: string;
  readonly label: string;
  readonly level: number;
  readonly path: readonly string[];
  readonly namespace: boolean;
  readonly kind: ModuleBindingKind;
  readonly line: number;
  readonly character: number;
};

type ImportSite = {
  readonly path: string;
  readonly local: string;
  readonly imported: string;
  readonly aliased: boolean;
  readonly line: number;
  readonly character: number;
};

export type ReferenceTarget = {
  readonly path: string;
  readonly name: string;
  readonly namespaces: ReadonlySet<string>;
  readonly plain: boolean;
  readonly declaration: { line: number; character: number } | null;
};

type MutableTarget = {
  path: string;
  name: string;
  namespaces: Set<string>;
  plain: boolean;
  declaration: { line: number; character: number } | null;
};

type ImportIndex = {
  specifiers: Map<string, ImportSite[]>;
  namespaces: Map<string, Array<{ path: string; local: string }>>;
};

export type ModuleTarget = {
  readonly spec: string;
  readonly path: string | null;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly kind: ModuleBindingKind;
};

export type ModuleOrigin = {
  readonly spec: string;
  readonly imported: string;
  readonly local: string;
  readonly namespace: boolean;
};

export type ModuleCandidate = {
  readonly name: string;
  readonly kind: ModuleKind;
};

type Stamp = string;

type CacheEntry = {
  readonly revision: number;
  readonly stamps: ReadonlyMap<string, Stamp>;
  readonly analysis: ModuleAnalysis;
};

type Overlay = { text: string; revision: number };

const DIAGNOSTIC_SOURCE = "modules";
const MODULE_SCAN_LIMIT = 2000;
const NAMESPACE_SCAN_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  PACKAGES_DIRECTORY,
]);

export class ModuleWorkspace {
  private readonly overlays = new Map<string, Overlay>();
  private readonly uris = new Map<string, string>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly parses = new Map<string, { source: string; ast: ASTNode }>();
  private readonly graphs = new Map<string, { stamps: Map<string, Stamp>; graph: ModuleGraph }>();
  private readonly files = new Map<string, { revision: number; paths: string[] }>();
  private readonly imports = new Map<string, { revision: number; index: ImportIndex }>();
  private natives: readonly string[] = [];
  private revision = 0;
  private readonly fileSystem: ModuleFileSystem = {
    ...nodeModuleFileSystem,
    readFile: (filePath) => this.read(filePath),
  };

  configure(options: { nativeModules?: readonly string[] }): void {
    if (options.nativeModules !== undefined) this.natives = [...options.nativeModules];
    this.revision++;
    this.cache.clear();
  }

  update(uri: string, text: string): void {
    const filePath = pathOfUri(uri);
    if (filePath === null) return;
    const key = pathKey(filePath);
    this.revision++;
    this.overlays.set(key, { text, revision: this.revision });
    this.uris.set(key, uri);
  }

  drop(uri: string): void {
    const filePath = pathOfUri(uri);
    if (filePath === null) return;
    const key = pathKey(filePath);
    this.revision++;
    this.overlays.delete(key);
    this.uris.delete(key);
    this.cache.delete(key);
  }

  invalidate(): void {
    this.revision++;
    this.cache.clear();
  }

  uriFor(filePath: string): string {
    return this.uris.get(pathKey(filePath)) ?? uriOfPath(filePath);
  }

  analyze(uri: string): ModuleAnalysis | null {
    const entryPath = pathOfUri(uri);
    if (entryPath === null) return null;
    const key = pathKey(entryPath);
    const cached = this.cache.get(key);
    if (cached !== undefined && this.isFresh(cached)) return cached.analysis;

    const analysis = this.build(entryPath);
    if (analysis === null) return null;
    this.cache.set(key, {
      revision: this.revision,
      stamps: this.stampsOf(analysis),
      analysis,
    });
    return analysis;
  }

  graphFor(uri: string): ModuleGraph | null {
    return this.analyze(uri)?.graph ?? null;
  }

  resolverFor(entryPath: string): { resolver: ModuleResolver; from: ResolvedModule } {
    const canonical = canonicalPath(entryPath);
    const root = moduleRootFor(canonical);
    const resolver = new ModuleResolver({
      fileSystem: this.fileSystem,
      root,
      searchPaths: searchPathsUnder(this.fileSystem, root),
      nativeModules: this.natives,
    });
    return { resolver, from: { spec: ENTRY_SPEC, path: canonical, kind: "file" } };
  }

  exportsOf(entryPath: string, level: number, segments: readonly string[]): ModuleBinding[] {
    const { resolver, from } = this.resolverFor(entryPath);
    const resolved = resolver.tryResolve({ level, path: [...segments] }, from);
    if (resolved === null || resolved.path === null || resolved.kind === "namespace") return [];
    return this.exportedNamesOf(resolved.path);
  }

  specOf(entryPath: string, filePath: string): string | null {
    const spec = moduleSpecFor(this.fileSystem, moduleRootFor(entryPath), filePath);
    return spec === null || spec.length === 0 ? null : spec;
  }

  exportedNamesOf(filePath: string): ModuleBinding[] {
    const graph = this.graphOf(filePath);
    if (graph === null) return [];
    return [...graph.entry.bindings.values()].filter((binding) => binding.exported);
  }

  declaredNamesOf(filePath: string): ModuleBinding[] {
    const graph = this.graphOf(filePath);
    if (graph === null) return [];
    return [...graph.entry.bindings.values()].filter(
      (binding) => binding.exported && importOwning(graph.entry, binding.name) === null,
    );
  }

  modulesExporting(entryPath: string, name: string, limit: number): string[] {
    const root = moduleRootFor(entryPath);
    const specs: string[] = [];
    for (const filePath of this.moduleFiles(entryPath)) {
      if (samePath(filePath, entryPath) || specs.length >= limit) continue;
      if (!this.exportedNamesOf(filePath).some((binding) => binding.name === name)) continue;
      const spec = moduleSpecFor(this.fileSystem, root, filePath);
      if (spec !== null && spec.length > 0) specs.push(spec);
    }
    return specs;
  }

  private graphOf(entryPath: string): ModuleGraph | null {
    const key = pathKey(entryPath);
    const cached = this.graphs.get(key);
    if (cached !== undefined && this.stampsMatch(cached.stamps)) return cached.graph;
    const graph = this.buildGraph(entryPath);
    if (graph === null) return null;
    const stamps = new Map<string, Stamp>();
    for (const record of graph.modules.values()) {
      if (record.path !== null) stamps.set(record.path, this.stampOf(record.path));
    }
    this.graphs.set(key, { stamps, graph });
    return graph;
  }

  private isFresh(entry: CacheEntry): boolean {
    return entry.revision === this.revision || this.stampsMatch(entry.stamps);
  }

  private stampsMatch(stamps: ReadonlyMap<string, Stamp>): boolean {
    for (const [filePath, stamp] of stamps) {
      if (this.stampOf(filePath) !== stamp) return false;
    }
    return true;
  }

  private stampsOf(analysis: ModuleAnalysis): Map<string, Stamp> {
    const stamps = new Map<string, Stamp>();
    for (const { path } of analysis.documents.values()) stamps.set(path, this.stampOf(path));
    return stamps;
  }

  private stampOf(filePath: string): Stamp {
    const overlay = this.overlays.get(pathKey(filePath));
    if (overlay !== undefined) return `open:${overlay.revision}`;
    const stats = statSync(filePath, { throwIfNoEntry: false });
    return stats === undefined ? "missing" : `disk:${stats.mtimeMs}:${stats.size}`;
  }

  private read(filePath: string): string {
    const overlay = this.overlays.get(pathKey(filePath));
    return overlay !== undefined ? overlay.text : readFileSync(filePath, "utf8");
  }

  private parse(source: string, name: string, options: ParserOptions): ASTNode {
    const cached = this.parses.get(name);
    if (cached !== undefined && cached.source === source) return cached.ast;
    const ast = parse(source, options);
    this.parses.set(name, { source, ast });
    return ast;
  }

  private buildGraph(entryPath: string): ModuleGraph | null {
    const options = createReactiveCheckOptions();
    const root = moduleRootFor(entryPath);
    try {
      return buildModuleGraph(entryPath, {
        fileSystem: this.fileSystem,
        root,
        searchPaths: searchPathsUnder(this.fileSystem, root),
        nativeModules: this.natives,
        entrySource: this.overlays.get(pathKey(entryPath))?.text,
        parseSource: (source, name) =>
          this.parse(source, name, { syntaxPlugins: options.syntaxPlugins }),
      });
    } catch {
      return null;
    }
  }

  private build(entryPath: string): ModuleAnalysis | null {
    const options = createReactiveCheckOptions();
    const documents = new Map<string, ModuleDocument>();
    const entryKey = pathKey(entryPath);

    const graph = this.graphOf(entryPath);
    if (graph === null) return null;

    for (const record of graph.modules.values()) {
      if (record.path === null) continue;
      documents.set(pathKey(record.path), { path: record.path, source: record.source });
    }

    const checked = checkModuleGraph(graph, {
      mode: options.mode,
      builtins: options.builtins,
      aliases: options.aliases,
      interfaces: options.interfaces,
    });

    const diagnostics = new Map<string, AnalyzedError[]>();
    for (const key of documents.keys()) diagnostics.set(key, []);
    for (const diagnostic of checked.diagnostics) {
      const owner = diagnostic.path === null ? entryKey : pathKey(diagnostic.path);
      const bucket = diagnostics.get(owner);
      const error: AnalyzedError = {
        message: diagnostic.message,
        line: diagnostic.line,
        column: diagnostic.column,
        severity: diagnostic.severity,
        source: DIAGNOSTIC_SOURCE,
      };
      if (bucket === undefined) diagnostics.set(owner, [error]);
      else bucket.push(error);
    }

    return { graph, diagnostics, documents, interfaces: checked.interfaces };
  }

  importedNames(entryPath: string, lines: readonly string[]): ImportedName[] {
    const names: ImportedName[] = [];
    for (const syntax of importsIn(lines)) {
      const path = syntax.path.map((token) => token.text);
      const label = `${".".repeat(syntax.level)}${path.join(".")}`;
      if (syntax.form === "import") {
        const token = syntax.alias ?? syntax.path[0];
        if (token === undefined) continue;
        const bound = syntax.alias === null ? path.slice(0, 1) : path;
        names.push({
          local: token.text,
          imported: token.text,
          label,
          level: 0,
          path: bound,
          namespace: true,
          kind: "module",
          line: token.line,
          character: token.start,
        });
        continue;
      }
      if (syntax.importKeyword === null) continue;
      const kinds = new Map(
        this.exportsOf(entryPath, syntax.level, path).map((binding) => [binding.name, binding.kind]),
      );
      for (const specifier of syntax.specifiers) {
        const token = specifier.local ?? specifier.imported;
        names.push({
          local: token.text,
          imported: specifier.imported.text,
          label,
          level: syntax.level,
          path,
          namespace: false,
          kind: kinds.get(specifier.imported.text) ?? "value",
          line: token.line,
          character: token.start,
        });
      }
    }
    return names;
  }

  unresolvedImports(entryPath: string, lines: readonly string[]): AnalyzedError[] {
    const { resolver, from } = this.resolverFor(entryPath);
    const errors: AnalyzedError[] = [];
    for (const syntax of importsIn(lines)) {
      if (syntax.form === "from" && syntax.importKeyword === null) continue;
      if (syntax.path.length === 0 && syntax.level === 0) continue;
      const path = syntax.path.map((token) => token.text);
      if (resolver.tryResolve({ level: syntax.level, path }, from) !== null) continue;
      const first = syntax.dots ?? syntax.path[0];
      const last = syntax.path[syntax.path.length - 1] ?? syntax.dots;
      if (first === undefined || last === undefined) continue;
      errors.push({
        message: `Cannot resolve module '${".".repeat(syntax.level)}${path.join(".")}'`,
        line: first.line + 1,
        column: first.start + 1,
        severity: "error",
        source: DIAGNOSTIC_SOURCE,
      });
    }
    return errors;
  }

  signatureOf(entryPath: string, name: ImportedName, member: string | null): ExternalBuiltinSignature | null {
    const { resolver, from } = this.resolverFor(entryPath);
    const resolved = resolver.tryResolve({ level: name.level, path: [...name.path] }, from);
    if (resolved?.path == null) return null;
    const analysis = this.analyze(uriOfPath(resolved.path));
    if (analysis === null) return null;

    const wanted = member ?? name.imported;
    const own = analysis.interfaces.get(ENTRY_SPEC)?.builtins?.find((entry) => entry.name === wanted);
    if (own !== undefined) return own;

    const target = resolveExport(analysis.graph, ENTRY_SPEC, wanted);
    if (target === null || target.spec === ENTRY_SPEC) return null;
    return analysis.interfaces.get(target.spec)?.builtins?.find((entry) => entry.name === target.name)
      ?? null;
  }

  referenceTargets(
    entryPath: string,
    ownerPath: string,
    name: string,
    followAliases: boolean,
    declaration: { line: number; character: number } | null = null,
  ): ReferenceTarget[] {
    const index = this.importIndex(entryPath);
    const targets = new Map<string, MutableTarget>();
    const claim = (path: string, local: string, through: string | null): MutableTarget => {
      const key = `${pathKey(path)} ${local}`;
      const target = targets.get(key)
        ?? { path, name: local, namespaces: new Set<string>(), plain: false, declaration: null };
      targets.set(key, target);
      if (through === null) target.plain = true;
      else target.namespaces.add(through);
      return target;
    };

    const seen = new Set<string>();
    const queue = [{ path: ownerPath, name }];
    claim(ownerPath, name, null).declaration = declaration;
    while (queue.length > 0) {
      const hop = queue.shift()!;
      const key = `${pathKey(hop.path)} ${hop.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      for (const entry of index.namespaces.get(pathKey(hop.path)) ?? []) {
        claim(entry.path, hop.name, entry.local);
      }
      for (const site of index.specifiers.get(pathKey(hop.path)) ?? []) {
        if (site.imported !== hop.name) continue;
        claim(site.path, site.imported, null).declaration = {
          line: site.line,
          character: site.character,
        };
        if (site.aliased && !followAliases) continue;
        claim(site.path, site.local, null);
        queue.push({ path: site.path, name: site.local });
      }
    }
    return [...targets.values()];
  }

  private importIndex(entryPath: string): ImportIndex {
    const root = moduleRootFor(entryPath);
    const cached = this.imports.get(root);
    if (cached !== undefined && cached.revision === this.revision) return cached.index;

    const index: ImportIndex = { specifiers: new Map(), namespaces: new Map() };
    for (const filePath of this.moduleFiles(entryPath)) {
      const { resolver, from } = this.resolverFor(filePath);
      for (const syntax of importsIn(splitLines(this.read(filePath)))) {
        const request = syntax.form === "import" && syntax.alias === null
          ? syntax.path.slice(0, 1).map((token) => token.text)
          : syntax.path.map((token) => token.text);
        const resolved = resolver.tryResolve({ level: syntax.level, path: request }, from);
        if (resolved?.path == null || samePath(resolved.path, filePath)) continue;
        const key = pathKey(resolved.path);

        if (syntax.form === "import") {
          const token = syntax.alias ?? syntax.path[0];
          if (token === undefined) continue;
          const bound = index.namespaces.get(key) ?? [];
          bound.push({ path: filePath, local: token.text });
          index.namespaces.set(key, bound);
          continue;
        }
        if (syntax.importKeyword === null) continue;
        const sites = index.specifiers.get(key) ?? [];
        for (const specifier of syntax.specifiers) {
          sites.push({
            path: filePath,
            local: (specifier.local ?? specifier.imported).text,
            imported: specifier.imported.text,
            aliased: specifier.local !== null,
            line: specifier.imported.line,
            character: specifier.imported.start,
          });
        }
        index.specifiers.set(key, sites);
      }
    }
    this.imports.set(root, { revision: this.revision, index });
    return index;
  }

  sourceAt(filePath: string): string {
    return this.read(filePath);
  }

  moduleFiles(entryPath: string): string[] {
    const root = moduleRootFor(entryPath);
    const cached = this.files.get(root);
    if (cached !== undefined && cached.revision === this.revision) return cached.paths;
    const paths = walkModules(root);
    this.files.set(root, { revision: this.revision, paths });
    return paths;
  }

  listModules(entryPath: string, level: number, prefix: readonly string[]): ModuleCandidate[] {
    const { resolver } = this.resolverFor(entryPath);
    const directories = level > 0 ? [relativeBase(entryPath, level)] : [...resolver.bases];
    const candidates = new Map<string, ModuleCandidate>();
    for (const directory of directories) {
      for (const candidate of readModuleDirectory(join(directory, ...prefix))) {
        if (!candidates.has(candidate.name)) candidates.set(candidate.name, candidate);
      }
    }
    if (level === 0 && prefix.length === 0) {
      for (const name of this.natives) candidates.set(name, { name, kind: "native" });
    }
    return [...candidates.values()];
  }
}

export function moduleRootFor(entryPath: string): string {
  const manifest = manifestRoot(entryPath);
  return manifest ?? packageRoot(entryPath);
}

function manifestRoot(entryPath: string): string | null {
  let directory = dirname(resolve(entryPath));
  for (;;) {
    if (isFile(join(directory, PROJECT_MANIFEST))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function packageRoot(entryPath: string): string {
  let directory = dirname(resolve(entryPath));
  for (;;) {
    if (!isFile(join(directory, PACKAGE_INDEX))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return directory;
    directory = parent;
  }
}

function relativeBase(entryPath: string, level: number): string {
  let directory = dirname(resolve(entryPath));
  for (let step = 1; step < level; step++) directory = dirname(directory);
  return directory;
}

function walkModules(root: string): string[] {
  const paths: string[] = [];
  const queue = [root];
  while (queue.length > 0 && paths.length < MODULE_SCAN_LIMIT) {
    const directory = queue.shift()!;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(target);
        continue;
      }
      if (entry.name.endsWith(MODULE_EXTENSION)) paths.push(canonicalPath(target));
    }
  }
  return paths;
}

function readModuleDirectory(directory: string): ModuleCandidate[] {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const candidates: ModuleCandidate[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const kind = isFile(join(directory, entry.name, PACKAGE_INDEX)) ? "package" : "namespace";
      if (kind === "package" || containsModule(join(directory, entry.name))) {
        candidates.push({ name: entry.name, kind });
      }
      continue;
    }
    if (!entry.name.endsWith(MODULE_EXTENSION) || entry.name === PACKAGE_INDEX) continue;
    candidates.push({ name: basename(entry.name, MODULE_EXTENSION), kind: "file" });
  }
  return candidates;
}

function containsModule(directory: string, depth = NAMESPACE_SCAN_DEPTH): boolean {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return false;
  }
  if (entries.some((entry) => !entry.isDirectory() && entry.name.endsWith(MODULE_EXTENSION))) {
    return true;
  }
  if (depth <= 1) return false;
  return entries.some(
    (entry) =>
      entry.isDirectory() &&
      !SKIPPED_DIRECTORIES.has(entry.name) &&
      containsModule(join(directory, entry.name), depth - 1),
  );
}

function isFile(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function moduleLabel(spec: string): string {
  return isNativeSpec(spec) ? nativeName(spec) : spec;
}

export function importOwning(record: ModuleRecord, local: string): ModuleOrigin | null {
  for (const entry of record.imports) {
    if (entry.local === local) {
      return { spec: entry.boundSpec ?? entry.module, imported: local, local, namespace: true };
    }
    for (const binding of entry.bindings) {
      if (binding.local !== local) continue;
      return {
        spec: binding.submodule ?? binding.module,
        imported: binding.imported,
        local,
        namespace: binding.submodule !== null,
      };
    }
  }
  return null;
}

export function namespaceImport(record: ModuleRecord, local: string): ResolvedImport | null {
  return record.imports.find((entry) => entry.local === local) ?? null;
}

export function resolveExport(
  graph: ModuleGraph,
  spec: string,
  name: string,
  seen: Set<string> = new Set(),
): ModuleTarget | null {
  const visit = `${spec} ${name}`;
  if (seen.has(visit)) return null;
  seen.add(visit);

  const record = graph.modules.get(spec);
  if (record === undefined) return null;

  const origin = importOwning(record, name);
  if (origin !== null) {
    if (origin.namespace) return moduleTarget(graph, origin.spec);
    const forwarded = resolveExport(graph, origin.spec, origin.imported, seen);
    if (forwarded !== null) return forwarded;
  }

  const binding = record.bindings.get(name);
  if (binding === undefined) return null;
  return {
    spec,
    path: record.path,
    name: binding.name,
    line: binding.span.line,
    column: binding.span.column,
    kind: binding.kind,
  };
}

export function moduleTarget(graph: ModuleGraph, spec: string): ModuleTarget | null {
  const record = graph.modules.get(spec);
  if (record === undefined || record.path === null) return null;
  return { spec, path: record.path, name: spec, line: 1, column: 1, kind: "module" };
}
