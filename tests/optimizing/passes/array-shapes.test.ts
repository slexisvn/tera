import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irNewArray,
  irReturn,
  resetIRNodeIds,
  IR_NEW_ARRAY,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  buildClassTable,
  FIELD_TYPE_PROP,
  type ClassTable,
} from "../../../src/optimizing/metadata/class-table.js";
import { nominalLatticeType } from "../../../src/optimizing/types/declared.js";
import { SCALAR_INT32 } from "../../../src/optimizing/types/scalar.js";
import {
  arrayModelForDeclaredType,
  shapeArrayAllocations,
} from "../../../src/optimizing/passes/array-shapes.js";

beforeEach(() => resetIRNodeIds());

const table = (): ClassTable => buildClassTable([]);

describe("arrayModelForDeclaredType", () => {
  it("carries an int array's element as a scalar with no element shape", () => {
    const model = arrayModelForDeclaredType("int[]", table())!;

    expect(model.declaredType).toBe("int");
    expect(model.element).toBe(SCALAR_INT32);
    expect(model.elementShape).toBeNull();
  });

  it("names a nested array's element by the inner array type", () => {
    const model = arrayModelForDeclaredType("int[][]", table())!;

    expect(model.declaredType).toBe("int[]");
  });

  it("gives a nested array an element shape that is itself an array", () => {
    const classes = table();
    const model = arrayModelForDeclaredType("int[][]", classes)!;

    expect(model.elementShape).not.toBeNull();
    expect(classes.arrayLayoutOf(model.elementShape!)?.declaredType).toBe("int");
  });

  it("keeps two nesting depths apart", () => {
    const classes = table();
    const flat = arrayModelForDeclaredType("int[]", classes)!;
    const nested = arrayModelForDeclaredType("int[][]", classes)!;

    expect(nested.shape.name).not.toBe(flat.shape.name);
  });

  it("answers nothing for a type that is not an array", () => {
    expect(arrayModelForDeclaredType("int", table())).toBeNull();
  });
});

describe("ClassTable.defineArray", () => {
  it("takes the element name it is given over the one the lattice would answer", () => {
    const classes = table();
    const shape = classes.defineArray(nominalLatticeType("int[]", classes), "int[]")!;

    expect(classes.arrayLayoutOf(shape)?.declaredType).toBe("int[]");
  });

  it("falls back to the lattice name when it is given none", () => {
    const classes = table();
    const shape = classes.defineArray(nominalLatticeType("int", classes))!;

    expect(classes.arrayLayoutOf(shape)?.declaredType).toBe("int");
  });
});

describe("shapeArrayAllocations over nested literals", () => {
  function nestedLiteral(): { graph: CFGFunction; outer: CFGInstruction; inner: CFGInstruction } {
    const graph = new CFGFunction("grid");
    graph.declaredSignature = { params: [], returns: "int[][]" };
    graph.classes = table();
    const block = graph.addBlock();
    const one = block.addNode(irConstant(1));
    const two = block.addNode(irConstant(2));
    const inner = block.addNode(irNewArray([one, two]));
    const outer = block.addNode(irNewArray([inner]));
    block.addNode(irReturn(outer));
    graph.rebuildUses();
    return { graph, outer, inner };
  }

  const shape = (graph: CFGFunction): number =>
    shapeArrayAllocations(
      graph,
      new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    );

  it("shapes both the inner and the outer allocation", () => {
    const { graph } = nestedLiteral();

    expect(shape(graph)).toBe(2);
  });

  it("replaces every array literal with a shaped allocation", () => {
    const { graph } = nestedLiteral();
    shape(graph);

    const remaining = graph.blocks
      .flatMap((block) => block.nodes)
      .filter((node) => node.type === IR_NEW_ARRAY);
    expect(remaining).toEqual([]);
  });

  it("stores the inner elements as ints and the outer element as an int array", () => {
    const { graph } = nestedLiteral();
    shape(graph);

    const stored = new Set(
      graph.blocks
        .flatMap((block) => block.nodes)
        .map((node) => node.props[FIELD_TYPE_PROP])
        .filter((held): held is string => typeof held === "string"),
    );
    expect(stored).toContain("int");
    expect(stored).toContain("int[]");
  });
});
