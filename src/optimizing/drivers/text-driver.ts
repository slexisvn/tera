import type { CFGFunction } from "../ir/index.js";
import { parseIR, printIR } from "../ir/text.js";
import { AnalysisManager } from "../infra/analysis-manager.js";
import { createAnalysisRegistry } from "../analyses/index.js";
import type { TransformPass } from "../infra/pass-manager.js";
import { remarks, type Remark } from "../infra/pass-remarks.js";
import { compilerOptions, type CompilerOptions } from "../options.js";
import { middleEndPipeline } from "../pipeline.js";
import { maintainGraph } from "../pipeline.js";

export class UnknownPassError extends Error {
  constructor(name: string) {
    super(`No middle-end pass named "${name}"`);
    this.name = "UnknownPassError";
  }
}

export type IRTransform = (
  graph: CFGFunction,
  analyses: AnalysisManager<CFGFunction>,
) => unknown;

export function analysesFor(graph: CFGFunction): AnalysisManager<CFGFunction> {
  return new AnalysisManager(graph, createAnalysisRegistry());
}

export function middleEndPassNames(
  options: CompilerOptions = compilerOptions(),
): readonly string[] {
  return middleEndPipeline(options).map((pass) => pass.name);
}

export function passByName(
  name: string,
  options: CompilerOptions = compilerOptions(),
): TransformPass<CFGFunction> | null {
  return middleEndPipeline(options).find((pass) => pass.name === name) ?? null;
}

export function afterPass(text: string, run: IRTransform): string {
  const graph = parseIR(text);
  run(graph, analysesFor(graph));
  graph.rebuildUses();
  return printIR(graph);
}

export interface NamedPassOutcome {
  readonly text: string;
  readonly changed: boolean;
  readonly remarks: readonly Remark[];
}

export function runNamedPass(
  text: string,
  name: string,
  options: CompilerOptions = compilerOptions(),
): NamedPassOutcome {
  const pass = passByName(name, options);
  if (pass === null) throw new UnknownPassError(name);
  let changed = false;
  let noted: readonly Remark[] = [];
  const printed = afterPass(text, (graph, analyses) => {
    remarks.open(name);
    try {
      changed = pass.run(graph, analyses, options).changed;
      if (changed) maintainGraph(graph);
    } finally {
      noted = remarks.close();
    }
  });
  return { text: printed, changed, remarks: noted };
}

export function afterNamedPass(
  text: string,
  name: string,
  options: CompilerOptions = compilerOptions(),
): string {
  return runNamedPass(text, name, options).text;
}
