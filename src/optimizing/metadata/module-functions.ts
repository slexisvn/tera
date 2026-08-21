import {
  IR_CONSTANT,
  IR_LOAD_GLOBAL,
  IR_STORE_GLOBAL,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import type { CompilationUnit, ModuleIR } from "../compilation-unit.js";

export const FUNCTION_TARGET_PROP = "functionTarget";

export function functionTargetOf(value: CFGInstruction): string | null {
  const name = value.props[FUNCTION_TARGET_PROP];
  return typeof name === "string" ? name : null;
}

export class ModuleFunctions {
  private readonly byTarget = new Map<RegisterCompiledFunction, CFGFunction>();
  private readonly byName = new Map<string, CFGFunction>();
  private readonly units = new Map<CFGFunction, CompilationUnit>();
  private readonly reassigned = new Set<string>();

  constructor(module: ModuleIR) {
    for (const unit of module.units) {
      this.units.set(unit.graph, unit);
      this.byName.set(unit.graph.name, unit.graph);
      if (unit.compiledFunction !== null) this.byTarget.set(unit.compiledFunction, unit.graph);
    }
    for (const unit of module.units) {
      for (const block of unit.graph.blocks) {
        for (const node of block.nodes) {
          if (node.type !== IR_STORE_GLOBAL) continue;
          const name = node.props.name;
          if (typeof name === "string") this.reassigned.add(name);
        }
      }
    }
  }

  unitOf(graph: CFGFunction): CompilationUnit | undefined {
    return this.units.get(graph);
  }

  named(name: string): CFGFunction | null {
    return this.byName.get(name) ?? null;
  }

  referenced(value: CFGInstruction | undefined): CFGFunction | null {
    if (value === undefined) return null;
    if (value.type === IR_CONSTANT) {
      const compiled = compiledFunctionConstant(value.props.value);
      return compiled === null ? null : this.byTarget.get(compiled) ?? null;
    }
    if (value.type !== IR_LOAD_GLOBAL) return null;
    const name = value.props.name;
    if (typeof name !== "string" || this.reassigned.has(name)) return null;
    return this.byName.get(name) ?? null;
  }
}
