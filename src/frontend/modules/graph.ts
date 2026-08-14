import { parse } from "../parser/language.js";
import { astToSemanticProgram } from "../checker/semantic-lowering.js";
import type { ASTNode } from "../ast/index.js";
import type { ImportNode, SemanticNode, SemanticProgram, SourceSpan } from "../checker/semantic-ast.js";
import {
  ENTRY_SPEC,
  isNativeSpec,
  ModuleResolutionError,
  ModuleResolver,
  projectRootFor,
  type ModuleKind,
  type ResolvedModule,
} from "./resolver.js";
import type { ModuleFileSystem } from "./file-system.js";

export type ModuleBindingKind =
  | "function"
  | "class"
  | "model"
  | "interface"
  | "type"
  | "value"
  | "module";

export type ModuleBinding = {
  readonly name: string;
  readonly kind: ModuleBindingKind;
  readonly exported: boolean;
  readonly span: SourceSpan;
};

export type ResolvedBinding = {
  readonly imported: string;
  readonly local: string;
  readonly span: SourceSpan;
  readonly module: string;
  readonly submodule: string | null;
};

export type ResolvedImport = {
  readonly module: string;
  readonly local: string | null;
  readonly boundSpec: string | null;
  readonly bindings: readonly ResolvedBinding[];
  readonly span: SourceSpan;
};

export type ModuleRecord = {
  readonly spec: string;
  readonly path: string | null;
  readonly kind: ModuleKind;
  readonly source: string;
  readonly ast: ASTNode;
  readonly program: SemanticProgram;
  readonly bindings: ReadonlyMap<string, ModuleBinding>;
  readonly imports: readonly ResolvedImport[];
};

export type ModuleGraph = {
  readonly entry: ModuleRecord;
  readonly modules: ReadonlyMap<string, ModuleRecord>;
  readonly initOrder: readonly ModuleRecord[];
  readonly checkOrder: readonly ModuleRecord[];
  readonly cycles: readonly (readonly string[])[];
};

export type ModuleGraphOptions = {
  readonly fileSystem: ModuleFileSystem;
  readonly root?: string;
  readonly searchPaths?: readonly string[];
  readonly nativeModules?: Iterable<string>;
  readonly parseSource?: (source: string, name: string) => ASTNode;
  readonly entrySource?: string;
};

export class ModuleGraphError extends Error {
  constructor(message: string, readonly chain: readonly string[] = []) {
    super(chain.length > 1 ? `${message} (imported by ${chain.join(" -> ")})` : message);
    this.name = "ModuleGraphError";
  }
}

type MutableRecord = {
  spec: string;
  path: string | null;
  kind: ModuleKind;
  source: string;
  ast: ASTNode;
  program: SemanticProgram;
  bindings: Map<string, ModuleBinding>;
  imports: ResolvedImport[];
  chain: string[];
  parsed: boolean;
};

const EMPTY_AST: ASTNode = { type: "Program", body: [] };

export function isExportable(name: string): boolean {
  return !name.startsWith("_");
}

function parentSpec(spec: string): string | null {
  if (isNativeSpec(spec)) return null;
  const dot = spec.lastIndexOf(".");
  return dot > 0 ? spec.slice(0, dot) : null;
}

function bindingsOf(program: SemanticProgram): Map<string, ModuleBinding> {
  const bindings = new Map<string, ModuleBinding>();
  const add = (name: string, kind: ModuleBindingKind, span: SourceSpan): void => {
    if (name.length === 0 || bindings.has(name)) return;
    bindings.set(name, { name, kind, exported: isExportable(name), span });
  };
  for (const node of program.body) collectBinding(node, add);
  return bindings;
}

function collectBinding(
  node: SemanticNode,
  add: (name: string, kind: ModuleBindingKind, span: SourceSpan) => void,
): void {
  switch (node.kind) {
    case "Function":
      add(node.name, "function", node.nameSpan);
      return;
    case "Class":
      add(node.name, "class", node.nameSpan);
      return;
    case "Model":
      add(node.name, "model", node.nameSpan);
      return;
    case "Interface":
      add(node.name, "interface", node.span);
      return;
    case "TypeAlias":
      add(node.name, "type", node.span);
      return;
    case "Var":
      add(node.name, "value", node.nameSpan);
      return;
    case "Destructure":
      node.names.forEach((name, at) => add(name, "value", node.variableSpans[at] ?? node.span));
      return;
    case "Import":
      if (node.bindings.length === 0) {
        const local = node.alias ?? node.path[0];
        if (local !== undefined) add(local, "module", node.span);
        return;
      }
      for (const binding of node.bindings) add(binding.local, "value", binding.span);
      return;
    default:
      return;
  }
}

function importsOf(program: SemanticProgram): ImportNode[] {
  return program.body.filter((node): node is ImportNode => node.kind === "Import");
}

function tarjan(
  nodes: readonly string[],
  successors: (id: string) => readonly string[],
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const open = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    open(root);
    const work = [{ node: root, next: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const children = successors(frame.node);
      if (frame.next < children.length) {
        const child = children[frame.next]!;
        frame.next++;
        if (!index.has(child)) {
          open(child);
          work.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      component.sort((left, right) => index.get(left)! - index.get(right)!);
      components.push(component);
    }
  }
  return components;
}

class ModuleLoader {
  private readonly resolver: ModuleResolver;
  private readonly fileSystem: ModuleFileSystem;
  private readonly parseSource: (source: string, name: string) => ASTNode;
  private readonly bySpec = new Map<string, MutableRecord>();
  private readonly byPath = new Map<string, MutableRecord>();
  private readonly queue: MutableRecord[] = [];
  private readonly entrySource: string | undefined;

  constructor(private readonly entryPath: string, options: ModuleGraphOptions) {
    this.fileSystem = options.fileSystem;
    this.resolver = new ModuleResolver({
      fileSystem: this.fileSystem,
      root: options.root ?? projectRootFor(this.fileSystem, entryPath),
      searchPaths: options.searchPaths,
      nativeModules: options.nativeModules,
    });
    this.parseSource = options.parseSource ?? ((source) => parse(source));
    this.entrySource = options.entrySource;
  }

  private resolveEntry(): ResolvedModule {
    if (this.entrySource === undefined) return this.resolver.resolveEntry(this.entryPath);
    return { spec: ENTRY_SPEC, path: this.fileSystem.resolve(this.entryPath), kind: "file" };
  }

  build(): ModuleGraph {
    const entry = this.intern(this.resolveEntry(), []);
    if (this.entrySource !== undefined) entry.source = this.entrySource;
    this.drain();
    while (this.linkSubmoduleBindings()) this.drain();
    return this.finish(entry);
  }

  private drain(): void {
    while (this.queue.length > 0) this.load(this.queue.shift()!);
  }

  private intern(resolved: ResolvedModule, chain: readonly string[]): MutableRecord {
    const existing = resolved.path === null
      ? this.bySpec.get(resolved.spec)
      : this.byPath.get(resolved.path);
    if (existing !== undefined) return existing;

    const record: MutableRecord = {
      spec: resolved.spec,
      path: resolved.path,
      kind: resolved.kind,
      source: "",
      ast: EMPTY_AST,
      program: { body: [] },
      bindings: new Map(),
      imports: [],
      chain: [...chain, resolved.spec],
      parsed: resolved.kind === "native" || resolved.kind === "namespace",
    };
    this.bySpec.set(record.spec, record);
    if (record.path !== null) this.byPath.set(record.path, record);
    if (!record.parsed) this.queue.push(record);
    return record;
  }

  private load(record: MutableRecord): void {
    if (record.parsed || record.path === null) return;
    record.parsed = true;
    if (record.source.length === 0) record.source = this.fileSystem.readFile(record.path);
    record.ast = this.parseSource(record.source, record.path);
    record.program = astToSemanticProgram(record.ast);
    record.bindings = bindingsOf(record.program);
    for (const node of importsOf(record.program)) {
      record.imports.push(this.resolveImport(node, record));
    }
  }

  private resolveImport(node: ImportNode, from: MutableRecord): ResolvedImport {
    const target = this.resolveModule(node, from);
    const root = this.resolvePackagePrefixes(node, from);
    if (node.bindings.length > 0) {
      return {
        module: target.spec,
        local: null,
        boundSpec: null,
        bindings: node.bindings.map((binding) => ({
          imported: binding.imported,
          local: binding.local,
          span: binding.span,
          module: target.spec,
          submodule: null,
        })),
        span: node.span,
      };
    }
    return {
      module: target.spec,
      local: node.alias ?? node.path[0] ?? null,
      boundSpec: node.alias === null ? root : target.spec,
      bindings: [],
      span: node.span,
    };
  }

  private resolveModule(node: ImportNode, from: MutableRecord): MutableRecord {
    const request = { level: node.level, path: node.path };
    try {
      return this.intern(this.resolver.resolve(request, from), from.chain);
    } catch (error) {
      if (!(error instanceof ModuleResolutionError)) throw error;
      throw new ModuleGraphError(`${error.message} at ${from.spec}:${node.span.line}`, from.chain);
    }
  }

  private resolvePackagePrefixes(node: ImportNode, from: MutableRecord): string | null {
    let root: string | null = null;
    for (let length = 1; length <= node.path.length; length++) {
      const prefix = { level: node.level, path: node.path.slice(0, length) };
      const resolved = this.resolver.tryResolve(prefix, from);
      if (resolved === null) continue;
      const record = this.intern(resolved, from.chain);
      if (root === null) root = record.spec;
    }
    return root;
  }

  private linkSubmoduleBindings(): boolean {
    for (const record of [...this.bySpec.values()]) {
      for (let at = 0; at < record.imports.length; at++) {
        const entry = record.imports[at]!;
        if (entry.bindings.length === 0) continue;
        const owner = this.bySpec.get(entry.module);
        if (owner === undefined) continue;
        const bindings = entry.bindings.map((binding) => {
          if (binding.submodule !== null) return binding;
          if (owner.bindings.has(binding.imported)) return binding;
          const submodule = this.resolveOwnedSubmodule(owner, binding.imported);
          if (submodule === null) return binding;
          this.intern(submodule, owner.chain);
          return { ...binding, submodule: submodule.spec };
        });
        record.imports[at] = { ...entry, bindings };
      }
    }
    return this.queue.length > 0;
  }

  private resolveOwnedSubmodule(owner: MutableRecord, name: string): ResolvedModule | null {
    if (owner.kind !== "package" && owner.kind !== "namespace") return null;
    return this.resolver.tryResolve({ level: 1, path: [name] }, owner);
  }

  private importEdges(): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    for (const record of this.bySpec.values()) {
      const targets: string[] = [];
      for (const entryImport of record.imports) {
        targets.push(entryImport.module);
        for (const binding of entryImport.bindings) {
          if (binding.submodule !== null) targets.push(binding.submodule);
        }
      }
      edges.set(record.spec, targets.filter((spec) => this.bySpec.has(spec)));
    }
    return edges;
  }

  private finish(entry: MutableRecord): ModuleGraph {
    const specs = [...this.bySpec.keys()];
    const importEdges = this.importEdges();
    const initEdges = new Map<string, string[]>();
    for (const [spec, targets] of importEdges) {
      const parent = parentSpec(spec);
      initEdges.set(
        spec,
        parent !== null && this.bySpec.has(parent) ? [...targets, parent] : targets,
      );
    }

    const modules = new Map<string, ModuleRecord>();
    for (const [spec, record] of this.bySpec) modules.set(spec, freeze(record));

    const runnable = (spec: string): ModuleRecord | null => {
      const record = modules.get(spec);
      if (record === undefined) return null;
      return record.kind === "native" || record.kind === "namespace" ? null : record;
    };

    const initOrder: ModuleRecord[] = [];
    for (const component of tarjan(specs, (spec) => initEdges.get(spec) ?? [])) {
      for (const spec of component) {
        const record = runnable(spec);
        if (record !== null) initOrder.push(record);
      }
    }

    const importComponents = tarjan(specs, (spec) => importEdges.get(spec) ?? []);
    const checkOrder: ModuleRecord[] = [];
    for (const component of importComponents) {
      for (const spec of component) {
        const record = runnable(spec);
        if (record !== null) checkOrder.push(record);
      }
    }

    const cycles = importComponents.filter(
      (component) =>
        component.length > 1 || (importEdges.get(component[0]!) ?? []).includes(component[0]!),
    );

    return { entry: modules.get(entry.spec)!, modules, initOrder, checkOrder, cycles };
  }
}

function freeze(record: MutableRecord): ModuleRecord {
  return {
    spec: record.spec,
    path: record.path,
    kind: record.kind,
    source: record.source,
    ast: record.ast,
    program: record.program,
    bindings: record.bindings,
    imports: record.imports,
  };
}

export function buildModuleGraph(entryPath: string, options: ModuleGraphOptions): ModuleGraph {
  return new ModuleLoader(entryPath, options).build();
}

export { ENTRY_SPEC };
