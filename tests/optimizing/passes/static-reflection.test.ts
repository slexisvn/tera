import { beforeEach, describe, expect, it } from "vitest";
import { foldStaticReflection } from "../../../src/optimizing/passes/static-reflection.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  CFGFunction,
  IRNode,
  IR_CONSTANT,
  IR_GENERIC_INSTANCEOF,
  IR_INT32_COMPARE,
  IR_LOAD_FIELD,
  IR_TYPEOF,
  irConstant,
  irGenericInstanceof,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import {
  buildClassTable,
  CLASS_SHAPE_ID_OFFSET,
  type ClassTable,
} from "../../../src/optimizing/metadata/class-table.js";
import type {
  ClassMemberSurface,
  ClassSurface,
} from "../../../src/frontend/modules/interface.js";

beforeEach(() => resetIRNodeIds());

function method(name: string, owner: string): ClassMemberSurface {
  return {
    name,
    declaredType: "() -> float",
    member: "method",
    owner,
    abstract: false,
    visibility: "public",
    static: false,
  };
}

function classSurface(
  name: string,
  members: readonly string[],
  parent: string | null = null,
): ClassSurface {
  return {
    name,
    parent,
    abstract: false,
    members: members.map((member) => method(member, name)),
    constructorParams: [],
    constructorParamNames: [],
  };
}

const SHAPES: readonly ClassSurface[] = [
  classSurface("Shape", ["area"]),
  classSurface("Circle", ["area", "radius"], "Shape"),
  classSurface("Unit", ["area", "radius"], "Circle"),
  classSurface("Square", ["area"], "Shape"),
  classSurface("Blob", ["tag"]),
];

const classes = (): ClassTable => buildClassTable(SHAPES);

function typeOfNode(value: CFGInstruction): CFGInstruction {
  const node = new IRNode(IR_TYPEOF, {}) as unknown as CFGInstruction;
  node.addInput(value);
  return node;
}

interface Fold {
  readonly graph: CFGFunction;
  readonly folded: number;
  readonly returned: CFGInstruction | undefined;
  readonly nodes: readonly CFGInstruction[];
}

function fold(build: (graph: CFGFunction) => CFGInstruction, declared?: string[]): Fold {
  const graph = new CFGFunction("f");
  graph.classes = classes();
  if (declared !== undefined) {
    graph.declaredSignature = { params: declared, returns: null };
    declared.forEach((_, index) => graph.addParameter(index));
  }
  const block = graph.addBlock();
  const value = build(graph);
  block.addNode(irReturn(value));
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  const folded = foldStaticReflection(graph, analyses.get(typeInferenceAnalysisId));
  const nodes = graph.blocks.flatMap((entry) => entry.nodes);
  const terminator = nodes.find((node) => node.inputs.length === 1 && node.type === "Return");
  return { graph, folded, returned: terminator?.inputs[0], nodes };
}

function typeofOf(declared: string): Fold {
  return fold((graph) => {
    const node = typeOfNode(graph.parameters[0]!);
    graph.blocks[0]!.addNode(node);
    return node;
  }, [declared]);
}

function instanceofOf(subject: string, target: string): Fold {
  return fold((graph) => {
    const block = graph.blocks[0]!;
    const constructorValue = irLoadGlobal(target);
    block.addNode(constructorValue);
    const node = irGenericInstanceof(graph.parameters[0]!, constructorValue);
    block.addNode(node);
    return node;
  }, [subject]);
}

const constantValue = (node: CFGInstruction | undefined) =>
  node?.type === IR_CONSTANT ? node.props.value : undefined;

const remaining = (result: Fold, type: string) =>
  result.nodes.filter((node) => node.type === type).length;

describe("typeof folding", () => {
  it("spells out the type of an int", () => {
    const result = typeofOf("int");

    expect(constantValue(result.returned)).toBe("number");
  });

  it("spells out the type of a float", () => {
    expect(constantValue(typeofOf("float").returned)).toBe("number");
  });

  it("spells out the type of a string", () => {
    expect(constantValue(typeofOf("string").returned)).toBe("string");
  });

  it("spells out the type of a bool", () => {
    expect(constantValue(typeofOf("bool").returned)).toBe("boolean");
  });

  it("spells out the type of a class instance", () => {
    expect(constantValue(typeofOf("Circle").returned)).toBe("object");
  });

  it("leaves the opcode in place when the type is not settled", () => {
    const result = typeofOf("any");

    expect(remaining(result, IR_TYPEOF)).toBe(1);
    expect(result.folded).toBe(0);
  });

  it("removes the opcode once it is answered", () => {
    expect(remaining(typeofOf("int"), IR_TYPEOF)).toBe(0);
  });
});

describe("instanceof folding", () => {
  it("answers true when the subject is the target class", () => {
    expect(constantValue(instanceofOf("Circle", "Circle").returned)).toBe(true);
  });

  it("answers true when the subject descends from the target", () => {
    expect(constantValue(instanceofOf("Circle", "Shape").returned)).toBe(true);
  });

  it("answers true through a whole chain of parents", () => {
    expect(constantValue(instanceofOf("Unit", "Shape").returned)).toBe(true);
  });

  it("answers false for a sibling class", () => {
    expect(constantValue(instanceofOf("Circle", "Square").returned)).toBe(false);
  });

  it("answers false for an unrelated class", () => {
    expect(constantValue(instanceofOf("Blob", "Shape").returned)).toBe(false);
  });

  it("tests the shape at run time when the subject may or may not match", () => {
    const result = instanceofOf("Shape", "Circle");

    expect(constantValue(result.returned)).toBeUndefined();
    expect(remaining(result, IR_INT32_COMPARE)).toBeGreaterThan(0);
  });

  it("reads the shape id from the subject when it tests at run time", () => {
    const result = instanceofOf("Shape", "Circle");
    const loads = result.nodes.filter(
      (node) => node.type === IR_LOAD_FIELD && Number(node.props.offset) === CLASS_SHAPE_ID_OFFSET,
    );

    expect(loads).toHaveLength(1);
  });

  it("compares against every descendant the subject could hold", () => {
    const result = instanceofOf("Shape", "Circle");
    const table = classes();
    const expected = [table.shapeOf("Circle")!.id, table.shapeOf("Unit")!.id].sort();
    const compared = result.nodes
      .filter((node) => node.type === IR_INT32_COMPARE)
      .flatMap((node) => node.inputs.filter((input) => input.type === IR_CONSTANT))
      .map((node) => Number(node.props.value))
      .sort();

    expect(compared).toEqual(expected);
  });

  it("removes the opcode whether it answered statically or at run time", () => {
    expect(remaining(instanceofOf("Circle", "Shape"), IR_GENERIC_INSTANCEOF)).toBe(0);
    expect(remaining(instanceofOf("Shape", "Circle"), IR_GENERIC_INSTANCEOF)).toBe(0);
  });

  it("keeps the subject alive so the run-time test can read its shape", () => {
    const result = instanceofOf("Shape", "Circle");

    expect(result.graph.parameters[0]!.uses.length).toBeGreaterThan(0);
  });

  it("leaves the opcode in place when the subject class is unknown", () => {
    const result = instanceofOf("any", "Circle");

    expect(remaining(result, IR_GENERIC_INSTANCEOF)).toBe(1);
    expect(result.folded).toBe(0);
  });

  it("leaves the opcode in place when the target names no class", () => {
    const result = instanceofOf("Circle", "Missing");

    expect(remaining(result, IR_GENERIC_INSTANCEOF)).toBe(1);
    expect(result.folded).toBe(0);
  });

  it("drops the global load once the class it named is answered", () => {
    const result = instanceofOf("Circle", "Shape");

    expect(remaining(result, "LoadGlobal")).toBe(0);
  });

  it("does nothing without a class table", () => {
    const graph = new CFGFunction("f");
    graph.declaredSignature = { params: ["Circle"], returns: null };
    graph.addParameter(0);
    const block = graph.addBlock();
    const constructorValue = irLoadGlobal("Shape");
    block.addNode(constructorValue);
    const node = irGenericInstanceof(graph.parameters[0]!, constructorValue);
    block.addNode(node);
    block.addNode(irReturn(node));
    graph.rebuildUses();
    const analyses = new AnalysisManager(graph, createAnalysisRegistry());

    expect(foldStaticReflection(graph, analyses.get(typeInferenceAnalysisId))).toBe(0);
  });
});

describe("folding count", () => {
  it("reports how many reflections it answered", () => {
    expect(typeofOf("int").folded).toBe(1);
    expect(instanceofOf("Circle", "Shape").folded).toBe(1);
  });
});

describe("unrelated graphs", () => {
  it("leaves a graph without reflection alone", () => {
    const result = fold((graph) => {
      const value = irConstant(1);
      graph.blocks[0]!.addNode(value);
      return value;
    });

    expect(result.folded).toBe(0);
  });
});
