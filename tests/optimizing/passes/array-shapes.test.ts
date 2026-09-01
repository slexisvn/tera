import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irGenericSetProp,
  irGenericGetIndex,
  irNewArray,
  irNewObject,
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
  CLASS_ID_PROP,
  FIELD_TYPE_PROP,
  INSTANCE_SIZE_PROP,
  literalShapeSurface,
  VALUE_CLASS_PROP,
  type ClassTable,
} from "../../../src/optimizing/metadata/class-table.js";
import { nominalLatticeType } from "../../../src/optimizing/types/declared.js";
import { SCALAR_INT32 } from "../../../src/optimizing/types/scalar.js";
import {
  arrayElementNameOf,
  arrayModelForDeclaredType,
  arrayModelOf,
  shapeArrayAllocations,
  stampElementTypes,
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

describe("shapeArrayAllocations over record literals that disagree", () => {
  function held(
    graph: CFGFunction,
    block: ReturnType<CFGFunction["addBlock"]>,
    declaredType: string,
    value: CFGInstruction,
  ): CFGInstruction {
    const shape = graph.classes!.defineSynthetic(
      literalShapeSurface([{ name: "h", declaredType }]),
    );
    const allocation = block.addNode(irNewObject());
    allocation.props[CLASS_ID_PROP] = shape.id;
    allocation.props[INSTANCE_SIZE_PROP] = shape.size;
    allocation.props[VALUE_CLASS_PROP] = shape.id;
    block.addNode(irGenericSetProp(allocation, "h", value));
    return allocation;
  }

  function mixedRecords(): { graph: CFGFunction; records: readonly CFGInstruction[] } {
    const graph = new CFGFunction("rows");
    graph.classes = table();
    const block = graph.addBlock();
    const whole = held(graph, block, "int", block.addNode(irConstant(38)));
    const fractional = held(graph, block, "float", block.addNode(irConstant(41.5)));
    block.addNode(irReturn(block.addNode(irNewArray([whole, fractional]))));
    graph.rebuildUses();
    return { graph, records: [whole, fractional] };
  }

  const shape = (graph: CFGFunction): number =>
    shapeArrayAllocations(
      graph,
      new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    );

  it("shapes the array holding records that name their field differently", () => {
    const { graph } = mixedRecords();

    expect(shape(graph)).toBe(1);
  });

  it("moves both records onto one shape so the array holds a single layout", () => {
    const { graph, records } = mixedRecords();
    shape(graph);

    const adopted = new Set(records.map((record) => record.props[VALUE_CLASS_PROP]));
    expect(adopted.size).toBe(1);
  });

  it("adopts the widened shape rather than either record's own", () => {
    const { graph, records } = mixedRecords();
    shape(graph);

    const adopted = graph.classes!.shapeById(records[0]!.props[VALUE_CLASS_PROP] as number)!;
    expect(adopted.fields.get("h")?.declaredType).toBe("float");
  });

  it("keeps each record's instance size in step with the shape it adopted", () => {
    const { graph, records } = mixedRecords();
    shape(graph);

    const adopted = graph.classes!.shapeById(records[0]!.props[VALUE_CLASS_PROP] as number)!;
    expect(records.map((record) => record.props[INSTANCE_SIZE_PROP])).toEqual([
      adopted.size,
      adopted.size,
    ]);
  });
});

describe("arrayModelOf over what an array method answers", () => {
  function answering(member: string): { graph: CFGFunction; call: CFGInstruction } {
    const graph = new CFGFunction("walk");
    graph.declaredSignature = { params: ["int[]"], returns: null };
    graph.classes = table();
    const xs = graph.addParameter(0);
    const block = graph.addBlock();
    const callee = block.addNode(irGenericGetProp(xs, member));
    const call = block.addNode(irGenericCall(callee, [xs]));
    call.props.isMethod = true;
    block.addNode(irReturn(call));
    graph.rebuildUses();
    return { graph, call };
  }

  const modelOf = (graph: CFGFunction, call: CFGInstruction) =>
    arrayModelOf(
      call,
      graph,
      graph.classes!,
      new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    );

  for (const member of ["concat", "slice", "filter", "reverse", "sort"]) {
    it(`carries the receiver's element through ${member}`, () => {
      const { graph, call } = answering(member);

      expect(modelOf(graph, call)?.declaredType).toBe("int");
    });
  }

  it("answers nothing for a member that need not hold the element type", () => {
    const { graph, call } = answering("map");

    expect(modelOf(graph, call)).toBeNull();
  });

  it("drops one level of nesting through flat", () => {
    const graph = new CFGFunction("walk");
    graph.declaredSignature = { params: ["int[][]"], returns: null };
    graph.classes = table();
    const rows = graph.addParameter(0);
    const block = graph.addBlock();
    const callee = block.addNode(irGenericGetProp(rows, "flat"));
    const call = block.addNode(irGenericCall(callee, [rows]));
    call.props.isMethod = true;
    block.addNode(irReturn(call));
    graph.rebuildUses();

    expect(modelOf(graph, call)?.declaredType).toBe("int");
  });
});

describe("naming what an array literal holds", () => {
  function literal(values: readonly (number | number[])[]): {
    graph: CFGFunction;
    array: CFGInstruction;
  } {
    const graph = new CFGFunction("held");
    graph.classes = table();
    const block = graph.addBlock();
    const elements = values.map((value) =>
      Array.isArray(value)
        ? block.addNode(irNewArray(value.map((held) => block.addNode(irConstant(held)))))
        : block.addNode(irConstant(value)),
    );
    const array = block.addNode(irNewArray(elements));
    block.addNode(irReturn(array));
    graph.rebuildUses();
    return { graph, array };
  }

  const named = (graph: CFGFunction, array: CFGInstruction) =>
    arrayElementNameOf(
      array,
      graph,
      graph.classes!,
      new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    );

  it("names the element of a flat literal", () => {
    const { graph, array } = literal([1, 2]);

    expect(named(graph, array)).toBe("int");
  });

  it("answers nothing rather than a bare array name for a nested literal", () => {
    const { graph, array } = literal([[1], [2]]);

    expect(named(graph, array)).toBeNull();
  });

  it("leaves an element read unstamped while its element has no name", () => {
    const { graph, array } = literal([[1], [2]]);
    const block = graph.blocks[0]!;
    const read = block.addNode(irGenericGetIndex(array, block.addNode(irConstant(0))));
    graph.rebuildUses();

    stampElementTypes(
      graph,
      new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    );

    expect(read.props[FIELD_TYPE_PROP]).toBeUndefined();
  });

  it("stamps an element read once its element can be named", () => {
    const { graph, array } = literal([1, 2]);
    const block = graph.blocks[0]!;
    const read = block.addNode(irGenericGetIndex(array, block.addNode(irConstant(0))));
    graph.rebuildUses();

    stampElementTypes(
      graph,
      new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    );

    expect(read.props[FIELD_TYPE_PROP]).toBe("int");
  });
});
