import * as ir from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import {
  latticeFromDeclaredType,
  nominalLatticeType,
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
} from "../ir/operations.js";
import type { ClassCallableKind } from "../../core/class-member.js";

const GETTER_CALLABLE: ClassCallableKind = "getter";

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
  private readonly types = new Map<ir.CFGInstruction, LatticeType>();
  private readonly speculative = new Set<ir.CFGInstruction>();
  private readonly seeded = new Set<ir.CFGInstruction>();
  private readonly queued = new Set<ir.CFGInstruction>();
  private readonly worklist: ir.CFGInstruction[] = [];

  constructor(private readonly graph: ir.CFGFunction) {
    this.seedParameters();
    this.solve();
  }

  typeOf(value: ir.CFGInstruction): LatticeType {
    return this.types.get(value) ?? BOTTOM;
  }

  isSpeculative(value: ir.CFGInstruction): boolean {
    return this.speculative.has(value);
  }

  returnTypeOf(node: ir.CFGInstruction): LatticeType {
    const signature = returnSignatureOf(node);
    return signature === null ? TOP : nominalLatticeType(signature.returns, this.graph.classes);
  }

  private seedParameters(): void {
    const signature = this.graph.declaredSignature ?? null;
    for (const param of this.graph.parameters) {
      const index = Number(param.props.index);
      const declared = signature === null ? null : signature.params[index] ?? null;
      this.types.set(param, nominalLatticeType(declared, this.graph.classes));
      this.seeded.add(param);
    }
  }

  private enqueue(value: ir.CFGInstruction): void {
    if (this.seeded.has(value) || this.queued.has(value)) return;
    this.queued.add(value);
    this.worklist.push(value);
  }

  private solve(): void {
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) this.enqueue(node);
    }

    while (this.worklist.length > 0) {
      const node = this.worklist.pop()!;
      this.queued.delete(node);
      const previous = this.typeOf(node);
      const next = joinTypes(previous, this.evaluate(node));
      const grew = !typeEquals(previous, next);
      if (grew) this.types.set(node, next);
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
    if (this.speculative.has(node)) return false;
    const tainted =
      SPECULATIVE_SOURCES.has(node.type) ||
      node.inputs.some((input) => this.speculative.has(input));
    if (!tainted) return false;
    this.speculative.add(node);
    return true;
  }

  declaredTypeOf(declared: string): LatticeType {
    return nominalLatticeType(declared, this.graph.classes);
  }

  memberTypeOf(receiver: LatticeType, name: string): LatticeType | null {
    const classes = this.graph.classes;
    if (classes === null) return null;
    if (receiver.kind !== TypeKind.Object || typeof receiver.map !== "number") return null;
    const shape = classes.shapeById(receiver.map);
    if (shape === null) return null;
    const field = shape.fields.get(name);
    if (field !== undefined) return nominalLatticeType(field.declaredType, classes);
    const getter = shape.callables.get(GETTER_CALLABLE)?.get(name);
    return getter === undefined ? null : nominalLatticeType(getter.signature.returns, classes);
  }

  private evaluate(node: ir.CFGInstruction): LatticeType {
    if (node.type === ir.IR_PHI) return transferType(node, this);
    for (const input of node.inputs) {
      if (this.typeOf(input).kind === TypeKind.Never) return BOTTOM;
    }
    return transferType(node, this);
  }
}

export function inferTypes(graph: ir.CFGFunction): TypeInference {
  return new TypeSolver(graph);
}

export const typeInferenceAnalysis: AnalysisPass<ir.CFGFunction, TypeInference> = {
  id: typeInferenceAnalysisId,
  run: inferTypes,
};
