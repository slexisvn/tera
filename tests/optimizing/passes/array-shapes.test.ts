import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irGenericSetProp,
  irGenericGetIndex,
  irGenericSetIndex,
  irJump,
  irNewArray,
  irNewObject,
  irReturn,
  resetIRNodeIds,
  IR_NEW_ARRAY,
  type CFGBlock,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  buildClassTable,
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  INSTANCE_SIZE_PROP,
  literalShapeSurface,
  VALUE_CLASS_PROP,
  type ClassTable,
} from "../../../src/optimizing/metadata/class-table.js";
import { nominalLatticeType } from "../../../src/optimizing/types/declared.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  type AotScalar,
} from "../../../src/optimizing/types/scalar.js";
import {
  arrayElementNameOf,
  arrayElementNamingOf,
  arrayModelForDeclaredType,
  arrayModelOf,
  producedTypeName,
  shapeArrayAllocations,
  stampElementTypes,
} from "../../../src/optimizing/passes/array-shapes.js";

beforeEach(() => resetIRNodeIds());

const table = (): ClassTable => buildClassTable([]);

const inferred = (graph: CFGFunction) =>
  new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId);

const shapeArrays = (graph: CFGFunction): number => shapeArrayAllocations(graph, inferred(graph));

const modelOf = (graph: CFGFunction, value: CFGInstruction) =>
  arrayModelOf(value, graph, graph.classes!, inferred(graph));

const elementNameOf = (graph: CFGFunction, array: CFGInstruction) =>
  arrayElementNameOf(array, graph, graph.classes!, inferred(graph));

const elementNamingOf = (graph: CFGFunction, array: CFGInstruction) =>
  arrayElementNamingOf(array, graph, graph.classes!, inferred(graph));

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

  it("keeps an element that admits an absence apart from the one that does not", () => {
    const classes = table();
    const plain = classes.defineArray(nominalLatticeType("int", classes))!;
    const maybe = classes.defineArray(nominalLatticeType("int | null", classes))!;

    expect(maybe.id).not.toBe(plain.id);
  });

  it("lays a nullable numeric element out as a double, leaving the plain one an int", () => {
    const classes = table();
    const plain = classes.defineArray(nominalLatticeType("int", classes))!;
    const maybe = classes.defineArray(nominalLatticeType("int | null", classes))!;

    expect(classes.arrayLayoutOf(maybe)?.element).toBe(SCALAR_FLOAT64);
    expect(classes.arrayLayoutOf(plain)?.element).toBe(SCALAR_INT32);
  });
});

describe("shapeArrayAllocations over a literal that holds an absence", () => {
  function literal(returns: string, held: readonly (number | null)[]) {
    const graph = new CFGFunction("held");
    graph.declaredSignature = { params: [], returns };
    graph.classes = table();
    const block = graph.addBlock();
    const values = held.map((value) => block.addNode(irConstant(value)));
    const array = block.addNode(irNewArray(values));
    block.addNode(irReturn(array));
    graph.rebuildUses();
    return { graph, array };
  }

  const storedAs = (graph: CFGFunction, scalar: AotScalar): number =>
    graph.blocks
      .flatMap((block) => block.nodes)
      .filter((node) => node.props[FIELD_SCALAR_PROP] === scalar).length;

  it("shapes a numeric literal one of whose elements is absent", () => {
    const { graph } = literal("(int | null)[]", [1, null]);

    expect(shapeArrays(graph)).toBe(1);
  });

  it("stores every element as a double, which is what carries the absence", () => {
    const held = [1, null, 3];
    const { graph } = literal("(int | null)[]", held);
    shapeArrays(graph);

    expect(storedAs(graph, SCALAR_FLOAT64)).toBe(held.length);
  });

  it("leaves a literal of plain ints packed as ints", () => {
    const { graph } = literal("int[]", [1, 2]);

    expect(shapeArrays(graph)).toBe(1);
    expect(storedAs(graph, SCALAR_FLOAT64)).toBe(0);
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

  it("shapes both the inner and the outer allocation", () => {
    const { graph } = nestedLiteral();

    expect(shapeArrays(graph)).toBe(2);
  });

  it("replaces every array literal with a shaped allocation", () => {
    const { graph } = nestedLiteral();
    shapeArrays(graph);

    const remaining = graph.blocks
      .flatMap((block) => block.nodes)
      .filter((node) => node.type === IR_NEW_ARRAY);
    expect(remaining).toEqual([]);
  });

  it("stores the inner elements as ints and the outer element as an int array", () => {
    const { graph } = nestedLiteral();
    shapeArrays(graph);

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

  it("shapes the array holding records that name their field differently", () => {
    const { graph } = mixedRecords();

    expect(shapeArrays(graph)).toBe(1);
  });

  it("moves both records onto one shape so the array holds a single layout", () => {
    const { graph, records } = mixedRecords();
    shapeArrays(graph);

    const adopted = new Set(records.map((record) => record.props[VALUE_CLASS_PROP]));
    expect(adopted.size).toBe(1);
  });

  it("adopts the widened shape rather than either record's own", () => {
    const { graph, records } = mixedRecords();
    shapeArrays(graph);

    const adopted = graph.classes!.shapeById(records[0]!.props[VALUE_CLASS_PROP] as number)!;
    expect(adopted.fields.get("h")?.declaredType).toBe("float");
  });

  it("keeps each record's instance size in step with the shape it adopted", () => {
    const { graph, records } = mixedRecords();
    shapeArrays(graph);

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

  const nameOf = (graph: CFGFunction, call: CFGInstruction) =>
    producedTypeName(call, graph, graph.classes!, inferred(graph));

  for (const member of ["pop", "shift"]) {
    it(`names what ${member} takes off by the receiver's element`, () => {
      const { graph, call } = answering(member);

      expect(nameOf(graph, call)).toBe("int");
    });
  }

  it("names a member that answers something other than an element by its own answer", () => {
    const { graph, call } = answering("join");

    expect(nameOf(graph, call)).toBe("string");
  });

  it("models an array a builtin answers on a receiver that is not one", () => {
    const graph = new CFGFunction("parts");
    graph.declaredSignature = { params: ["string"], returns: null };
    graph.classes = table();
    const line = graph.addParameter(0);
    const block = graph.addBlock();
    const callee = block.addNode(irGenericGetProp(line, "split"));
    const call = block.addNode(irGenericCall(callee, [line, block.addNode(irConstant(" "))]));
    call.props.isMethod = true;
    block.addNode(irReturn(call));
    graph.rebuildUses();

    expect(modelOf(graph, call)?.declaredType).toBe("string");
  });
});

describe("arrayModelOf over arrays joined at a control-flow merge", () => {
  function allocated(graph: CFGFunction, block: CFGBlock, declared: string): CFGInstruction {
    const model = arrayModelForDeclaredType(declared, graph.classes!)!;
    const allocation = block.addNode(irNewObject());
    allocation.props[CLASS_ID_PROP] = model.shape.id;
    allocation.props[INSTANCE_SIZE_PROP] = model.shape.size;
    allocation.props[VALUE_CLASS_PROP] = model.shape.id;
    return allocation;
  }

  function joining(left: string, right: string): { graph: CFGFunction; merged: CFGInstruction } {
    const graph = new CFGFunction("merge");
    graph.classes = table();
    const entry = graph.addBlock();
    const taken = graph.addBlock();
    const untaken = graph.addBlock();
    const join = graph.addBlock();
    entry.addNode(irBranch(entry.addNode(irConstant(true)), taken, untaken));
    link(entry, taken);
    link(entry, untaken);
    const first = allocated(graph, taken, left);
    taken.addNode(irJump(join));
    link(taken, join);
    const second = allocated(graph, untaken, right);
    untaken.addNode(irJump(join));
    link(untaken, join);
    const merged = addPhi(join, [first, second]);
    join.addNode(irReturn(merged));
    graph.rebuildUses();
    return { graph, merged };
  }

  function carriedAroundALoop(): { graph: CFGFunction; merged: CFGInstruction } {
    const graph = new CFGFunction("carry");
    graph.classes = table();
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const latch = graph.addBlock();
    const exit = graph.addBlock();
    const seed = allocated(graph, entry, "int[]");
    entry.addNode(irJump(header));
    link(entry, header);
    const merged = addPhi(header, [seed]);
    header.addNode(irBranch(header.addNode(irConstant(true)), latch, exit));
    link(header, latch);
    link(header, exit);
    latch.addNode(irJump(header));
    link(latch, header);
    merged.addInput(merged);
    exit.addNode(irReturn(merged));
    graph.rebuildUses();
    return { graph, merged };
  }

  it("carries the element through a merge whose arms allocate the same array", () => {
    const { graph, merged } = joining("int[]", "int[]");

    expect(modelOf(graph, merged)?.declaredType).toBe("int");
  });

  it("answers nothing for a merge whose arms hold elements that disagree", () => {
    const { graph, merged } = joining("int[]", "float[]");

    expect(modelOf(graph, merged)).toBeNull();
  });

  it("answers the seeded arm rather than recursing on a phi that feeds itself", () => {
    const { graph, merged } = carriedAroundALoop();

    expect(modelOf(graph, merged)?.declaredType).toBe("int");
  });
});

describe("naming what an array holds when a contributor cannot be named", () => {
  function pushingWhatACallAnswers(): { graph: CFGFunction; array: CFGInstruction } {
    const graph = new CFGFunction("collect");
    graph.declaredSignature = { params: ["Map"], returns: null };
    graph.classes = table();
    const held = graph.addParameter(0);
    const block = graph.addBlock();
    const seed = block.addNode(irConstant("a"));
    const array = block.addNode(irNewArray([seed]));
    const answered = block.addNode(
      irGenericCall(block.addNode(irGenericGetProp(held, "get")), [held, seed]),
    );
    answered.props.isMethod = true;
    const push = block.addNode(
      irGenericCall(block.addNode(irGenericGetProp(array, "push")), [array, answered]),
    );
    push.props.isMethod = true;
    block.addNode(irReturn(array));
    graph.rebuildUses();
    return { graph, array };
  }

  it("lets the contributors it can name decide the element type", () => {
    const { graph, array } = pushingWhatACallAnswers();

    expect(elementNameOf(graph, array)).toBe("string");
  });

  function fillingItselfFromItself(seeded: boolean): {
    graph: CFGFunction;
    array: CFGInstruction;
  } {
    const graph = new CFGFunction("shuffle");
    graph.classes = table();
    const block = graph.addBlock();
    const zero = block.addNode(irConstant(0));
    const array = block.addNode(
      irNewArray(seeded ? [block.addNode(irConstant(1))] : []),
    );
    const read = block.addNode(irGenericGetIndex(array, zero));
    const push = block.addNode(
      irGenericCall(block.addNode(irGenericGetProp(array, "push")), [array, read]),
    );
    push.props.isMethod = true;
    block.addNode(irGenericSetIndex(array, zero, read));
    block.addNode(irReturn(array));
    graph.rebuildUses();
    return { graph, array };
  }

  it("answers rather than recursing when an array is filled from itself", () => {
    const { graph, array } = fillingItselfFromItself(true);

    expect(elementNameOf(graph, array)).toBe("int");
  });

  it("answers rather than recursing when nothing else names the element", () => {
    const { graph, array } = fillingItselfFromItself(false);

    expect(() => elementNameOf(graph, array)).not.toThrow();
  });
});

describe("naming what an array literal holds", () => {
  type Held = number | string;

  function literal(values: readonly (Held | Held[])[]): {
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

  it("names the element of a flat literal", () => {
    const { graph, array } = literal([1, 2]);

    expect(elementNameOf(graph, array)).toBe("int");
  });

  it("names a nested literal's element by the array its rows are", () => {
    const { graph, array } = literal([[1], [2]]);

    expect(elementNameOf(graph, array)).toBe("int[]");
  });

  it("names a nested literal of text by the text array its rows are", () => {
    const { graph, array } = literal([["a"], ["b"]]);

    expect(elementNameOf(graph, array)).toBe("string[]");
  });

  it("answers nothing for a nested literal whose rows hold different things", () => {
    const { graph, array } = literal([[1], ["a"]]);

    expect(elementNameOf(graph, array)).toBeNull();
  });

  it("leaves an element read unstamped while its element has no name", () => {
    const { graph, array } = literal([[1], ["a"]]);
    const block = graph.blocks[0]!;
    const read = block.addNode(irGenericGetIndex(array, block.addNode(irConstant(0))));
    graph.rebuildUses();

    stampElementTypes(graph, inferred(graph));

    expect(read.props[FIELD_TYPE_PROP]).toBeUndefined();
  });

  it("stamps an element read on a nested literal with the row's array type", () => {
    const { graph, array } = literal([[1], [2]]);
    const block = graph.blocks[0]!;
    const read = block.addNode(irGenericGetIndex(array, block.addNode(irConstant(0))));
    graph.rebuildUses();

    stampElementTypes(graph, inferred(graph));

    expect(read.props[FIELD_TYPE_PROP]).toBe("int[]");
  });

  it("stamps an element read once its element can be named", () => {
    const { graph, array } = literal([1, 2]);
    const block = graph.blocks[0]!;
    const read = block.addNode(irGenericGetIndex(array, block.addNode(irConstant(0))));
    graph.rebuildUses();

    stampElementTypes(graph, inferred(graph));

    expect(read.props[FIELD_TYPE_PROP]).toBe("int");
  });

  it("says it knows the element it read off what the literal holds", () => {
    const { graph, array } = literal([1, 2]);

    expect(elementNamingOf(graph, array)).toEqual({ held: "int", guessed: false });
  });

  it("says it only guessed the element of a literal that holds nothing", () => {
    const { graph, array } = literal([]);

    expect(elementNamingOf(graph, array)).toEqual({ held: "float", guessed: true });
  });

  it("hands the same name out either way to callers that want only the name", () => {
    for (const values of [[1, 2], []]) {
      const { graph, array } = literal(values);

      expect(elementNameOf(graph, array)).toBe(elementNamingOf(graph, array)?.held);
    }
  });
});
