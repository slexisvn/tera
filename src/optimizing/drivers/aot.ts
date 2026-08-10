import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  IR_CALL_KNOWN_FUNCTION,
  type CFGFunction,
  type IRMetadataValue,
} from "../ir/index.js";
import type { DeclaredSignature } from "../types/signature.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import type { AotBackend, LinkableFunction } from "../target/backend.js";
import type { AotOutputFile } from "../target/artifact.js";
import { isBackendLoweringError } from "../target/errors.js";
import { AnalysisManager } from "../infra/analysis-manager.js";
import { PassManager } from "../infra/pass-manager.js";
import { compilerOptions, type CompilerOptions } from "../options.js";
import { cfgPassTracer, maintainGraph } from "../pipeline.js";
import { createAnalysisRegistry } from "../analyses/index.js";
import type { ModuleIR } from "../compilation-unit.js";

export interface AotSkippedFunction {
  readonly name: string;
  readonly reason: string;
}

export interface AotProgram {
  readonly files: readonly AotOutputFile[];
  readonly compiled: readonly LinkableFunction[];
  readonly skipped: readonly AotSkippedFunction[];
}

export interface AotDriverOptions {
  readonly moduleName?: string;
  readonly compilerOptions?: CompilerOptions;
}

const DEFAULT_MODULE_NAME = "program";

function dropUnresolvedCallers(
  compiled: readonly LinkableFunction[],
  skipped: AotSkippedFunction[],
): LinkableFunction[] {
  const defined = new Set(compiled.map((fn) => fn.emitted.symbol));
  const callers = new Map<string, LinkableFunction[]>();
  for (const fn of compiled) {
    for (const reference of fn.emitted.references) {
      let group = callers.get(reference);
      if (group === undefined) {
        group = [];
        callers.set(reference, group);
      }
      group.push(fn);
    }
  }

  const dropped = new Set<string>();
  const worklist: LinkableFunction[] = [];
  const drop = (fn: LinkableFunction, missing: string): void => {
    if (dropped.has(fn.emitted.symbol)) return;
    dropped.add(fn.emitted.symbol);
    skipped.push({ name: fn.name, reason: `calls unavailable function ${missing}` });
    worklist.push(fn);
  };

  for (const fn of compiled) {
    for (const reference of fn.emitted.references) {
      if (!defined.has(reference)) drop(fn, reference);
    }
  }
  while (worklist.length > 0) {
    const fn = worklist.pop()!;
    for (const caller of callers.get(fn.emitted.symbol) ?? []) drop(caller, fn.emitted.symbol);
  }

  return compiled.filter((fn) => !dropped.has(fn.emitted.symbol));
}

interface CallTarget {
  readonly name?: unknown;
  readonly declaredSignature?: DeclaredSignature | null;
}

function moduleSignatures(module: ModuleIR): Map<string, DeclaredSignature> {
  const signatures = new Map<string, DeclaredSignature>();
  for (const unit of module.units) {
    const declared = unit.graph.declaredSignature;
    if (declared !== null) signatures.set(unit.graph.name, declared);
  }
  return signatures;
}

function stampCalleeSignatures(
  graph: CFGFunction,
  signatures: ReadonlyMap<string, DeclaredSignature>,
): number {
  let resolved = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_CALL_KNOWN_FUNCTION) continue;
      const target = node.props.target as CallTarget | undefined;
      if (target === undefined || typeof target.name !== "string") continue;
      if (target.declaredSignature !== undefined && target.declaredSignature !== null) {
        continue;
      }
      const declared = signatures.get(target.name);
      if (declared === undefined) continue;
      const stamped: CallTarget = { ...target, declaredSignature: declared };
      node.props.target = stamped as unknown as IRMetadataValue;
      resolved++;
    }
  }
  return resolved;
}

export function compileModule(
  module: ModuleIR,
  backend: AotBackend,
  options: AotDriverOptions = {},
): AotProgram {
  const signatures = moduleSignatures(module);
  const moduleName = options.moduleName ?? DEFAULT_MODULE_NAME;
  const opts = options.compilerOptions ?? compilerOptions();
  const compiled: LinkableFunction[] = [];
  const skipped: AotSkippedFunction[] = [];
  const seenSymbols = new Set<string>();

  for (const unit of module.units) {
    const graph = unit.graph;
    const analyses =
      unit.analyses ?? new AnalysisManager<CFGFunction>(graph, createAnalysisRegistry());
    let emitted;
    try {
      new PassManager<CFGFunction>(analyses, opts, cfgPassTracer(opts), maintainGraph).run(
        graph,
        backend.loweringPipeline(opts),
      );
      if (stampCalleeSignatures(graph, signatures) > 0) {
        analyses.invalidate(typeInferenceAnalysisId);
      }
      emitted = backend.createEmitter(graph, analyses).emit();
    } catch (error) {
      if (!isBackendLoweringError(error)) throw error;
      skipped.push({ name: graph.name, reason: error.message });
      continue;
    }
    if (seenSymbols.has(emitted.symbol)) {
      skipped.push({ name: graph.name, reason: `duplicate symbol ${emitted.symbol}` });
      continue;
    }
    seenSymbols.add(emitted.symbol);
    compiled.push({ name: graph.name, emitted });
  }

  const linkable = dropUnresolvedCallers(compiled, skipped);
  return {
    files: backend.link(linkable, { moduleName }),
    compiled: linkable,
    skipped,
  };
}

export function writeAotProgram(program: AotProgram, outDir: string): readonly string[] {
  const written: string[] = [];
  for (const file of program.files) {
    const path = join(outDir, file.name);
    writeFileSync(path, file.contents);
    written.push(path);
  }
  return written;
}
