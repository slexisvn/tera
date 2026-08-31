import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
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

beforeEach(() => resetIRNodeIds());

const GLOBAL = "items";

function pushInto(block: CFGFunction["blocks"][number], held: CFGInstruction, value: CFGInstruction) {
  const push = block.addNode(irGenericGetProp(held, "push"));
  const call = irGenericCall(push, [held, value]);
  call.props.isMethod = true;
  block.addNode(call);
}

function moduleHolding(fill: (block: CFGFunction["blocks"][number], held: CFGInstruction) => void) {
  const graph = new CFGFunction("main");
  graph.declaredSignature = { params: [], returns: "int" };
  const block = graph.addBlock();
  block.addNode(irStoreGlobal(GLOBAL, block.addNode(irNewArray([]))));
  fill(block, block.addNode(irLoadGlobal(GLOBAL)));
  block.addNode(irReturn(block.addNode(irConstant(0))));
  graph.rebuildUses();
  return moduleFromGraphs([graph]);
}

function declaredTypeOfGlobal(
  fill: (block: CFGFunction["blocks"][number], held: CFGInstruction) => void,
): string | null {
  const classes = buildClassTable([]);
  declareGlobalVariables(moduleHolding(fill), classes);
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
      block.addNode(
        irGenericSetIndex(held, block.addNode(irConstant(0)), block.addNode(irConstant(7))),
      );
    });

    expect(declared).toBe("int[]");
  });

  it("takes no element type when the program fills the array with two types", () => {
    const declared = declaredTypeOfGlobal((block, held) => {
      pushInto(block, held, block.addNode(irConstant("a")));
      pushInto(block, held, block.addNode(irConstant(7)));
    });

    expect(declared).not.toBe("string[]");
    expect(declared).not.toBe("int[]");
  });

  it("agrees when the same element type is pushed from two places", () => {
    const declared = declaredTypeOfGlobal((block, held) => {
      pushInto(block, held, block.addNode(irConstant("a")));
      pushInto(block, held, block.addNode(irConstant("b")));
    });

    expect(declared).toBe("string[]");
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
});
