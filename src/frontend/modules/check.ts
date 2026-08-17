import { checkProgram, type BindOptions, type Diagnostic, type TypecheckMode } from "../checker/index.js";
import type { SemanticNode } from "../checker/semantic-ast.js";
import type { ModuleGraph, ModuleRecord, ResolvedImport } from "./graph.js";
import {
  classSurfacesOf,
  importedSurface,
  moduleInterfaceOf,
  type ClassSurface,
  type ModuleInterface,
} from "./interface.js";
import { isNativeSpec, nativeName } from "./resolver.js";

export type ModuleDiagnostic = Diagnostic & {
  module: string;
  path: string | null;
};

export type ModuleCheckOptions = BindOptions & {
  mode?: TypecheckMode;
  nativeInterfaces?: ReadonlyMap<string, ModuleInterface>;
  collectClasses?: boolean;
};

export type ModuleCheckResult = {
  diagnostics: readonly ModuleDiagnostic[];
  interfaces: ReadonlyMap<string, ModuleInterface>;
  classes: readonly ClassSurface[];
};

const SUGGESTION_DISTANCE = 3;

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, at) => at);
  const current = new Array<number>(right.length + 1).fill(0);
  for (let row = 1; row <= left.length; row++) {
    current[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

const exportedNames = new WeakMap<object, string[]>();

function exportedNamesOf(owner: ModuleRecord): string[] {
  let names = exportedNames.get(owner);
  if (names === undefined) {
    names = [];
    for (const entry of owner.bindings.values()) {
      if (entry.exported) names.push(entry.name);
    }
    exportedNames.set(owner, names);
  }
  return names;
}

function nearestName(target: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = SUGGESTION_DISTANCE;
  for (const candidate of candidates) {
    const distance = editDistance(target.toLowerCase(), candidate.toLowerCase());
    if (distance >= bestDistance) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

function moduleLabel(spec: string): string {
  return isNativeSpec(spec) ? nativeName(spec) : spec;
}

function importedLocals(imports: readonly ResolvedImport[]): Map<string, ResolvedImport> {
  const locals = new Map<string, ResolvedImport>();
  for (const entry of imports) {
    if (entry.local !== null) locals.set(entry.local, entry);
    for (const binding of entry.bindings) locals.set(binding.local, entry);
  }
  return locals;
}

function assignedTopLevelNames(node: SemanticNode): Array<{ name: string; line: number; column: number }> {
  if (node.kind === "Var") {
    return [{ name: node.name, line: node.nameSpan.line, column: node.nameSpan.column }];
  }
  if (node.kind === "Destructure") {
    return node.names.map((name, at) => ({
      name,
      line: (node.variableSpans[at] ?? node.span).line,
      column: (node.variableSpans[at] ?? node.span).column,
    }));
  }
  return [];
}

class ModuleChecker {
  private readonly diagnostics: ModuleDiagnostic[] = [];
  private readonly interfaces = new Map<string, ModuleInterface>();

  constructor(
    private readonly graph: ModuleGraph,
    private readonly options: ModuleCheckOptions,
  ) {
    for (const [spec, surface] of options.nativeInterfaces ?? []) this.interfaces.set(spec, surface);
  }

  run(): ModuleCheckResult {
    const collectClasses = this.options.collectClasses === true;
    const silent = this.options.mode === "off";
    const mode = silent && collectClasses ? "warn" : this.options.mode;
    const classes: ClassSurface[] = [];

    for (const record of this.graph.checkOrder) {
      this.checkImports(record);
      this.checkImportAssignments(record);
      const { diagnostics, bound } = checkProgram(record.program, {
        mode,
        builtins: this.options.builtins,
        aliases: this.options.aliases,
        interfaces: this.options.interfaces,
        imports: importedSurface(record.imports, this.interfaces),
      });
      if (!silent) for (const diagnostic of diagnostics) this.report(record, diagnostic);
      this.interfaces.set(record.spec, moduleInterfaceOf(record, bound));
      if (collectClasses) classes.push(...classSurfacesOf(bound));
    }
    return { diagnostics: this.diagnostics, interfaces: this.interfaces, classes };
  }

  private report(record: ModuleRecord, diagnostic: Diagnostic): void {
    this.diagnostics.push({ ...diagnostic, module: record.spec, path: record.path });
  }

  private error(record: ModuleRecord, line: number, column: number, message: string): void {
    this.report(record, { line, column, message, severity: "error" });
  }

  private checkImports(record: ModuleRecord): void {
    for (const entry of record.imports) {
      const owner = this.graph.modules.get(entry.module);
      if (owner === undefined) continue;
      if (owner.kind === "native") {
        this.checkNativeImport(record, entry);
        continue;
      }
      for (const binding of entry.bindings) {
        if (binding.submodule !== null) continue;
        const declared = owner.bindings.get(binding.imported);
        if (declared === undefined) {
          const suggestion = nearestName(binding.imported, exportedNamesOf(owner));
          this.error(
            record,
            binding.span.line,
            binding.span.column,
            `Module '${moduleLabel(entry.module)}' has no export '${binding.imported}'` +
              (suggestion === null ? "" : `; did you mean '${suggestion}'?`),
          );
          continue;
        }
        if (!declared.exported) {
          this.error(
            record,
            binding.span.line,
            binding.span.column,
            `'${binding.imported}' is private to module '${moduleLabel(entry.module)}'`,
          );
        }
      }
    }
  }

  private checkNativeImport(record: ModuleRecord, entry: ResolvedImport): void {
    const surface = this.options.nativeInterfaces?.get(entry.module);
    if (surface === undefined) return;
    const exported = new Set<string>();
    for (const spec of surface.builtins ?? []) exported.add(spec.name);
    for (const value of surface.values ?? []) exported.add(value.name);
    for (const alias of surface.aliases ?? []) exported.add(alias.name);
    for (const shape of surface.interfaces ?? []) exported.add(shape.name);
    for (const binding of entry.bindings) {
      if (exported.has(binding.imported)) continue;
      const suggestion = nearestName(binding.imported, exported);
      this.error(
        record,
        binding.span.line,
        binding.span.column,
        `Module '${moduleLabel(entry.module)}' has no export '${binding.imported}'` +
          (suggestion === null ? "" : `; did you mean '${suggestion}'?`),
      );
    }
  }

  private checkImportAssignments(record: ModuleRecord): void {
    const locals = importedLocals(record.imports);
    if (locals.size === 0) return;
    for (const node of record.program.body) {
      for (const assigned of assignedTopLevelNames(node)) {
        if (!locals.has(assigned.name)) continue;
        this.error(
          record,
          assigned.line,
          assigned.column,
          `Cannot assign to imported binding '${assigned.name}'`,
        );
      }
    }
  }
}

export function checkModuleGraph(
  graph: ModuleGraph,
  options: ModuleCheckOptions = {},
): ModuleCheckResult {
  return new ModuleChecker(graph, options).run();
}
