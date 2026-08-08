import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CFGFunction } from "../ir/index.js";
import type { AotBackend } from "../target/backend.js";
import { AnalysisManager, AnalysisRegistry } from "../infra/analysis-manager.js";
import { PassManager } from "../infra/pass-manager.js";
import { compilerOptions, type CompilerOptions } from "../options.js";

export interface AotCompiledFunction {
  readonly name: string;
  readonly symbol: string;
  readonly prototype: string;
  readonly definition: string;
}

export interface AotSkippedFunction {
  readonly name: string;
  readonly reason: string;
}

export interface AotProgram {
  readonly headerName: string;
  readonly header: string;
  readonly source: string;
  readonly compiled: readonly AotCompiledFunction[];
  readonly skipped: readonly AotSkippedFunction[];
}

export interface AotDriverOptions {
  readonly headerName?: string;
  readonly compilerOptions?: CompilerOptions;
}

const DEFAULT_HEADER_NAME = "program.h";

function includeGuard(headerName: string): string {
  const token = headerName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return /^[A-Z_]/.test(token) ? token : `H_${token}`;
}

function stripSourcePreamble(source: string, preamble: string): string {
  if (preamble.length === 0) return source;
  const prefix = `${preamble}\n\n`;
  return source.startsWith(prefix) ? source.slice(prefix.length) : source;
}

function joinSections(sections: Iterable<string>): string {
  return [...sections].filter((section) => section.length > 0).join("\n\n");
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compileProgram(
  graphs: Iterable<CFGFunction>,
  backend: AotBackend,
  options: AotDriverOptions = {},
): AotProgram {
  const headerName = options.headerName ?? DEFAULT_HEADER_NAME;
  const opts = options.compilerOptions ?? compilerOptions();
  const compiled: AotCompiledFunction[] = [];
  const skipped: AotSkippedFunction[] = [];
  const seenSymbols = new Set<string>();
  const headerPreambles = new Set<string>();
  const sourcePreambles = new Set<string>();

  for (const graph of graphs) {
    const analyses = new AnalysisManager<CFGFunction>(
      graph,
      new AnalysisRegistry<CFGFunction>(),
    );
    let artifact;
    try {
      new PassManager<CFGFunction>(analyses, opts).run(
        graph,
        backend.loweringPipeline(opts),
      );
      artifact = backend.createEmitter(graph, analyses).emit();
    } catch (error) {
      skipped.push({ name: graph.name, reason: reasonOf(error) });
      continue;
    }
    if (artifact.kind !== "c") {
      skipped.push({ name: graph.name, reason: `backend produced a ${artifact.kind} artifact` });
      continue;
    }
    if (seenSymbols.has(artifact.symbol)) {
      skipped.push({ name: graph.name, reason: `duplicate symbol ${artifact.symbol}` });
      continue;
    }
    seenSymbols.add(artifact.symbol);
    headerPreambles.add(artifact.headerPreamble);
    sourcePreambles.add(artifact.translationUnitPreamble);
    compiled.push({
      name: graph.name,
      symbol: artifact.symbol,
      prototype: artifact.prototype,
      definition: stripSourcePreamble(artifact.source, artifact.sourcePreamble),
    });
  }

  const guard = includeGuard(headerName);
  const prototypes = compiled.map((fn) => fn.prototype).join("\n");
  const headerPreamble = joinSections(headerPreambles);
  const sourcePreamble = joinSections(sourcePreambles);
  const header =
    `#ifndef ${guard}\n#define ${guard}\n\n` +
    (headerPreamble.length > 0 ? `${headerPreamble}\n\n` : "") +
    (prototypes.length > 0 ? `${prototypes}\n\n` : "") +
    `#endif\n`;
  const definitions = compiled.map((fn) => fn.definition).join("\n");
  const source = joinSections([
    `#include "${headerName}"`,
    sourcePreamble,
    definitions,
  ]);

  return { headerName, header, source, compiled, skipped };
}

export function writeAotProgram(
  program: AotProgram,
  outDir: string,
  sourceName = "program.c",
): { readonly headerPath: string; readonly sourcePath: string } {
  const headerPath = join(outDir, program.headerName);
  const sourcePath = join(outDir, sourceName);
  writeFileSync(headerPath, program.header);
  writeFileSync(sourcePath, program.source);
  return { headerPath, sourcePath };
}
