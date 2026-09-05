import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericAdd,
  irGenericCall,
  irGenericGetIndex,
  irGenericGetProp,
  irGenericSetIndex,
  irLoadGlobal,
  irNewArray,
  irReturn,
  irStoreGlobal,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import { declareGlobalVariables } from "../../../src/optimizing/metadata/global-variables.js";
import { carryModuleSignatures } from "../../../src/optimizing/metadata/call-signatures.js";
import { DECLARED_TYPE_PROP } from "../../../src/optimizing/passes/global-promotion.js";

beforeEach(() => resetIRNodeIds());

const GLOBAL = "items";

type Block = CFGFunction["blocks"][number];
type Fill = (block: Block, held: CFGInstruction) => void;

function pushInto(block: Block, held: CFGInstruction, value: CFGInstruction) {
  const push = block.addNode(irGenericGetProp(held, "push"));
  const call = irGenericCall(push, [held, value]);
  call.props.isMethod = true;
  block.addNode(call);
}

function storeAt(block: Block, held: CFGInstruction, at: number, value: CFGInstruction) {
  block.addNode(irGenericSetIndex(held, block.addNode(irConstant(at)), value));
}

function moduleHolding(
  fill: Fill,
  elements: readonly number[] = [],
  annotation: string | null = null,
) {
  const graph = new CFGFunction("main");
  graph.declaredSignature = { params: [], returns: "int" };
  const block = graph.addBlock();
  const literal = irNewArray(elements.map((value) => block.addNode(irConstant(value))));
  const store = irStoreGlobal(GLOBAL, block.addNode(literal));
  if (annotation !== null) store.props[DECLARED_TYPE_PROP] = annotation;
  block.addNode(store);
  fill(block, block.addNode(irLoadGlobal(GLOBAL)));
  block.addNode(irReturn(block.addNode(irConstant(0))));
  graph.rebuildUses();
  return moduleFromGraphs([graph]);
}

function declaredTypeOfGlobal(
  fill: Fill,
  elements: readonly number[] = [],
  annotation: string | null = null,
): string | null {
  const classes = buildClassTable([]);
  declareGlobalVariables(moduleHolding(fill, elements, annotation), classes);
  return classes.globalOf(GLOBAL)?.declaredType ?? null;
}

function declaredTypeOfScalarGlobal(held: number, annotation: string | null): string | null {
  const graph = new CFGFunction("main");
  graph.declaredSignature = { params: [], returns: "int" };
  const block = graph.addBlock();
  const store = irStoreGlobal(GLOBAL, block.addNode(irConstant(held)));
  if (annotation !== null) store.props[DECLARED_TYPE_PROP] = annotation;
  block.addNode(store);
  block.addNode(irReturn(block.addNode(irConstant(0))));
  graph.rebuildUses();
  const classes = buildClassTable([]);
  declareGlobalVariables(moduleFromGraphs([graph]), classes);
  return classes.globalOf(GLOBAL)?.declaredType ?? null;
}

describe("declareGlobalVariables element types", () => {
  it("takes a module array's element type from what the program pushes into it", () => {
    const declared = declaredTypeOfGlobal((block, held) => {
      pushInto(block, held, block.addNode(irConstant("a")));
    });

    expect(declared).toBe("string[]");
  });

  it("takes a module array's element type from what the program stores at an index", () => {
    const declared = declaredTypeOfGlobal((block, held) => {
      storeAt(block, held, 0, block.addNode(irConstant(7)));
    });

    expect(declared).toBe("int[]");
  });

  it("declares nothing when the program fills the array with two unrelated types", () => {
    const declared = declaredTypeOfGlobal((block, held) => {
      pushInto(block, held, block.addNode(irConstant("a")));
      pushInto(block, held, block.addNode(irConstant(7)));
    });

    expect(declared).toBeNull();
  });

  it("agrees when the same element type is pushed from two places", () => {
    const declared = declaredTypeOfGlobal((block, held) => {
      pushInto(block, held, block.addNode(irConstant("a")));
      pushInto(block, held, block.addNode(irConstant("b")));
    });

    expect(declared).toBe("string[]");
  });

  it("widens a whole-number initialiser to hold the fractions the program stores", () => {
    const declared = declaredTypeOfGlobal(
      (block, held) => {
        storeAt(block, held, 0, block.addNode(irConstant(0.5)));
      },
      [0, 0],
    );

    expect(declared).toBe("float[]");
  });

  it("keeps a fractional initialiser when the program stores whole numbers into it", () => {
    const declared = declaredTypeOfGlobal(
      (block, held) => {
        storeAt(block, held, 0, block.addNode(irConstant(3)));
      },
      [1.5, 2.5],
    );

    expect(declared).toBe("float[]");
  });

  it("keeps the element types it can name when another store's type is unknown", () => {
    const declared = declaredTypeOfGlobal(
      (block, held) => {
        storeAt(block, held, 0, block.addNode(irConstant(0.5)));
        const read = block.addNode(irGenericGetIndex(held, block.addNode(irConstant(0))));
        storeAt(block, held, 1, block.addNode(irGenericAdd(read, block.addNode(irConstant(1)))));
      },
      [0, 0],
    );

    expect(declared).toBe("float[]");
  });

  it("reads every unit of the module once, whatever the store order", () => {
    const filler = new CFGFunction("fill");
    filler.declaredSignature = { params: [], returns: "int" };
    const fillBlock = filler.addBlock();
    pushInto(fillBlock, fillBlock.addNode(irLoadGlobal(GLOBAL)), fillBlock.addNode(irConstant("a")));
    fillBlock.addNode(irReturn(fillBlock.addNode(irConstant(0))));
    filler.rebuildUses();

    const holder = new CFGFunction("main");
    holder.declaredSignature = { params: [], returns: "int" };
    const block = holder.addBlock();
    block.addNode(irStoreGlobal(GLOBAL, block.addNode(irNewArray([]))));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    holder.rebuildUses();

    const classes = buildClassTable([]);
    declareGlobalVariables(moduleFromGraphs([holder, filler]), classes);

    expect(classes.globalOf(GLOBAL)?.declaredType).toBe("string[]");
  });

  it("keeps the element type the callee declared for the array the module was given", () => {
    const maker = new CFGFunction("makeFloats");
    maker.declaredSignature = { params: [], returns: "float[]" };
    const makerBlock = maker.addBlock();
    const made = irNewArray([makerBlock.addNode(irConstant(0.5))]);
    makerBlock.addNode(irReturn(makerBlock.addNode(made)));
    maker.rebuildUses();

    const holder = new CFGFunction("main");
    holder.declaredSignature = { params: [], returns: "int" };
    const block = holder.addBlock();
    const answered = block.addNode(irGenericCall(block.addNode(irLoadGlobal("makeFloats")), []));
    block.addNode(irStoreGlobal(GLOBAL, answered));
    storeAt(block, block.addNode(irLoadGlobal(GLOBAL)), 0, block.addNode(irConstant(3)));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    holder.rebuildUses();

    const module = moduleFromGraphs([holder, maker]);
    carryModuleSignatures(module);
    const classes = buildClassTable([]);
    declareGlobalVariables(module, classes);

    expect(classes.globalOf(GLOBAL)?.declaredType).toBe("float[]");
  });

  it("does not let the element type it defaulted to outvote what another unit stores", () => {
    const filler = new CFGFunction("fill");
    filler.declaredSignature = { params: [], returns: "int" };
    const fillBlock = filler.addBlock();
    storeAt(fillBlock, fillBlock.addNode(irLoadGlobal(GLOBAL)), 0, fillBlock.addNode(irConstant(3)));
    fillBlock.addNode(irReturn(fillBlock.addNode(irConstant(0))));
    filler.rebuildUses();

    const holder = new CFGFunction("main");
    holder.declaredSignature = { params: [], returns: "int" };
    const block = holder.addBlock();
    block.addNode(irStoreGlobal(GLOBAL, block.addNode(irNewArray([]))));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    holder.rebuildUses();

    const classes = buildClassTable([]);
    declareGlobalVariables(moduleFromGraphs([holder, filler]), classes);

    expect(classes.globalOf(GLOBAL)?.declaredType).toBe("int[]");
  });

  it("takes the element type a callee declares for the array it is handed", () => {
    const callee = new CFGFunction("fill");
    callee.declaredSignature = { params: ["float[]"], returns: "int" };
    const calleeBlock = callee.addBlock();
    calleeBlock.addNode(irReturn(calleeBlock.addNode(irConstant(0))));
    callee.rebuildUses();

    const holder = new CFGFunction("main");
    holder.declaredSignature = { params: [], returns: "int" };
    const block = holder.addBlock();
    const literal = irNewArray([block.addNode(irConstant(0)), block.addNode(irConstant(0))]);
    block.addNode(irStoreGlobal(GLOBAL, block.addNode(literal)));
    block.addNode(
      irGenericCall(block.addNode(irLoadGlobal("fill")), [block.addNode(irLoadGlobal(GLOBAL))]),
    );
    block.addNode(irReturn(block.addNode(irConstant(0))));
    holder.rebuildUses();

    const classes = buildClassTable([]);
    declareGlobalVariables(moduleFromGraphs([holder, callee]), classes);

    expect(classes.globalOf(GLOBAL)?.declaredType).toBe("float[]");
  });
});

describe("declareGlobalVariables and the type a module variable was declared with", () => {
  it("takes a module array's element type from the annotation, not the initialiser", () => {
    const declared = declaredTypeOfGlobal(() => {}, [0, 0], "float[]");

    expect(declared).toBe("float[]");
  });

  it("keeps the annotation when the program only ever stores narrower elements", () => {
    const declared = declaredTypeOfGlobal(
      (block, held) => {
        storeAt(block, held, 0, block.addNode(irConstant(3)));
      },
      [0, 0],
      "float[]",
    );

    expect(declared).toBe("float[]");
  });

  it("ignores an annotation too narrow to hold what the program stores", () => {
    const declared = declaredTypeOfGlobal(
      (block, held) => {
        storeAt(block, held, 0, block.addNode(irConstant(0.5)));
      },
      [0, 0],
      "int[]",
    );

    expect(declared).toBe("float[]");
  });

  it("ignores an annotation naming another kind of element entirely", () => {
    const declared = declaredTypeOfGlobal(
      (block, held) => {
        pushInto(block, held, block.addNode(irConstant("a")));
      },
      [],
      "float[]",
    );

    expect(declared).toBe("string[]");
  });

  it("takes a plain module variable's type from the annotation", () => {
    expect(declaredTypeOfScalarGlobal(0, "float")).toBe("float");
    expect(declaredTypeOfScalarGlobal(0, null)).toBe("int");
  });

  it("ignores a plain variable's annotation when it cannot hold what it is given", () => {
    expect(declaredTypeOfScalarGlobal(0.5, "int")).toBe("float");
  });
});
