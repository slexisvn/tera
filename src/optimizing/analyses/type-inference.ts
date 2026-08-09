import * as ir from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import {
  latticeFromDeclaredType,
  type DeclaredSignature,
} from "../types/declared.js";
import {
  anyType,
  joinTypes,
  neverType,
  typeEquals,
  TypeKind,
  type LatticeType,
} from "../types/lattice.js";
import {
  storedElementValue,
  transferType,
  type TypeContext,
} from "../types/transfer.js";

export interface TypeInference {
  typeOf(value: ir.CFGInstruction): LatticeType;
  isSpeculative(value: ir.CFGInstruction): boolean;
}

const SPECULATIVE_SOURCES = new Set<string>([
  ir.IR_CHECK_SMI,
  ir.IR_CHECK_NUMBER,
  ir.IR_CHECK_MAP,
  ir.IR_CHECK_ARRAY,
  ir.IR_CHECK_ELEMENTS_KIND,
  ir.IR_CHECK_BOUNDS,
  ir.IR_CHECK_CALL_TARGET,
]);

export const typeInferenceAnalysisId = analysisId<TypeInference>("type-inference");

const BOTTOM = neverType();
const TOP = anyType();

function returnSignatureOf(node: ir.CFGInstruction): DeclaredSignature | null {
  const target = node.props.target as { declaredSignature?: DeclaredSignature } | undefined;
  return target?.declaredSignature ?? null;
}

class TypeSolver implements TypeInference, TypeContext {
  private readonly types = new Map<number, LatticeType>();
  private readonly speculative = new Set<number>();
  private readonly seeded = new Set<number>();
  private readonly queued = new Set<number>();
  private readonly worklist: ir.CFGInstruction[] = [];

  constructor(private readonly graph: ir.CFGFunction) {
    this.seedParameters();
    this.solve();
  }

  typeOf(value: ir.CFGInstruction): LatticeType {
    return this.types.get(value.id) ?? BOTTOM;
  }

  isSpeculative(value: ir.CFGInstruction): boolean {
    return this.speculative.has(value.id);
  }

  returnTypeOf(node: ir.CFGInstruction): LatticeType {
    const signature = returnSignatureOf(node);
    return signature === null ? TOP : latticeFromDeclaredType(signature.returns);
  }

  private seedParameters(): void {
    const signature = this.graph.declaredSignature ?? null;
    for (const param of this.graph.parameters) {
      const index = Number(param.props.index);
      const declared = signature === null ? null : signature.params[index] ?? null;
      this.types.set(param.id, latticeFromDeclaredType(declared));
      this.seeded.add(param.id);
    }
  }

  private enqueue(value: ir.CFGInstruction): void {
    if (this.seeded.has(value.id) || this.queued.has(value.id)) return;
    this.queued.add(value.id);
    this.worklist.push(value);
  }

  private solve(): void {
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) this.enqueue(node);
    }

    while (this.worklist.length > 0) {
      const node = this.worklist.pop()!;
      this.queued.delete(node.id);
      const previous = this.typeOf(node);
      const next = joinTypes(previous, this.evaluate(node));
      const grew = !typeEquals(previous, next);
      if (grew) this.types.set(node.id, next);
      if (!this.propagateSpeculation(node) && !grew) continue;
      for (const observer of this.observersOf(node)) this.enqueue(observer);
    }
  }

  private observersOf(node: ir.CFGInstruction): ir.CFGInstruction[] {
    const observers: ir.CFGInstruction[] = [];
    for (const use of node.uses) {
      observers.push(use);
      const array = use.inputs[0];
      if (array !== undefined && storedElementValue(use, array) === node) {
        observers.push(array);
      }
    }
    return observers;
  }

  private propagateSpeculation(node: ir.CFGInstruction): boolean {
    if (this.speculative.has(node.id)) return false;
    const tainted =
      SPECULATIVE_SOURCES.has(node.type) ||
      node.inputs.some((input) => this.speculative.has(input.id));
    if (!tainted) return false;
    this.speculative.add(node.id);
    return true;
  }

  private evaluate(node: ir.CFGInstruction): LatticeType {
    if (node.type === ir.IR_PHI) return transferType(node, this);
    for (const input of node.inputs) {
      if (this.typeOf(input).kind === TypeKind.Never) return BOTTOM;
    }
    return transferType(node, this);
  }
}

export const typeInferenceAnalysis: AnalysisPass<ir.CFGFunction, TypeInference> = {
  id: typeInferenceAnalysisId,
  run: (graph) => new TypeSolver(graph),
};
